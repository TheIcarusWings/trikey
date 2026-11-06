/**
 * A Blockstream Jade over Bluetooth, for tests: a `JadeBleLink` whose device speaks Jade's RPC the way its firmware does
 * at a59d14c (`main/wire.c`, `main/process/{auth_user,pinclient,get_xpubs,register_multisig,get_receive_address,
 * sign_psbt,sign_message}.c`), plus a fake blind PIN server. It is written from the firmware, independently of the app's
 * Jade code, so each checks the other:
 *
 * - the bytes come in pieces (the phone writes in MTU-sized writes; the Jade answers in indications of up to MTU - 3) and
 *   the RPC is plain CBOR maps, with `log` lines in between;
 * - `auth_user` on a locked Jade answers with an `http_request` for the PIN server and waits for `pin` (an empty `pin`:
 *   "retry?" on the Jade, answered by the test);
 * - `sign_psbt` answers in parts of up to 3 KiB (`get_extended_data`);
 * - `sign_message` signs with RFC 6979 (deterministic), and refuses `ae_host_commitment` here because Trikey must not
 *   send it.
 *
 * The keys are a software wallet from a mnemonic (`SoftwareSigner`), on a test network.
 */
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secureRandomBytes } from '@trikey/core/random';
import { NETWORKS, SoftwareSigner, TX_OPTS, multisigScripts, type NetworkName } from '@trikey/core';
import { SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { decodeCbor, encodeCbor, CborIncomplete, type CborValue } from '../jade/cbor';
import type { JadeBleDevice, JadeBleLink, JadeConnection } from '../jade/link';
import type { FetchLike } from '../jade/pin-server';

type Map = Record<string, CborValue>;
const isMap = (v: unknown): v is Map => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Jade's `MAX_OUTPUT_MSG_SIZE` - 64: the size of each part of a signed PSBT (`PSBT_OUT_CHUNK_SIZE`). */
const PSBT_OUT_CHUNK = 3 * 1024 - 64;

export interface FakePinServer {
  fetch: FetchLike;
  calls: { url: string; body?: string }[];
  /** Answer with this HTTP status instead (e.g. 500). */
  failWith?: number;
  /** Throw (no connection). */
  unreachable?: boolean;
}

/** The blind PIN server: answers `{ data }` to a POST of `{ data }` at `/get_pin` or `/set_pin`. */
export function fakePinServer(): FakePinServer {
  const server: FakePinServer = {
    calls: [],
    fetch: async (url, init) => {
      server.calls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
      if (server.unreachable) throw new TypeError('Network request failed');
      if (server.failWith) return { ok: false, status: server.failWith, text: async () => 'error' };
      const req = JSON.parse(init.body ?? 'null') as { data?: string };
      // The real server decrypts with its key; here the "server key" is the request turned around.
      const answer = { data: `server:${req.data ?? ''}` };
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    },
  };
  return server;
}

export interface FakeJadeOptions {
  mnemonic: string;
  network?: NetworkName;
  /** The PIN the owner types (the test plays the owner). Default right. */
  pinRight?: boolean;
  /** Start unlocked over Bluetooth (no PIN). */
  unlocked?: boolean;
  version?: string;
  board?: string;
  /** The PIN-server URLs the Jade sends (default: Blockstream's https and onion, as in `pinclient.c`). */
  pinServerUrls?: string[];
  /** Reply bytes are sent in pieces of this many bytes less 3 (an indication's payload). */
  mtu?: number;
  /** The size of each part of a signed PSBT (the firmware's is 3 KiB less 64). */
  psbtChunk?: number;
}

export class FakeJade {
  readonly network: NetworkName;
  readonly master: HDKey;
  readonly device: SoftwareHardwareSigner;
  readonly fingerprint: string;
  private unlocked: boolean;
  /** Every request the phone sent: method and params. */
  readonly requests: { method: string; params?: Map; id: string }[] = [];
  /** Registered multisig wallets by name. */
  readonly wallets = new globalThis.Map<string, Map>();
  readonly signedPsbts: Uint8Array[] = [];
  readonly signedTexts: string[] = [];
  /** What the owner does on the Jade when asked: approve, or decline (the firmware's -32000). */
  approve = true;
  /** The owner's answer to "Failed communicating with Oracle - retry?". */
  retryPinServer = false;
  /**
   * Tampering for tests: `wrong-key` signs texts with another seed; `bad-signature` returns a payment signature that does
   * not verify; `other-tx` signs a changed transaction; `drop-signature` leaves the last input unsigned;
   * `bad-message-signature` answers a text with garbage; `other-text` signs another text.
   */
  tamper?: 'wrong-key' | 'bad-signature' | 'other-tx' | 'drop-signature' | 'bad-message-signature' | 'other-text';
  private pinRight: boolean;
  private readonly urls: string[];
  private readonly mtu: number;
  /** The pending PIN-server exchange (the data the Jade sent). */
  private pinData?: string;
  private pendingPsbt?: { id: string; parts: Uint8Array[] };
  conn?: FakeJadeConnection;
  connects = 0;

  constructor(private readonly opts: FakeJadeOptions) {
    this.network = opts.network ?? 'regtest';
    this.master = HDKey.fromMasterSeed(mnemonicToSeedSync(opts.mnemonic), NETWORKS[this.network].bip32);
    this.device = new SoftwareHardwareSigner({ mnemonic: opts.mnemonic, network: this.network, kind: 'jade-ble', requireRegistration: false });
    this.fingerprint = this.device.info.fingerprint;
    this.unlocked = opts.unlocked ?? false;
    this.pinRight = opts.pinRight ?? true;
    this.urls = opts.pinServerUrls ?? ['https://j8d.io/get_pin', 'http://mrrxtq6tjpbnbm7vh5jt6mpjctn7ggyfy5wegvbeff3x7jrznqawlmid.onion/get_pin'];
    this.mtu = opts.mtu ?? 23;
  }

  setPinRight(right: boolean) {
    this.pinRight = right;
  }

  get isUnlocked() {
    return this.unlocked;
  }

  /** The link the phone sees: this one Jade, advertising "Jade ABC123". */
  link(): JadeBleLink & { supported: boolean; prepareProblem?: string } {
    const jade = this;
    const device: JadeBleDevice = { id: 'AA:BB:CC:AB:C1:23', name: 'Jade ABC123', rssi: -50 };
    return {
      supported: true,
      prepareProblem: undefined,
      async isSupported() {
        return this.supported;
      },
      async prepare() {
        return this.prepareProblem;
      },
      async scan(onFound, signal) {
        // Another device first, which is not a Jade.
        onFound({ id: '11', name: 'Speaker', rssi: -70 });
        if (signal.aborted) throw new Error('aborted');
        if (!onFound(device)) throw new Error('not found');
        return device;
      },
      async connect(d) {
        if (d.id !== device.id) throw new Error('unknown device');
        jade.connects++;
        jade.conn = new FakeJadeConnection(jade, d);
        return jade.conn;
      },
      unavailableReason: undefined,
    };
  }

  // ---- the firmware ------------------------------------------------------------------------------------------

  /** Called with a whole request (the firmware's `handle_data` found a complete CBOR map). */
  handle(msg: CborValue): void {
    if (!isMap(msg) || typeof msg.id !== 'string' || typeof msg.method !== 'string') return this.send({ id: '00', error: { code: -32600, message: 'Invalid RPC Request message' } });
    const { id, method } = msg;
    const params = isMap(msg.params) ? msg.params : undefined;
    this.requests.push({ method, id, ...(params ? { params } : {}) });
    this.send({ log: new TextEncoder().encode(`I Handling ${method}`) });
    const reply = (result: CborValue) => this.send({ id, result });
    const fail = (code: number, message: string) => this.send({ id, error: { code, message, data: null } });

    switch (method) {
      case 'get_version_info':
        return reply({
          JADE_VERSION: this.opts.version ?? '1.0.41',
          BOARD_TYPE: this.opts.board ?? 'JADE_V2',
          JADE_STATE: this.unlocked ? 'READY' : 'LOCKED',
          JADE_INTERFACE: this.unlocked ? 'BLE' : 'NONE',
          JADE_NETWORKS: 'TEST',
          JADE_HAS_PIN: true,
        });
      case 'auth_user': {
        if (params?.network !== (this.network === 'regtest' ? 'localtest' : 'testnet')) return fail(-32003, 'Network type inconsistent with prior usage');
        if (typeof params?.epoch !== 'number') return fail(-32602, 'epoch');
        if (this.unlocked) return reply(true);
        return this.askPinServer(id);
      }
      case 'pin': {
        if (this.pinData === undefined) return fail(-32001, "Unexpected message, expecting 'pin'");
        if (!params) {
          // handle_pin: no params is PIN_CAN_RETRY, and the Jade asks the owner.
          if (this.retryPinServer) return this.askPinServer(id);
          this.pinData = undefined;
          return fail(-32602, 'Failed to read parameters from Oracle');
        }
        const ok = params.data === `server:${this.pinData}`;
        this.pinData = undefined;
        if (!ok) return fail(-32602, 'Failed to decrypt payload');
        if (!this.pinRight) return reply(false);
        this.unlocked = true;
        return reply(true);
      }
    }

    // Everything else needs the keys (dashboard.c: CBOR_RPC_HW_LOCKED).
    if (!this.unlocked) return fail(-32002, 'Cannot process message - hardware locked or uninitialized');
    switch (method) {
      case 'get_xpub': {
        const path = params?.path;
        if (!Array.isArray(path) || !path.every((n) => typeof n === 'number')) return fail(-32602, 'Failed to extract valid path from parameters');
        const key = path.length === 0 ? this.master : this.master.derive(`m/${(path as number[]).map((n) => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')}`);
        return reply(key.publicExtendedKey);
      }
      case 'register_multisig':
        return this.registerMultisig(params, reply, fail);
      case 'get_receive_address':
        return this.receiveAddress(params, reply, fail);
      case 'sign_psbt':
        return void this.signPsbt(id, params, reply, fail);
      case 'get_extended_data':
        return this.extendedData(id, params, fail);
      case 'sign_message':
        return void this.signMessage(params, reply, fail);
      default:
        return fail(-32601, `Unknown method: ${method}`);
    }
  }

  private askPinServer(id: string) {
    this.pinData = base64.encode(secureRandomBytes(48));
    this.send({ id, result: { http_request: { params: { urls: this.urls, method: 'POST', accept: 'json', data: { data: this.pinData } }, 'on-reply': 'pin' } } });
  }

  private registerMultisig(params: Map | undefined, reply: (r: CborValue) => void, fail: (c: number, m: string) => void) {
    const name = params?.multisig_name;
    const d = isMap(params?.descriptor) ? params.descriptor : undefined;
    if (typeof name !== 'string' || !/^[\x21-\x7e]{1,15}$/.test(name)) return fail(-32602, 'Missing or invalid multisig name parameter');
    if (!d || d.variant !== 'wsh(multi(k))') return fail(-32602, 'Invalid script variant parameter');
    if (typeof d.threshold !== 'number' || !Array.isArray(d.signers)) return fail(-32602, 'Failed to extract valid co-signers from parameters');
    let ours = false;
    for (const s of d.signers) {
      if (!isMap(s) || !(s.fingerprint instanceof Uint8Array) || s.fingerprint.length !== 4 || !Array.isArray(s.derivation) || typeof s.xpub !== 'string' || !Array.isArray(s.path))
        return fail(-32602, 'Failed to extract valid co-signers from parameters');
      if ((s.path as number[]).some((n) => n >= 0x80000000)) return fail(-32602, 'Failed to validate co-signers');
      const fp = Array.from(s.fingerprint, (b) => b.toString(16).padStart(2, '0')).join('');
      if (fp === this.fingerprint) {
        const path = (s.derivation as number[]).map((n) => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/');
        if (HDKey.fromExtendedKey(s.xpub, NETWORKS[this.network].bip32).publicKey!.toString() === this.master.derive(`m/${path}`).publicKey!.toString()) ours = true;
      }
    }
    if (!ours) return fail(-32602, 'Failed to validate co-signers');
    if (!this.approve) return fail(-32000, 'User declined to register multisig');
    this.wallets.set(name, d);
    reply(true);
  }

  private receiveAddress(params: Map | undefined, reply: (r: CborValue) => void, fail: (c: number, m: string) => void) {
    const w = typeof params?.multisig_name === 'string' ? this.wallets.get(params.multisig_name) : undefined;
    if (!w) return fail(-32602, 'Cannot find named multisig wallet');
    const paths = params?.paths as number[][];
    const signers = w.signers as Map[];
    const pubkeys = signers.map((s, i) => HDKey.fromExtendedKey(s.xpub as string, NETWORKS[this.network].bip32).derive(`m/${paths[i]!.join('/')}`).publicKey!);
    if (!this.approve) return fail(-32000, 'User declined to confirm address');
    reply(multisigScripts(pubkeys, NETWORKS[this.network]).address);
  }

  private async signPsbt(id: string, params: Map | undefined, reply: (r: CborValue) => void, fail: (c: number, m: string) => void) {
    if (params?.network !== (this.network === 'regtest' ? 'localtest' : 'testnet')) return fail(-32003, 'Network type inconsistent with prior usage');
    if (!(params?.psbt instanceof Uint8Array)) return fail(-32602, 'Failed to extract psbt bytes from parameters');
    if (!this.approve) return fail(-32000, 'User declined to sign psbt');
    let psbt = params.psbt;
    this.signedPsbts.push(psbt);
    if (this.tamper === 'other-tx') {
      const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
      const out = tx.getOutput(0);
      tx.updateOutput(0, { amount: out.amount! - 1000n }, true);
      psbt = tx.toPSBT();
    }
    let signed: Uint8Array;
    try {
      signed = await new SoftwareSigner('hardware', this.opts.mnemonic, 'fake Jade').signPsbt(psbt, NETWORKS[this.network]);
    } catch {
      return fail(-32603, 'Failed to sign psbt');
    }
    if (this.tamper === 'bad-signature') {
      // A signature under this Jade's key name that does not verify (one byte of r changed).
      const done = btc.Transaction.fromPSBT(signed, TX_OPTS);
      const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
      for (let i = 0; i < tx.inputsLength; i++) {
        const sigs = (done.getInput(i).partialSig ?? []).map(([pub, sig]) => {
          const bad = new Uint8Array(sig);
          bad[10] = bad[10]! ^ 0x01;
          return [pub, bad] as [Uint8Array, Uint8Array];
        });
        if (sigs.length) tx.updateInput(i, { partialSig: sigs }, true);
      }
      signed = tx.toPSBT();
    }
    if (this.tamper === 'drop-signature') {
      // The signatures of every input but the last, on the PSBT as it came.
      const done = btc.Transaction.fromPSBT(signed, TX_OPTS);
      const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
      for (let i = 0; i < tx.inputsLength - 1; i++) {
        const sigs = done.getInput(i).partialSig ?? [];
        if (sigs.length) tx.updateInput(i, { partialSig: sigs }, true);
      }
      signed = tx.toPSBT();
    }
    const parts: Uint8Array[] = [];
    const chunk = this.opts.psbtChunk ?? PSBT_OUT_CHUNK;
    for (let at = 0; at < signed.length; at += chunk) parts.push(signed.slice(at, at + chunk));
    this.pendingPsbt = { id, parts };
    this.send({ id, seqnum: 1, seqlen: parts.length, result: parts[0]! });
    if (parts.length === 1) this.pendingPsbt = undefined;
  }

  private extendedData(id: string, params: Map | undefined, fail: (c: number, m: string) => void) {
    const p = this.pendingPsbt;
    // check_extended_data_fields: origid, orig, seqnum (the next one), seqlen.
    if (!p || params?.origid !== p.id || params?.orig !== 'sign_psbt' || params?.seqlen !== p.parts.length || typeof params?.seqnum !== 'number')
      return fail(-32001, "Mismatched fields in 'get_extended_data' message");
    const n = params.seqnum;
    this.send({ id, seqnum: n, seqlen: p.parts.length, result: p.parts[n - 1]! });
    if (n === p.parts.length) this.pendingPsbt = undefined;
  }

  private async signMessage(params: Map | undefined, reply: (r: CborValue) => void, fail: (c: number, m: string) => void) {
    // Trikey must never ask for anti-exfil here: notes and unlock need RFC 6979.
    if (params && 'ae_host_commitment' in params) return fail(-32602, 'test: anti-exfil not expected');
    const path = params?.path;
    const message = params?.message;
    if (!Array.isArray(path) || path.length === 0) return fail(-32602, 'Failed to extract valid path from parameters');
    if (typeof message !== 'string' || !message) return fail(-32602, 'Failed to extract message from parameters');
    if (!this.approve) return fail(-32000, 'User declined to sign message');
    const p = `m/${(path as number[]).map((n) => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')}`;
    this.signedTexts.push(message);
    if (this.tamper === 'bad-message-signature') return reply('not base64 at all!');
    const text = this.tamper === 'other-text' ? `${message}!` : message;
    const sig = this.tamper === 'wrong-key' ? await new SoftwareHardwareSigner({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', network: this.network }).signMessage(p, text) : await this.device.signMessage(p, text);
    reply(sig);
  }

  /** Sends a message to the phone, cut in indication-sized pieces. */
  send(msg: Record<string, unknown>): void {
    const bytes = encodeCbor(msg);
    const size = Math.max(1, this.mtu - 3);
    for (let at = 0; at < bytes.length; at += size) this.conn?.deliver(bytes.slice(at, at + size));
  }

  /** Drops the link (the Jade turned off). The firmware clears the keys when the link that unlocked them goes. */
  disconnect(): void {
    this.unlocked = false;
    this.conn?.drop();
  }
}

export class FakeJadeConnection implements JadeConnection {
  private readonly data = new Set<(b: Uint8Array) => void>();
  private readonly downs = new Set<(e?: Error) => void>();
  private inbound = new Uint8Array(0);
  closed = false;
  /** Every write the phone made, by size (to check MTU-sized writes). */
  readonly writes: number[] = [];

  constructor(
    private readonly jade: FakeJade,
    readonly device: JadeBleDevice,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('not connected');
    this.writes.push(bytes.length);
    const joined = new Uint8Array(this.inbound.length + bytes.length);
    joined.set(this.inbound);
    joined.set(bytes, this.inbound.length);
    this.inbound = joined;
    // wire.c handle_data: parse as many complete messages as there are.
    for (;;) {
      if (this.inbound.length === 0) return;
      let d: { value: CborValue; end: number };
      try {
        d = decodeCbor(this.inbound);
      } catch (e) {
        if (e instanceof CborIncomplete) return;
        this.inbound = new Uint8Array(0);
        return this.jade.send({ id: '00', error: { code: -32600, message: 'Invalid RPC Request message' } });
      }
      this.inbound = this.inbound.slice(d.end);
      // The firmware answers from its own task, after the write returned.
      queueMicrotask(() => this.jade.handle(d.value));
    }
  }

  deliver(bytes: Uint8Array) {
    if (this.closed) return;
    for (const l of [...this.data]) l(bytes);
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    this.downs.add(listener);
    return () => this.downs.delete(listener);
  }

  drop() {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.downs]) l(new Error('link lost'));
  }

  async close(): Promise<void> {
    this.jade.disconnect();
  }
}

