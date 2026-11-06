/**
 * A Coldcard over NFC, for tests: the tag memory its ST25DV chip exposes, and what its firmware does with it. Written
 * from Coldcard's firmware at 09766a1 (`shared/ndef.py`, `shared/nfc.py`, `shared/msgsign.py`, `shared/multisig.py`),
 * independently of the app's own NDEF code, so each checks the other:
 *
 * - `ColdcardNdef`: a port of `ndefMaker` (what the Coldcard shares, with its Type 5 capability container and TLV) and
 *   of `ccfile_decode` + `record_parser` (how it reads what the phone wrote);
 * - `FakeColdcardTag`: an `NfcTransport` that plays the phone's reader against that memory, the way Android's `Ndef` and
 *   iOS's `NFCNDEFTag` do (they read the capability container, then the NDEF TLV);
 * - `FakeColdcard`: the device. The test (the "owner") puts it in the right NFC menu: share the multisig key export,
 *   receive a wallet / PSBT / text to sign. Signing uses a software key (`SoftwareHardwareSigner`); the PSBT is signed only
 *   for a wallet it imported, as a real Coldcard refuses an "Unknown multisig wallet".
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { NETWORKS, SoftwareSigner, TX_OPTS } from '@trikey/core';
import { SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { HardwareError } from '../errors';
import type { NfcBridge, NfcRequest } from '../nfc/bridge';
import { decodeNdefMessage, type NdefRecord } from '../nfc/ndef';
import type { NfcTransport } from '../nfc/transport';
import { messageAddresses } from '../qr/message';

// ------------------------------------------------------------------------------------------------ shared/ndef.py

/** `CC_FILE`: read-only, 8 KiB (MLEN 0x0400 × 8), then the NDEF TLV tag (0x03). */
export const CC_FILE = [0xe2, 0x43, 0x00, 0x01, 0x00, 0x00, 0x04, 0x00, 0x03];
/** `CC_WR_FILE`: writable, an empty NDEF TLV, then the terminator. */
export const CC_WR_FILE = [0xe2, 0x40, 0x00, 0x01, 0x00, 0x00, 0x04, 0x00, 0x03, 0x00, 0xfe];
const TAG_BYTES = 8192;

type MakerRecord = { tnf: number; type: Uint8Array; payload: Uint8Array };
const enc = (s: string) => new TextEncoder().encode(s);

/** A port of `ndefMaker`: the records a Coldcard shares, as tag memory (`bytes()`). */
export class ColdcardNdef {
  readonly lst: MakerRecord[] = [];
  addText(msg: string) {
    this.lst.push({ tnf: 0x1, type: enc('T'), payload: new Uint8Array([0x02, ...enc('en'), ...enc(msg)]) });
  }
  addCustom(extType: string, payload: Uint8Array) {
    this.lst.push({ tnf: 0x4, type: enc(extType), payload });
  }
  addMimeData(mime: string, payload: Uint8Array) {
    this.lst.push({ tnf: 0x2, type: enc(mime), payload });
  }
  bytes(): Uint8Array {
    const rv = [...CC_FILE];
    const ln = this.lst.reduce((n, r) => n + (r.payload.length <= 255 ? 3 : 6) + r.type.length + r.payload.length, 0);
    if (ln <= 0xfe) rv.push(ln);
    else rv.push(0xff, (ln >> 8) & 0xff, ln & 0xff);
    const last = this.lst.length - 1;
    this.lst.forEach((r, n) => {
      let first = r.tnf;
      if (r.payload.length <= 255) first |= 0x10;
      if (n === 0) first |= 0x80;
      if (n === last) first |= 0x40;
      rv.push(first, r.type.length);
      if (r.payload.length <= 255) rv.push(r.payload.length);
      else rv.push((r.payload.length >>> 24) & 0xff, (r.payload.length >>> 16) & 0xff, (r.payload.length >>> 8) & 0xff, r.payload.length & 0xff);
      rv.push(...r.type, ...r.payload);
    });
    rv.push(0xfe);
    return Uint8Array.from(rv);
  }
}

/** A port of `ccfile_decode`: where the NDEF message starts, its length, whether the tag is writable, its size. */
export function ccfileDecode(taste: Uint8Array): { start: number; length: number; writable: boolean; size: number } {
  const [ex, b1, b2] = [taste[0]!, taste[1]!, taste[2]!];
  if ((b1 & 0xf0) !== 0x40) throw new Error('bad version');
  let st: number;
  let mlen: number;
  if (ex === 0xe1) {
    if (b2 !== 0) {
      st = 4;
      mlen = b2;
    } else {
      st = 6;
      mlen = (taste[4]! << 8) | taste[5]!;
    }
  } else if (ex === 0xe2) {
    st = 8;
    mlen = (taste[6]! << 8) | taste[7]!;
  } else throw new Error('bad first byte');
  if (taste[st] !== 0x03) throw new Error('no NDEF TLV');
  st += 1;
  let ll: number;
  if (taste[st] === 0xff) {
    ll = (taste[st + 1]! << 8) | taste[st + 2]!;
    st += 3;
  } else {
    ll = taste[st]!;
    st += 1;
  }
  if (!(ll >= 0 && ll < 8196)) throw new Error('bad length');
  return { start: st, length: ll, writable: (b1 & 3) === 0, size: mlen * 4 };
}

/** A port of `record_parser`: [urn, payload] per record, text records unwrapped. Refuses chunks; needs MB first. */
export function recordParser(msg: Uint8Array): Array<{ urn: string | null; payload: Uint8Array }> {
  const out: Array<{ urn: string | null; payload: Uint8Array }> = [];
  let pos = 0;
  for (;;) {
    const hdr = msg[pos]!;
    const ME = hdr & 0x40;
    if (hdr & 0x20) throw new Error('no chunks please');
    if ((pos === 0) !== Boolean(hdr & 0x80)) throw new Error('first needs MB set');
    const tyLen = msg[pos + 1]!;
    pos += 2;
    let plLen: number;
    if (hdr & 0x10) {
      plLen = msg[pos]!;
      pos += 1;
    } else {
      plLen = ((msg[pos]! << 24) | (msg[pos + 1]! << 16) | (msg[pos + 2]! << 8) | msg[pos + 3]!) >>> 0;
      pos += 4;
    }
    let idLen = 0;
    if (hdr & 0x08) {
      idLen = msg[pos]!;
      pos += 1;
    }
    const ty = new TextDecoder().decode(msg.subarray(pos, pos + tyLen));
    pos += tyLen;
    const tnf = hdr & 7;
    let urn: string | null;
    if (tnf === 0) urn = null;
    else if (tnf === 1) {
      urn = `urn:nfc:wkt:${ty}`;
      if (ty === 'T') {
        const langLen = msg[pos]! & 0x3f;
        pos += 1 + langLen;
        plLen -= 1 + langLen;
      }
    } else if (tnf === 2) urn = ty;
    else if (tnf === 4) urn = `urn:nfc:ext:${ty}`;
    else throw new Error('TNF');
    pos += idLen;
    out.push({ urn, payload: msg.slice(pos, pos + plLen) });
    if (ME) return out;
    pos += plLen;
    if (pos >= msg.length) throw new Error('missing ME/truncated');
  }
}

// ------------------------------------------------------------------------------------------------ the tag

type Mode = { kind: 'off' } | { kind: 'share'; image: Uint8Array } | { kind: 'receive'; image: Uint8Array; onWritten: (ndef: Uint8Array) => void | Promise<void> };

/** What the phone's reader does to the Coldcard's tag. Set `enabled` false for "NFC off on the phone". */
export class FakeColdcardTag implements NfcTransport {
  readonly systemSheet = false;
  supported = true;
  enabled = true;
  /** Make the next tap fail as if the phone moved away. */
  loseNext = false;
  /** Damage the last record of the next read, as a bad radio transfer would (the checksum record then disagrees). */
  corruptNextRead = false;
  mode: Mode = { kind: 'off' };
  readonly log: Array<{ op: 'read' | 'write'; bytes: number }> = [];
  unavailableReason?: string;
  /** The Coldcard still working on what was written (signing): a read waits for it, as the owner waits for the screen. */
  private working: Promise<void> = Promise.resolve();

  async isSupported() {
    return this.supported;
  }
  async isEnabled() {
    return this.supported && this.enabled;
  }

  private tap(): void {
    if (this.loseNext) {
      this.loseNext = false;
      throw new HardwareError('disconnected', 'The phone lost the Coldcard. Hold the phone still against it until it is done, then try again.');
    }
    if (this.mode.kind === 'off') throw new HardwareError('timeout', 'The phone stopped waiting for the Coldcard. Try again, and hold the phone against it within a minute.');
  }

  async write(message: Uint8Array): Promise<void> {
    this.tap();
    const m = this.mode;
    if (m.kind !== 'receive') throw new HardwareError('device-error', 'The Coldcard is not waiting for data.');
    // As the phone's NFC stack: read the capability container, check it is writable and big enough, write the TLV.
    const cc = ccfileDecode(m.image);
    if (!cc.writable) throw new HardwareError('device-error', 'The tag is read-only.');
    const tlv = message.length < 0xff ? [0x03, message.length] : [0x03, 0xff, message.length >> 8, message.length & 0xff];
    const image = new Uint8Array([...m.image.subarray(0, 8), ...tlv, ...message, 0xfe]);
    if (image.length > TAG_BYTES) throw new HardwareError('invalid-request', 'That is too large for the Coldcard over NFC.');
    this.log.push({ op: 'write', bytes: message.length });
    // The Coldcard reads it back once the radio has been quiet (`start_nfc_rx`), and wipes the tag.
    this.mode = { kind: 'off' };
    const cc2 = ccfileDecode(image);
    this.working = Promise.resolve(m.onWritten(image.slice(cc2.start, cc2.start + cc2.length)));
  }

  async read(): Promise<NdefRecord[]> {
    await this.working;
    this.tap();
    const m = this.mode;
    if (m.kind !== 'share') throw new HardwareError('invalid-response', 'The Coldcard is not sharing anything yet.');
    const cc = ccfileDecode(m.image);
    const message = m.image.slice(cc.start, cc.start + cc.length);
    this.log.push({ op: 'read', bytes: message.length });
    const records = decodeNdefMessage(message);
    if (this.corruptNextRead) {
      this.corruptNextRead = false;
      const last = records[records.length - 1]!;
      const payload = last.payload.slice();
      payload[payload.length - 1] ^= 0x01;
      records[records.length - 1] = { ...last, payload };
    }
    return records;
  }

  async cancel() {}
  async openSettings() {
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ the device

export interface FakeColdcardOptions {
  mnemonic: string;
  /** regtest or testnet (the Coldcard's "testnet mode": coin type 1). */
  network?: 'regtest' | 'testnet';
}

/** A Coldcard Mk4 behind `tag`. */
export class FakeColdcard {
  readonly tag = new FakeColdcardTag();
  readonly device: SoftwareHardwareSigner;
  readonly fingerprint: string;
  private readonly mnemonic: string;
  private readonly network: 'regtest' | 'testnet';
  /** Setup files imported over NFC (Settings › Multisig Wallets). */
  readonly wallets: string[] = [];
  /** Texts it signed. */
  readonly signedTexts: string[] = [];
  /** PSBTs it signed (as received). */
  readonly signedPsbts: Uint8Array[] = [];
  /** What it said when it refused something (`ux_show_story`). */
  readonly stories: string[] = [];
  /** Finalize when the PSBT is complete after its signature, and share the transaction (`share_signed_txn`). */
  finalizeWhenComplete = true;
  /** Tamper with what it shares next (tests of the phone's checks). */
  tamper?: 'message-text' | 'message-key' | 'message-garbage';

  constructor(opts: FakeColdcardOptions) {
    this.mnemonic = opts.mnemonic;
    this.network = opts.network ?? 'regtest';
    this.device = new SoftwareHardwareSigner({ mnemonic: opts.mnemonic, network: this.network, kind: 'coldcard-nfc', model: 'Coldcard Mk4', requireRegistration: false });
    this.fingerprint = this.device.info.fingerprint;
  }

  private share(n: ColdcardNdef) {
    this.tag.mode = { kind: 'share', image: n.bytes() };
  }

  private receive(onWritten: (ndef: Uint8Array) => void | Promise<void>) {
    this.tag.mode = { kind: 'receive', image: Uint8Array.from(CC_WR_FILE), onWritten };
  }

  /** Settings › Multisig Wallets › Export XPUB, account `account`, shared over NFC (`export_multisig_xpubs`, `share_json`). */
  async shareMultisigExport(account = 0) {
    const coin = 1;
    const deriv = `m/48h/${coin}h/${account}h/2h`;
    const xpub = await this.device.getXpub(`m/48'/${coin}'/${account}'/2'`);
    // The Coldcard writes the P2WSH key in SLIP-132 (Vpub on test networks); the app converts it.
    const vpub = slip132(xpub, 0x02575483);
    const json = `{\n  "p2wsh_deriv": "${deriv}",\n  "p2wsh": "${vpub}",\n  "p2wsh_desc": "wsh(sortedmulti(M,[${this.fingerprint}/48h/${coin}h/${account}h/2h]${xpub}/0/*,...))",\n  "account": "${account}",\n  "xfp": "${this.fingerprint.toUpperCase()}"\n}\n`;
    const n = new ColdcardNdef();
    n.addMimeData('application/json', enc(json));
    this.share(n);
  }

  /** Settings › Multisig Wallets › Import, over NFC (`import_multisig_nfc`): the first record of ≥ 70 bytes with "pub". */
  importMultisig() {
    this.receive((ndef) => {
      const winner = recordParser(ndef).find((r) => r.payload.length >= 70 && /pub|multi\(/.test(new TextDecoder().decode(r.payload)));
      if (!winner) return void this.stories.push('Unable to find multisig descriptor.');
      const text = new TextDecoder().decode(winner.payload);
      if (!/Policy: 2 of 3/.test(text) || !text.includes(this.fingerprint.toUpperCase())) return void this.stories.push('Failed to import.');
      this.wallets.push(text);
    });
  }

  /** NFC Tools › Sign PSBT (`start_psbt_rx`), approved by the owner, then shared back (`done_signing`). */
  signPsbtOverNfc() {
    this.receive((ndef) => this.onPsbt(ndef));
  }

  private async onPsbt(ndef: Uint8Array) {
    let psbt: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    for (const r of recordParser(ndef)) {
      if (r.payload.length > 100 && r.payload[0] === 0x70 && r.payload[4] === 0xff) psbt = r.payload;
      if (r.urn === 'urn:nfc:ext:bitcoin.org:sha256' && r.payload.length === 32) digest = r.payload;
    }
    if (!psbt) return void this.stories.push('Could not find PSBT in what was written.');
    if (digest && base64.encode(digest) !== base64.encode(sha256(psbt))) return void this.stories.push('PSBT checksum mismatch');
    // 'Unknown multisig wallet' unless every input's keys are those of a wallet it imported.
    const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
    const known = (fps: number[]) => this.wallets.some((w) => fps.every((fp) => w.includes(fp.toString(16).padStart(8, '0').toUpperCase())));
    for (let i = 0; i < tx.inputsLength; i++) {
      const fps = (tx.getInput(i).bip32Derivation ?? []).map(([, d]) => d.fingerprint);
      if (fps.length !== 3 || !known(fps)) return void this.stories.push('Unknown multisig wallet');
    }
    const signed = await new SoftwareSigner('hardware', this.mnemonic, 'fake Coldcard').signPsbt(psbt, NETWORKS[this.network]);
    this.signedPsbts.push(psbt);
    const out = btc.Transaction.fromPSBT(signed, TX_OPTS);
    const n = new ColdcardNdef();
    let complete = false;
    try {
      out.finalize();
      complete = true;
    } catch {
      complete = false;
    }
    if (complete && this.finalizeWhenComplete) {
      const raw = out.extract();
      const txid = out.id;
      n.addText('Signed Transaction: ' + txid);
      n.addCustom('bitcoin.org:txid', hex.decode(txid));
      n.addCustom('bitcoin.org:sha256', sha256(raw));
      n.addCustom('bitcoin.org:txn', raw);
    } else {
      const bytes = signed;
      n.addText('Partly signed PSBT');
      n.addCustom('bitcoin.org:sha256', sha256(bytes));
      n.addCustom('bitcoin.org:psbt', bytes);
    }
    this.share(n);
  }

  /** NFC Tools › Sign Message (`start_msg_sign`), approved, then the armored block shared (`msg_sign_done`). */
  signMessageOverNfc() {
    this.receive((ndef) => this.onMessage(ndef));
  }

  private async onMessage(ndef: Uint8Array) {
    const winner = recordParser(ndef)
      .map((r) => new TextDecoder().decode(r.payload))
      .find((m) => m.split('\n').length <= 3);
    if (!winner) return void this.stories.push('Unable to find correctly formated message to sign.');
    // parse_msg_sign_request, Sparrow form; then validate_text_for_signing.
    const m = /^signmessage (\S+) ascii:(.*)$/s.exec(winner);
    if (!m) return void this.stories.push('Problem: not a signmessage request');
    const [, subpath, text] = m as unknown as [string, string, string];
    if (text.length < 2 || text.length > 240 || text.includes('   ') || text !== text.trim()) return void this.stories.push('Problem: bad text');
    const path = subpath.replace(/h/g, "'");
    let sig = await this.device.signMessage(path, text);
    let shownText = text;
    const pub = HDKey.fromExtendedKey(await this.device.getXpub(path.split('/').slice(0, 5).join('/')), NETWORKS[this.network].bip32).derive(`m/${path.split('/').slice(5).join('/')}`).publicKey!;
    const address = messageAddresses(pub, this.network).p2pkh;
    if (this.tamper === 'message-text') shownText = text + 'x';
    if (this.tamper === 'message-key') {
      const other = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: this.network });
      sig = await other.signMessage(path, text);
    }
    if (this.tamper === 'message-garbage') sig = 'garbage';
    this.tamper = undefined;
    this.signedTexts.push(text);
    const armored = `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${shownText}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----\n`;
    const n = new ColdcardNdef();
    n.addText(armored);
    this.share(n);
  }

  /** The owner pressed X: NFC off. */
  stop() {
    this.tag.mode = { kind: 'off' };
  }
}

/** `xpub` re-encoded with another version (SLIP-132), as Coldcard exports P2WSH keys. */
function slip132(xpub: string, version: number): string {
  const hd = HDKey.fromExtendedKey(xpub, NETWORKS.regtest.bip32);
  return new HDKey({ versions: { private: 0, public: version }, depth: hd.depth, index: hd.index, parentFingerprint: hd.parentFingerprint, chainCode: hd.chainCode!, publicKey: hd.publicKey! }).publicExtendedKey;
}

/**
 * Plays the owner: for each NFC screen the phone shows, opens the Coldcard menu its steps name (share the export for the
 * account it names, import a wallet, sign a PSBT or a text), then taps the button. A "show" screen is confirmed. Returns
 * every request seen. `pause`: leave the screens alone (the test taps itself).
 */
export function playOwner(bridge: NfcBridge, cc: FakeColdcard) {
  const requests: NfcRequest[] = [];
  const seen = new WeakSet<object>();
  const state = { pause: false };
  bridge.subscribe(() => {
    const snap = bridge.getSnapshot();
    if (!snap || seen.has(snap.request) || state.pause) return;
    seen.add(snap.request);
    requests.push(snap.request);
    const r = snap.request;
    queueMicrotask(async () => {
      if (r.type === 'show') return bridge.finishShow();
      if (r.purpose === 'device-key') {
        const account = /account number (\d+)/.exec((r.steps ?? []).join(' '))?.[1];
        await cc.shareMultisigExport(Number(account ?? 0));
      } else if (r.purpose === 'wallet') cc.importMultisig();
      else if (r.purpose === 'psbt') cc.signPsbtOverNfc();
      else if (r.purpose === 'message') cc.signMessageOverNfc();
      await bridge.tap();
      // The Coldcard works on what it got in the background; give it a moment before the next screen taps.
      await new Promise((ok) => setTimeout(ok, 0));
    });
  });
  return { requests, state };
}
