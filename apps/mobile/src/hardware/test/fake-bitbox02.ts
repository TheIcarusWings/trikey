/**
 * A BitBox02 for tests: a `BitBoxLink` whose device speaks the BitBox02's protocol the way its firmware does at b27f5f68
 * (`src/hww.c`, `src/rust/bitbox02-rust/src/hww.rs`, `hww/noise.rs`, `hww/api/bitcoin*.rs`, `bitbox-secp256k1`). It is
 * written from the firmware, apart from the app's BitBox02 code where it matters, so each checks the other:
 *
 * - the HWW layer answers NOT_READY while "the owner" decides on the device, and the phone must poll with RETRY;
 * - the Noise responder skips the pairing code over Bluetooth (the Nova's own six-digit pairing) and when it knows the
 *   phone, and shows it otherwise;
 * - signing a payment asks for every input, every previous transaction (hashed and checked against the outpoint, its
 *   output against the input's value and script), every output, then every input again; the BIP 143 sighash is computed
 *   here from what the phone sent (not from the PSBT), and each signature uses the anti-klepto nonce when the phone
 *   commits to one (s2c.ts, the firmware's formula);
 * - messages: P2WPKH config only, `m/48'` keypaths accepted from 9.27.1, deterministic without a commitment.
 *
 * It shares only the wire codecs with the app (framing.ts, proto.ts, noise.ts), which have their own tests against the
 * firmware's vectors. `tamper` makes it misbehave in the ways the phone must catch.
 */
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secureRandomBytes } from '@trikey/core/random';
import { NETWORKS, getNetwork, type NetworkName } from '@trikey/core';
import { HARDENED } from '../common/path';
import { encodeXpub } from '../common/xpub';
import { REPORT_SIZE, ReportReader, encodeReports } from '../bitbox02/framing';
import type { BitBoxConnection, BitBoxDevice, BitBoxLink, BitBoxTransport } from '../bitbox02/link';
import { NoiseXX, noisePublicKey, type NoiseResult } from '../bitbox02/noise';
import { ProtoMessage, ProtoWriter } from '../bitbox02/proto';
import { pairingCode } from '../bitbox02/session';
import { messageHash, s2cCommit, s2cSign } from './s2c';

export type FakeTamper =
  /** Signs payments over another sighash (the anti-klepto check passes; the phone's signature check must not). */
  | 'tx-signature'
  /** Ignores the phone's anti-klepto nonce when signing (payments and texts). */
  | 'antiklepto'
  /** Leaves one input unsigned. */
  | 'skip-input'
  /** Signs a different text from the one sent. */
  | 'message-text'
  /** Signs texts with the key of another path. */
  | 'message-key'
  /** Shows and returns another address. */
  | 'address'
  /** Returns the xpub of another account. */
  | 'xpub-path'
  /** Flips a bit of every encrypted answer. */
  | 'ciphertext';

export interface FakeBitBoxOptions {
  mnemonic: string;
  network?: NetworkName;
  version?: string;
  platform?: 'bitbox02' | 'bitbox02-nova';
  transport?: BitBoxTransport;
  /** Starts unlocked (no password asked). */
  unlocked?: boolean;
  initialized?: boolean;
  /** How many RETRY polls an owner's decision takes (NOT_READY until then). Default 2. */
  polls?: number;
  tamper?: FakeTamper[];
}

type Decision = 'pairing' | 'register' | 'address' | 'payment' | 'message' | 'unlock' | 'xpub';

interface Multisig {
  threshold: number;
  xpubs: { depth: number; parentFingerprint: number; childNum: number; chainCode: Uint8Array; publicKey: Uint8Array }[];
  ourIndex: number;
  scriptType: number;
}

interface TxState {
  coin: number;
  config: { multisig: Multisig; keypath: number[] };
  version: number;
  numInputs: number;
  numOutputs: number;
  locktime: number;
  inputs: { prevOutHash: Uint8Array; prevOutIndex: number; prevOutValue: number; sequence: number; keypath: number[] }[];
  outputs: { value: number; script: Uint8Array }[];
  prev?: { version: number; numInputs: number; numOutputs: number; locktime: number; inputs: Uint8Array[]; outputs: { value: number; script: Uint8Array }[] };
  pass2: number;
  awaitingNonce?: { index: number; commitment: Uint8Array };
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const sha256d = (b: Uint8Array) => sha256(sha256(b));
const le32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const le64 = (n: number) => {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};
const varint = (n: number) => (n < 0xfd ? new Uint8Array([n]) : new Uint8Array([0xfd, n & 255, n >> 8]));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

class FakeError extends Error {
  constructor(readonly code: number) {
    super(`firmware error ${code}`);
  }
}
const INVALID = () => new FakeError(101);
const ABORT = () => new FakeError(104);

/** `BTCSignNextResponse`. */
function nextMessage(n: { type: number; index?: number; signature?: Uint8Array; prevIndex?: number; commitment?: Uint8Array }): ProtoWriter {
  const w = new ProtoWriter().uint(1, n.type).uint(2, n.index ?? 0);
  if (n.signature) w.uint(3, true).bytes(4, n.signature);
  w.uint(5, n.prevIndex ?? 0);
  if (n.commitment) w.message(6, new ProtoWriter().bytes(1, n.commitment));
  return w;
}

export class FakeBitBox02 {
  readonly network: NetworkName;
  readonly root: HDKey;
  readonly fingerprint: string;
  readonly coinType: number;
  version: string;
  platform: 'bitbox02' | 'bitbox02-nova';
  transport: BitBoxTransport;
  unlocked: boolean;
  initialized: boolean;
  polls: number;
  tamper: Set<FakeTamper>;
  /** The owner in front of the device: what they approve. */
  owner: Record<Decision, boolean> = { pairing: true, register: true, address: true, payment: true, message: true, unlock: true, xpub: true };

  /** The device's Noise key (kept across connections, as on a real BitBox02). */
  readonly staticKey = secureRandomBytes(32);
  /** The phones it paired with (their Noise static keys). */
  readonly pairedApps: Uint8Array[] = [];
  readonly registered = new Map<string, string>();
  /** The API requests, by name, in order. */
  readonly requests: string[] = [];
  /** What its screen showed, in order. */
  readonly screens: { title: string; body: string }[] = [];
  readonly pairingCodes: string[] = [];
  readonly signedTexts: string[] = [];
  /** For each signed text: was anti-klepto used. */
  readonly textsWithAntiKlepto: boolean[] = [];
  readonly signedPayments: { inputs: number; outputs: { value: number; script: string }[] }[] = [];
  connects = 0;
  conn?: FakeConnection;

  private noise?: NoiseXX;
  private noiseStep = 0;
  private channel?: NoiseResult & { verified: boolean };
  private pending?: { remaining: number; response: Uint8Array };
  private tx?: TxState;
  private msgSign?: { key: Uint8Array; z: Uint8Array; commitment: Uint8Array; text: string };

  constructor(opts: FakeBitBoxOptions) {
    this.network = opts.network ?? 'regtest';
    this.root = HDKey.fromMasterSeed(mnemonicToSeedSync(opts.mnemonic), getNetwork(this.network).bip32);
    this.fingerprint = this.root.fingerprint.toString(16).padStart(8, '0');
    this.coinType = this.network === 'bitcoin' ? 0 : 1;
    this.version = opts.version ?? '9.27.1';
    this.platform = opts.platform ?? 'bitbox02';
    this.transport = opts.transport ?? 'usb';
    this.unlocked = opts.unlocked ?? false;
    this.initialized = opts.initialized ?? true;
    this.polls = opts.polls ?? 2;
    this.tamper = new Set(opts.tamper ?? []);
  }

  get noiseStatic(): Uint8Array {
    return noisePublicKey(this.staticKey);
  }

  /** Unplugged and plugged in again (or the Nova turned off and on): locked, no session. */
  replug(): void {
    this.unlocked = false;
    this.channel = undefined;
    this.noise = undefined;
    this.pending = undefined;
    this.tx = undefined;
  }

  link(): BitBoxLink & { supported: boolean; present: boolean } {
    const device: BitBoxDevice = { id: 'bb02-1', name: this.platform === 'bitbox02-nova' ? 'BitBox02 Nova' : 'BitBox02', transport: this.transport };
    const self = this;
    const link = {
      transport: this.transport,
      supported: true,
      present: true,
      isSupported: async () => link.supported,
      prepare: async () => undefined,
      scan: (onFound: (d: BitBoxDevice) => boolean, signal: AbortSignal) =>
        new Promise<BitBoxDevice>((resolve, reject) => {
          const abort = () => reject(new Error('scan aborted'));
          if (signal.aborted) return abort();
          signal.addEventListener('abort', abort, { once: true });
          if (link.present && onFound(device)) {
            signal.removeEventListener('abort', abort);
            resolve(device);
          }
        }),
      connect: async () => {
        self.connects++;
        // A new connection over USB starts a new session; the BitBox02 stays unlocked while powered.
        self.channel = undefined;
        self.noise = undefined;
        self.pending = undefined;
        self.tx = undefined;
        self.conn = new FakeConnection(device, self);
        return self.conn;
      },
    };
    return link;
  }

  // ---- the HWW layer (src/hww.c) ------------------------------------------------------------------------------

  /** One framed message in, one framed message out. */
  frame(msg: Uint8Array): Uint8Array {
    const op = msg[0];
    if (msg.length === 1 && op === 0x69) return this.info();
    if (msg.length === 1 && op === 0x03) {
      if (!this.versionAtLeast(9, 28, 0)) return new Uint8Array([0x03]);
      this.pending = undefined;
      this.channel = undefined;
      this.tx = undefined;
      return new Uint8Array([0x00]);
    }
    if (op === 0x00) {
      if (this.pending) return new Uint8Array([0x02]); // BUSY
      const { response, decisions } = this.payload(msg.slice(1));
      if (decisions === 0) return cat(new Uint8Array([0x00]), response);
      this.pending = { remaining: decisions * this.polls, response };
      return new Uint8Array([0x01]);
    }
    if (msg.length === 1 && op === 0x01) {
      if (!this.pending) return new Uint8Array([0x03]);
      if (this.pending.remaining-- > 0) return new Uint8Array([0x01]);
      const r = this.pending.response;
      this.pending = undefined;
      return cat(new Uint8Array([0x00]), r);
    }
    return new Uint8Array([0x03]);
  }

  private versionAtLeast(a: number, b: number, c: number): boolean {
    const [x, y, z] = this.version.split('.').map(Number) as [number, number, number];
    return x !== a ? x > a : y !== b ? y > b : z >= c;
  }

  private info(): Uint8Array {
    const v = new TextEncoder().encode(`v${this.version}`);
    return cat(new Uint8Array([v.length]), v, new Uint8Array([this.platform === 'bitbox02-nova' ? 2 : 0, 0, this.unlocked ? 1 : 0, this.initialized ? 1 : 0]));
  }

  /** `hww.rs` `process_packet` and `noise.rs` `process`: returns the answer and how many owner decisions it waited for. */
  private payload(p: Uint8Array): { response: Uint8Array; decisions: number } {
    const op = p[0];
    const ok = (bytes: number[] | Uint8Array = [0], decisions = 0) => ({ response: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), decisions });
    if (op === 0x75 && p.length === 1) {
      if (!this.initialized) return ok([2]);
      if (this.unlocked) return ok([0]);
      if (!this.owner.unlock) return ok([1], 1);
      this.unlocked = true;
      return ok([0], 1);
    }
    if (!this.initialized || !this.unlocked) return ok([1]);
    if (op === 0x68 && p.length === 1) {
      this.noise = new NoiseXX(false, this.staticKey);
      this.noiseStep = 0;
      this.channel = undefined;
      return ok([0]);
    }
    if (op === 0x48) {
      if (!this.noise) return ok([1]);
      try {
        this.noise.readMessage(p.slice(1));
        if (this.noiseStep++ === 0) return ok(cat(new Uint8Array([0]), this.noise.writeMessage()));
        const res = this.noise.finish();
        this.noise = undefined;
        const known = this.pairedApps.some((k) => same(k, res.remoteStatic));
        const verified = this.transport === 'ble' || known;
        this.channel = { ...res, verified };
        return ok([0, verified ? 0 : 1]);
      } catch {
        this.noise = undefined;
        return ok([1]);
      }
    }
    if (op === 0x76 && p.length === 1) {
      if (!this.channel) return ok([1]);
      const code = pairingCode(this.channel.hash);
      this.pairingCodes.push(code);
      this.screens.push({ title: 'Pairing code', body: code });
      if (!this.owner.pairing) {
        this.channel = undefined;
        return ok([1], 1);
      }
      this.channel.verified = true;
      if (!this.pairedApps.some((k) => same(k, this.channel!.remoteStatic))) this.pairedApps.push(this.channel.remoteStatic);
      return ok([0], 1);
    }
    if (op === 0x6e) {
      const ch = this.channel;
      if (!ch || !ch.verified) return ok([1]);
      let request: Uint8Array;
      try {
        request = ch.recv.decrypt(new Uint8Array(0), p.slice(1));
      } catch {
        return ok([1]);
      }
      let response: Uint8Array;
      let decisions = 0;
      try {
        const r = this.api(ProtoMessage.parse(request));
        response = r.response.finish();
        decisions = r.decisions;
      } catch (e) {
        const code = e instanceof FakeError ? e.code : 103;
        const messages: Record<number, string> = { 101: 'invalid input', 103: 'generic error', 104: 'aborted by the user', 105: "can't call this endpoint: wrong state" };
        response = new ProtoWriter().message(2, new ProtoWriter().uint(1, code).bytes(2, messages[code] ?? 'error')).finish();
        if (e instanceof FakeError && e.code === 104) decisions = 1;
        if (!(e instanceof FakeError)) this.tx = undefined;
      }
      const ct = ch.send.encrypt(new Uint8Array(0), response);
      if (this.tamper.has('ciphertext')) ct[0]! ^= 1;
      return ok(cat(new Uint8Array([0]), ct), decisions);
    }
    return ok([1]);
  }

  // ---- the API (hww/api) --------------------------------------------------------------------------------------

  private api(req: ProtoMessage): { response: ProtoWriter; decisions: number } {
    const field = req.which([4, 8, 9, 10, 11, 24, 25]);
    const top = (no: number, inner: ProtoWriter, decisions = 0) => ({ response: new ProtoWriter().message(no, inner), decisions });
    const btcResponse = (no: number, inner: ProtoWriter, decisions = 0) => top(13, new ProtoWriter().message(no, inner), decisions);
    switch (field) {
      case 24: {
        this.requests.push('fingerprint');
        const fp = new Uint8Array(4);
        new DataView(fp.buffer).setUint32(0, this.root.fingerprint, false);
        return top(12, new ProtoWriter().bytes(1, fp));
      }
      case 8:
        return this.pub(req.message(8)!);
      case 9:
        this.requests.push('btc_sign_init');
        return top(6, this.signInit(req.message(9)!));
      case 10: {
        this.requests.push('btc_sign_input');
        const r = this.signInput(req.message(10)!);
        return top(6, r.next, r.decisions);
      }
      case 11: {
        this.requests.push('btc_sign_output');
        const r = this.signOutput(req.message(11)!);
        return top(6, r.next, r.decisions);
      }
      case 25: {
        const b = req.message(25)!;
        switch (b.which([1, 2, 3, 4, 5, 6, 7])) {
          case 1: {
            this.requests.push('is_script_config_registered');
            const reg = this.registration(b.message(1)!.message(1)!);
            return btcResponse(2, new ProtoWriter().uint(1, this.registered.has(reg.hash)));
          }
          case 2: {
            this.requests.push('register_script_config');
            const r = b.message(2)!;
            const reg = this.registration(r.message(1)!);
            const name = r.string(2);
            if (!name || name.length > 30 || name !== name.trim()) throw INVALID();
            this.screens.push({ title: 'Register', body: `${name}\n${reg.multisig.threshold}-of-${reg.multisig.xpubs.length}` });
            if (!this.owner.register) throw ABORT();
            this.registered.set(reg.hash, name);
            return btcResponse(1, new ProtoWriter(), 1);
          }
          case 3:
            this.requests.push('prevtx_init');
            return btcResponse(3, this.prevtxInit(b.message(3)!));
          case 4:
            this.requests.push('prevtx_input');
            return btcResponse(3, this.prevtxInput(b.message(4)!));
          case 5:
            this.requests.push('prevtx_output');
            return btcResponse(3, this.prevtxOutput(b.message(5)!));
          case 6: {
            this.requests.push('sign_message');
            const r = this.signMessage(b.message(6)!);
            return r.commitment ? btcResponse(5, new ProtoWriter().bytes(1, r.commitment), 1) : btcResponse(4, new ProtoWriter().bytes(1, r.signature!), 1);
          }
          case 7: {
            this.requests.push('antiklepto_signature');
            const nonce = b.message(7)!.bytes(1);
            if (nonce.length !== 32) throw INVALID();
            if (this.msgSign) {
              const m = this.msgSign;
              this.msgSign = undefined;
              const sig = s2cSign(m.key, m.z, this.tamper.has('antiklepto') ? new Uint8Array(32) : nonce);
              this.signedTexts.push(m.text);
              this.textsWithAntiKlepto.push(true);
              return btcResponse(4, new ProtoWriter().bytes(1, new Uint8Array([...sig.signature, sig.recid])));
            }
            return btcResponse(3, this.antikleptoTx(nonce));
          }
          default:
            throw INVALID();
        }
      }
      default:
        throw INVALID();
    }
  }

  private xpubAt(keypath: number[]): HDKey {
    return this.root.derive(`m/${keypath.map((n) => (n >= HARDENED ? `${n - HARDENED}'` : String(n))).join('/')}`);
  }

  private coinOk(coin: number): void {
    const want = this.network === 'bitcoin' ? 0 : this.network === 'regtest' ? 4 : 1;
    if (coin !== want) throw INVALID();
  }

  private multisigOf(cfg: ProtoMessage, keypath: number[]): Multisig {
    const ms = cfg.message(2);
    if (!ms) throw INVALID();
    const m: Multisig = {
      threshold: ms.uint(1),
      xpubs: ms.repeatedBytes(2).map((b) => {
        const x = ProtoMessage.parse(b);
        const depth = x.bytes(1);
        if (depth.length !== 1) throw INVALID();
        return { depth: depth[0]!, parentFingerprint: new DataView(x.bytes(2).buffer, x.bytes(2).byteOffset).getUint32(0, false), childNum: x.uint(3), chainCode: x.bytes(4), publicKey: x.bytes(5) };
      }),
      ourIndex: ms.uint(3),
      scriptType: ms.uint(4),
    };
    // multisig.rs `validate`: threshold, our key at our index, the keypath m/48'/coin'/account'/2' (P2WSH).
    if (m.scriptType !== 0 || m.threshold < 1 || m.threshold > m.xpubs.length || m.ourIndex >= m.xpubs.length) throw INVALID();
    if (keypath.length !== 4 || keypath[0] !== 48 + HARDENED || keypath[1] !== this.coinType + HARDENED || keypath[2]! < HARDENED || keypath[3] !== 2 + HARDENED) throw INVALID();
    const ours = this.xpubAt(keypath);
    const x = m.xpubs[m.ourIndex]!;
    if (!same(x.publicKey, ours.publicKey!) || !same(x.chainCode, ours.chainCode!)) throw INVALID();
    return m;
  }

  private registration(reg: ProtoMessage): { hash: string; multisig: Multisig; keypath: number[] } {
    this.coinOk(reg.uint(1));
    const keypath = reg.repeatedUint(3);
    const multisig = this.multisigOf(reg.message(2)!, keypath);
    const sorted = multisig.xpubs.map((x) => `${hexOf(x.chainCode)}${hexOf(x.publicKey)}`).sort();
    return { hash: JSON.stringify([reg.uint(1), multisig.threshold, keypath, sorted]), multisig, keypath };
  }

  private registeredName(coin: number, multisig: Multisig, keypath: number[]): string | undefined {
    const sorted = multisig.xpubs.map((x) => `${hexOf(x.chainCode)}${hexOf(x.publicKey)}`).sort();
    return this.registered.get(JSON.stringify([coin, multisig.threshold, keypath, sorted]));
  }

  /** The P2WSH multisig at (chain, index): BIP 67 sorted keys (`multisig.rs` `pkscript`). */
  private multisigScript(m: Multisig, chain: number, index: number): { witnessScript: Uint8Array; script: Uint8Array; address: string } {
    const keys = m.xpubs.map((x) => {
      const hd = new HDKey({ publicKey: x.publicKey, chainCode: x.chainCode, depth: x.depth, index: x.childNum, parentFingerprint: x.parentFingerprint });
      return hd.deriveChild(chain).deriveChild(index).publicKey!;
    });
    keys.sort((a, b) => (hexOf(a) < hexOf(b) ? -1 : 1));
    const pay = btc.p2wsh(btc.p2ms(m.threshold, keys), NETWORKS[this.network].btc);
    return { witnessScript: pay.witnessScript!, script: pay.script, address: pay.address! };
  }

  private pub(r: ProtoMessage): { response: ProtoWriter; decisions: number } {
    this.coinOk(r.uint(1));
    const keypath = r.repeatedUint(2);
    const display = r.bool(5);
    const out = (pub: string, decisions = 0) => ({ response: new ProtoWriter().message(5, new ProtoWriter().bytes(1, pub)), decisions });
    if (r.has(3)) {
      this.requests.push('btc_pub xpub');
      let path = keypath;
      if (this.tamper.has('xpub-path')) path = [...keypath.slice(0, -1), keypath.at(-1)! - 1];
      const hd = this.xpubAt(path);
      const version = r.uint(3) === 1 ? 0x0488b21e : 0x043587cf;
      const xpub = encodeXpub({ version, depth: hd.depth, parentFingerprint: hd.parentFingerprint, childNumber: hd.index, chainCode: hd.chainCode!, key: hd.publicKey! });
      if (display) {
        this.screens.push({ title: 'xpub', body: xpub });
        if (!this.owner.xpub) throw ABORT();
        return out(xpub, 1);
      }
      return out(xpub);
    }
    this.requests.push('btc_pub address');
    const cfg = r.message(4)!;
    const account = keypath.slice(0, -2);
    const multisig = this.multisigOf(cfg, account);
    const name = this.registeredName(r.uint(1), multisig, account);
    if (!name) throw INVALID();
    const [chain, index] = keypath.slice(-2) as [number, number];
    if (chain > 1 || index > 10_000) throw INVALID();
    let address = this.multisigScript(multisig, chain, index).address;
    if (this.tamper.has('address')) address = this.multisigScript(multisig, chain, index + 1).address;
    if (!display) return out(address);
    this.screens.push({ title: 'Receive to', body: `${name}\n${address}` });
    if (!this.owner.address) throw ABORT();
    return out(address, 1);
  }

  private signMessage(r: ProtoMessage): { commitment?: Uint8Array; signature?: Uint8Array } {
    const coin = r.uint(1);
    if (![0, 1, 4].includes(coin)) throw INVALID();
    this.coinOk(coin);
    const cwk = r.message(2);
    const cfg = cwk?.message(2);
    // signmsg.rs: a simple type, not P2TR.
    if (!cfg || !cfg.has(1) || cfg.uint(1) === 2) throw INVALID();
    const keypath = cwk!.repeatedUint(3);
    const msg = r.bytes(3);
    if (msg.length > 1024) throw INVALID();
    // Not a standard receive path: must be under m/45' or m/48' (9.27.0 / 9.27.1), depth <= 10.
    const external = keypath[0] === 48 + HARDENED ? this.versionAtLeast(9, 27, 1) : keypath[0] === 45 + HARDENED ? this.versionAtLeast(9, 27, 0) : false;
    if (!external || keypath.length > 10) throw INVALID();
    const text = new TextDecoder().decode(msg);
    const signPath = this.tamper.has('message-key') ? [...keypath.slice(0, -1), keypath.at(-1)! + 1] : keypath;
    const key = this.xpubAt(signPath).privateKey!;
    const address = btc.p2wpkh(this.xpubAt(keypath).publicKey!, NETWORKS[this.network].btc).address!;
    const coinName = coin === 0 ? 'Bitcoin' : coin === 1 ? 'BTC Testnet' : 'BTC Regtest';
    this.screens.push({ title: 'Sign message', body: `Coin: ${coinName}\nExternal service key` }, { title: 'Address', body: address }, { title: 'Sign message', body: text });
    if (!this.owner.message) throw ABORT();
    const signedText = this.tamper.has('message-text') ? `${text}.` : text;
    const z = messageHash(new TextEncoder().encode(signedText));
    const commitment = r.message(4)?.bytes(1);
    if (commitment) {
      if (commitment.length !== 32) throw INVALID();
      this.msgSign = { key, z, commitment, text: signedText };
      return { commitment: s2cCommit(key, z, commitment) };
    }
    const sig = s2cSign(key, z, new Uint8Array(32));
    this.signedTexts.push(signedText);
    this.textsWithAntiKlepto.push(false);
    return { signature: new Uint8Array([...sig.signature, sig.recid]) };
  }

  // ---- payments (signtx.rs) -----------------------------------------------------------------------------------

  private signInit(r: ProtoMessage): ProtoWriter {
    this.coinOk(r.uint(1));
    const configs = r.repeatedBytes(2).map((b) => ProtoMessage.parse(b));
    if (configs.length !== 1) throw INVALID();
    const keypath = configs[0]!.repeatedUint(3);
    const multisig = this.multisigOf(configs[0]!.message(2)!, keypath);
    if (!this.registeredName(r.uint(1), multisig, keypath)) throw INVALID();
    const version = r.uint(4);
    if (version !== 1 && version !== 2) throw INVALID();
    const numInputs = r.uint(5);
    const numOutputs = r.uint(6);
    if (numInputs < 1 || numOutputs < 1) throw INVALID();
    this.tx = { coin: r.uint(1), config: { multisig, keypath }, version, numInputs, numOutputs, locktime: r.uint(7), inputs: [], outputs: [], pass2: -1 };
    return nextMessage({ type: 0, index: 0 });
  }

  private placeOf(keypath: number[]): [number, number] {
    const t = this.tx!;
    const acct = t.config.keypath;
    if (keypath.length !== acct.length + 2 || !acct.every((x, i) => keypath[i] === x)) throw INVALID();
    const [chain, index] = keypath.slice(-2) as [number, number];
    if (chain > 1) throw INVALID();
    return [chain, index];
  }

  private signInput(r: ProtoMessage): { next: ProtoWriter; decisions: number } {
    const t = this.tx;
    if (!t) throw new FakeError(105);
    const input = { prevOutHash: r.bytes(1), prevOutIndex: r.uint(2), prevOutValue: r.uint(3), sequence: r.uint(4), keypath: r.repeatedUint(6) };
    if (input.prevOutValue === 0 || input.prevOutHash.length !== 32 || r.uint(7) !== 0) throw INVALID();
    this.placeOf(input.keypath);
    if (t.pass2 < 0) {
      if (t.inputs.length >= t.numInputs) throw INVALID();
      t.inputs.push(input);
      return { next: nextMessage({ type: 3, index: t.inputs.length - 1 }), decisions: 0 };
    }
    const index = t.pass2;
    const first = t.inputs[index]!;
    if (!same(first.prevOutHash, input.prevOutHash) || first.prevOutIndex !== input.prevOutIndex || first.prevOutValue !== input.prevOutValue || first.sequence !== input.sequence || first.keypath.join() !== input.keypath.join())
      throw INVALID();
    const commitment = r.message(8)?.bytes(1);
    if (commitment) {
      if (commitment.length !== 32) throw INVALID();
      t.awaitingNonce = { index, commitment };
      return { next: nextMessage({ type: 6, index, commitment: s2cCommit(this.inputKey(index), this.signedHash(index), commitment) }), decisions: 0 };
    }
    return { next: this.signed(index, new Uint8Array(32)), decisions: 0 };
  }

  private antikleptoTx(nonce: Uint8Array): ProtoWriter {
    const t = this.tx;
    if (!t?.awaitingNonce) throw new FakeError(105);
    const { index } = t.awaitingNonce;
    t.awaitingNonce = undefined;
    return this.signed(index, this.tamper.has('antiklepto') ? new Uint8Array(32) : nonce);
  }

  private inputKey(index: number): Uint8Array {
    return this.xpubAt(this.tx!.inputs[index]!.keypath).privateKey!;
  }

  /** The signature of input `index`, and the next step. */
  private signed(index: number, hostNonce: Uint8Array): ProtoWriter {
    const t = this.tx!;
    const sig = s2cSign(this.inputKey(index), this.signedHash(index), hostNonce);
    t.pass2++;
    const done = t.pass2 >= t.numInputs;
    if (done) {
      this.signedPayments.push({ inputs: t.numInputs, outputs: t.outputs.map((o) => ({ value: o.value, script: hexOf(o.script) })) });
      this.tx = undefined;
    }
    const skip = this.tamper.has('skip-input') && index === 0;
    return nextMessage({ type: done ? 2 : 0, index: done ? 0 : t.pass2, ...(skip ? {} : { signature: sig.signature }) });
  }

  private prevtxInit(r: ProtoMessage): ProtoWriter {
    const t = this.tx;
    if (!t || t.pass2 >= 0) throw new FakeError(105);
    const p = { version: r.uint(1), numInputs: r.uint(2), numOutputs: r.uint(3), locktime: r.uint(4), inputs: [] as Uint8Array[], outputs: [] as { value: number; script: Uint8Array }[] };
    const input = t.inputs.at(-1)!;
    if (p.numInputs < 1 || p.numOutputs < 1 || input.prevOutIndex >= p.numOutputs) throw INVALID();
    t.prev = p;
    return nextMessage({ type: 4, index: t.inputs.length - 1, prevIndex: 0 });
  }

  private prevtxInput(r: ProtoMessage): ProtoWriter {
    const t = this.tx;
    const p = t?.prev;
    if (!t || !p) throw new FakeError(105);
    const hash = r.bytes(1);
    if (hash.length !== 32) throw INVALID();
    const script = r.bytes(3);
    p.inputs.push(cat(hash, le32(r.uint(2)), varint(script.length), script, le32(r.uint(4))));
    if (p.inputs.length < p.numInputs) return nextMessage({ type: 4, index: t.inputs.length - 1, prevIndex: p.inputs.length });
    return nextMessage({ type: 5, index: t.inputs.length - 1, prevIndex: 0 });
  }

  private prevtxOutput(r: ProtoMessage): ProtoWriter {
    const t = this.tx;
    const p = t?.prev;
    if (!t || !p) throw new FakeError(105);
    p.outputs.push({ value: r.uint(1), script: r.bytes(2) });
    if (p.outputs.length < p.numOutputs) return nextMessage({ type: 5, index: t.inputs.length - 1, prevIndex: p.outputs.length });
    // handle_prevtx: the double hash of the transaction must be the outpoint; its output must be the input's.
    const raw = cat(
      le32(p.version),
      varint(p.numInputs),
      ...p.inputs,
      varint(p.numOutputs),
      ...p.outputs.flatMap((o) => [le64(o.value), varint(o.script.length), o.script]),
      le32(p.locktime),
    );
    const input = t.inputs.at(-1)!;
    if (!same(sha256d(raw), input.prevOutHash)) throw INVALID();
    const spent = p.outputs[input.prevOutIndex]!;
    const [chain, index] = this.placeOf(input.keypath);
    if (spent.value !== input.prevOutValue || !same(spent.script, this.multisigScript(t.config.multisig, chain, index).script)) throw INVALID();
    t.prev = undefined;
    if (t.inputs.length < t.numInputs) return nextMessage({ type: 0, index: t.inputs.length });
    return nextMessage({ type: 1, index: 0 });
  }

  private signOutput(r: ProtoMessage): { next: ProtoWriter; decisions: number } {
    const t = this.tx;
    if (!t || t.pass2 >= 0 || t.inputs.length < t.numInputs) throw new FakeError(105);
    const value = r.uint(3);
    let script: Uint8Array;
    if (r.bool(1)) {
      const [chain, index] = this.placeOf(r.repeatedUint(5));
      if (index > 10_000 || r.uint(6) !== 0) throw INVALID();
      script = this.multisigScript(t.config.multisig, chain, index).script;
    } else {
      const payload = r.bytes(4);
      const type = r.uint(2);
      const scripts: Record<number, () => Uint8Array> = {
        1: () => cat(new Uint8Array([0x76, 0xa9, 0x14]), payload, new Uint8Array([0x88, 0xac])),
        2: () => cat(new Uint8Array([0xa9, 0x14]), payload, new Uint8Array([0x87])),
        3: () => cat(new Uint8Array([0x00, 0x14]), payload),
        4: () => cat(new Uint8Array([0x00, 0x20]), payload),
        5: () => cat(new Uint8Array([0x51, 0x20]), payload),
      };
      const make = scripts[type];
      if (!make || payload.length !== (type === 1 || type === 2 || type === 3 ? 20 : 32)) throw INVALID();
      script = make();
      this.screens.push({ title: 'Send to', body: `${btc.Address(NETWORKS[this.network].btc).encode(btc.OutScript.decode(script))}\n${value} sat` });
    }
    t.outputs.push({ value, script });
    if (t.outputs.length < t.numOutputs) return { next: nextMessage({ type: 1, index: t.outputs.length }), decisions: 0 };
    const fee = t.inputs.reduce((n, i) => n + i.prevOutValue, 0) - t.outputs.reduce((n, o) => n + o.value, 0);
    if (fee < 0) throw INVALID();
    this.screens.push({ title: 'Fee', body: `${fee} sat` });
    if (!this.owner.payment) throw ABORT();
    t.pass2 = 0;
    return { next: nextMessage({ type: 0, index: 0 }), decisions: 1 };
  }

  /** What it signs for input `index`: the sighash, or (tampered) something else, committed to and signed alike. */
  private signedHash(index: number): Uint8Array {
    const z = this.sighash(index);
    return this.tamper.has('tx-signature') ? sha256(z) : z;
  }

  /** BIP 143 for input `index`, SIGHASH_ALL, from what the phone sent. */
  private sighash(index: number): Uint8Array {
    const t = this.tx!;
    const input = t.inputs[index]!;
    const [chain, i] = this.placeOf(input.keypath);
    const ws = this.multisigScript(t.config.multisig, chain, i).witnessScript;
    const preimage = cat(
      le32(t.version),
      sha256d(cat(...t.inputs.map((x) => cat(x.prevOutHash, le32(x.prevOutIndex))))),
      sha256d(cat(...t.inputs.map((x) => le32(x.sequence)))),
      input.prevOutHash,
      le32(input.prevOutIndex),
      varint(ws.length),
      ws,
      le64(input.prevOutValue),
      le32(input.sequence),
      sha256d(cat(...t.outputs.flatMap((o) => [le64(o.value), varint(o.script.length), o.script]))),
      le32(t.locktime),
      le32(1),
    );
    return sha256d(preimage);
  }
}

/** The fake's end of the link: reports in, reports out (asynchronously, as a real link delivers them). */
export class FakeConnection implements BitBoxConnection {
  private readonly reader = new ReportReader();
  private readonly listeners = new Set<(r: Uint8Array) => void>();
  private readonly downListeners = new Set<(e?: Error) => void>();
  closed = false;
  /** Every report written, for tests that look at the bytes. */
  readonly written: Uint8Array[] = [];

  constructor(
    readonly device: BitBoxDevice,
    private readonly bitbox: FakeBitBox02,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('closed');
    if (bytes.length % REPORT_SIZE !== 0) throw new Error('not whole reports');
    for (let at = 0; at < bytes.length; at += REPORT_SIZE) {
      const report = bytes.slice(at, at + REPORT_SIZE);
      this.written.push(report);
      const message = this.reader.push(report);
      if (!message) continue;
      const answer = encodeReports(this.bitbox.frame(message));
      setTimeout(() => {
        if (this.closed) return;
        for (let i = 0; i < answer.length; i += REPORT_SIZE) for (const l of [...this.listeners]) l(answer.slice(i, i + REPORT_SIZE));
      }, 0);
    }
  }

  onReport(listener: (report: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  /** The cable pulled out. */
  unplug(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.downListeners]) l(new Error('unplugged'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.downListeners]) l();
  }
}
