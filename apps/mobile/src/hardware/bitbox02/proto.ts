/**
 * The protocol buffers the BitBox02 speaks, only the messages Trikey uses, written by hand from the firmware's
 * `messages/hww.proto`, `btc.proto`, `common.proto` and `antiklepto.proto` (bitbox02-firmware b27f5f68). Field numbers are
 * the `.proto`'s; the comments name the message. proto3: a field at its default value is left out, except a `oneof`
 * member, whose presence is the point (an empty message or an enum 0 in a `oneof` is written).
 *
 * The reader keeps every field of a message by number, so a parser asks for the ones it knows and ignores the rest
 * (newer firmware may add fields).
 */
import { HardwareError } from '../errors';

const KIND = 'bitbox02' as const;

// ---------------------------------------------------------------------------------------------------------------------
// Wire format

type Field = { no: number; wire: 0 | 2; value: number | Uint8Array };

export class ProtoWriter {
  private parts: number[] = [];

  private varint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new HardwareError('invalid-request', `Cannot encode ${n} for the BitBox02.`, { kind: KIND });
    let v = n;
    while (v >= 0x80) {
      this.parts.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.parts.push(v);
  }

  private tag(no: number, wire: 0 | 2): void {
    this.varint(no * 8 + wire);
  }

  /** A varint field (uint32, uint64, bool, enum); left out at 0 unless `always` (a `oneof` member). */
  uint(no: number, value: number | boolean | undefined, always = false): this {
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? 0);
    if (n === 0 && !always) return this;
    this.tag(no, 0);
    this.varint(n);
    return this;
  }

  /** A bytes, string or embedded message field; left out when empty unless `always`. */
  bytes(no: number, value: Uint8Array | string | undefined, always = false): this {
    const b = typeof value === 'string' ? new TextEncoder().encode(value) : (value ?? new Uint8Array(0));
    if (b.length === 0 && !always) return this;
    this.tag(no, 2);
    this.varint(b.length);
    for (const x of b) this.parts.push(x);
    return this;
  }

  /** An embedded message (always written: an empty one still says which `oneof` member it is). */
  message(no: number, inner: ProtoWriter | Uint8Array): this {
    return this.bytes(no, inner instanceof ProtoWriter ? inner.finish() : inner, true);
  }

  /** `repeated uint32`, packed (proto3's default). */
  packed(no: number, values: readonly number[]): this {
    if (values.length === 0) return this;
    const inner = new ProtoWriter();
    for (const v of values) inner.varint(v >>> 0 === v ? v : Number.NaN);
    return this.bytes(no, inner.finish(), true);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** The fields of one message, by number. */
export class ProtoMessage {
  private constructor(private readonly fields: Field[]) {}

  static parse(bytes: Uint8Array): ProtoMessage {
    const fields: Field[] = [];
    let at = 0;
    const varint = (): number => {
      let v = 0;
      let mul = 1;
      for (let i = 0; i < 10; i++) {
        if (at >= bytes.length) throw badProto('truncated');
        const b = bytes[at++]!;
        v += (b & 0x7f) * mul;
        if (!(b & 0x80)) {
          if (!Number.isSafeInteger(v)) throw badProto('a number too large');
          return v;
        }
        mul *= 128;
      }
      throw badProto('a varint too long');
    };
    while (at < bytes.length) {
      const key = varint();
      const no = Math.floor(key / 8);
      const wire = key % 8;
      if (no === 0) throw badProto('field 0');
      if (wire === 0) fields.push({ no, wire, value: varint() });
      else if (wire === 2) {
        const n = varint();
        if (at + n > bytes.length) throw badProto('truncated');
        fields.push({ no, wire, value: bytes.slice(at, at + n) });
        at += n;
      } else if (wire === 5) at += 4;
      else if (wire === 1) at += 8;
      else throw badProto(`wire type ${wire}`);
      if (at > bytes.length) throw badProto('truncated');
    }
    return new ProtoMessage(fields);
  }

  has(no: number): boolean {
    return this.fields.some((f) => f.no === no);
  }

  uint(no: number): number {
    const f = this.fields.filter((x) => x.no === no).at(-1);
    if (!f) return 0;
    if (f.wire !== 0) throw badProto(`field ${no} is not a number`);
    return f.value as number;
  }

  bool(no: number): boolean {
    return this.uint(no) !== 0;
  }

  bytes(no: number): Uint8Array {
    const f = this.fields.filter((x) => x.no === no).at(-1);
    if (!f) return new Uint8Array(0);
    if (f.wire !== 2) throw badProto(`field ${no} is not bytes`);
    return f.value as Uint8Array;
  }

  string(no: number): string {
    return new TextDecoder().decode(this.bytes(no));
  }

  message(no: number): ProtoMessage | undefined {
    return this.has(no) ? ProtoMessage.parse(this.bytes(no)) : undefined;
  }

  repeatedBytes(no: number): Uint8Array[] {
    return this.fields.filter((x) => x.no === no && x.wire === 2).map((x) => x.value as Uint8Array);
  }

  /** `repeated uint32`, packed or not. */
  repeatedUint(no: number): number[] {
    const out: number[] = [];
    for (const f of this.fields.filter((x) => x.no === no)) {
      if (f.wire === 0) {
        out.push(f.value as number);
        continue;
      }
      const b = f.value as Uint8Array;
      let v = 0;
      let mul = 1;
      for (const byte of b) {
        v += (byte & 0x7f) * mul;
        mul *= 128;
        if (!(byte & 0x80)) {
          out.push(v);
          v = 0;
          mul = 1;
        }
      }
      if (mul !== 1) throw badProto(`a truncated list in field ${no}`);
    }
    return out;
  }

  /** The number of the first field present among `nos` (which `oneof` member it is). */
  which(nos: readonly number[]): number | undefined {
    return this.fields.find((f) => nos.includes(f.no))?.no;
  }
}

function badProto(why: string): HardwareError {
  return new HardwareError('invalid-response', `The BitBox02 sent a message Trikey cannot read (${why}).`, { kind: KIND });
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages

/** `BTCCoin` (btc.proto). */
export const BtcCoin = { BTC: 0, TBTC: 1, RBTC: 4 } as const;
export type BtcCoinValue = (typeof BtcCoin)[keyof typeof BtcCoin];

/** `BTCPubRequest.XPubType`. */
export const XPubType = { TPUB: 0, XPUB: 1 } as const;

/** `BTCScriptConfig.SimpleType`. */
export const SimpleType = { P2WPKH_P2SH: 0, P2WPKH: 1 } as const;

/** `BTCOutputType`. */
export const OutputType = { P2PKH: 1, P2SH: 2, P2WPKH: 3, P2WSH: 4, P2TR: 5, OP_RETURN: 6 } as const;

/** `BTCSignNextResponse.Type`. */
export const NextType = { INPUT: 0, OUTPUT: 1, DONE: 2, PREVTX_INIT: 3, PREVTX_INPUT: 4, PREVTX_OUTPUT: 5, HOST_NONCE: 6, PAYMENT_REQUEST: 7 } as const;

/** `XPub` (common.proto). */
export interface XPubFields {
  depth: number;
  parentFingerprint: Uint8Array;
  childNum: number;
  chainCode: Uint8Array;
  publicKey: Uint8Array;
}

export function xpubMessage(x: XPubFields): ProtoWriter {
  return new ProtoWriter()
    .bytes(1, new Uint8Array([x.depth]))
    .bytes(2, x.parentFingerprint)
    .uint(3, x.childNum)
    .bytes(4, x.chainCode)
    .bytes(5, x.publicKey);
}

/** `BTCScriptConfig` with `multisig` (P2WSH): Trikey's 2-of-3. */
export function multisigConfig(m: { threshold: number; xpubs: XPubFields[]; ourIndex: number }): ProtoWriter {
  const ms = new ProtoWriter().uint(1, m.threshold);
  for (const x of m.xpubs) ms.message(2, xpubMessage(x));
  ms.uint(3, m.ourIndex).uint(4, 0 /* P2WSH */);
  return new ProtoWriter().message(2, ms);
}

/** `BTCScriptConfig` with `simple_type`. */
export function simpleConfig(type: number): ProtoWriter {
  return new ProtoWriter().uint(1, type, true);
}

/** `BTCScriptConfigWithKeypath`. */
export function configWithKeypath(config: ProtoWriter, keypath: readonly number[]): ProtoWriter {
  return new ProtoWriter().message(2, config).packed(3, keypath);
}

/** `Request` (hww.proto) with one member set. */
function request(no: number, inner: ProtoWriter): Uint8Array {
  return new ProtoWriter().message(no, inner).finish();
}

/** `Request.btc` = `BTCRequest` with one member set. */
function btcRequest(no: number, inner: ProtoWriter): Uint8Array {
  return request(25, new ProtoWriter().message(no, inner));
}

export const Requests = {
  /** `RootFingerprintRequest` (24). */
  fingerprint: () => request(24, new ProtoWriter()),
  /** `BTCPubRequest` (8) for an xpub. */
  xpub: (coin: number, keypath: readonly number[], xpubType: number, display: boolean) =>
    request(8, new ProtoWriter().uint(1, coin).packed(2, keypath).uint(3, xpubType, true).uint(5, display)),
  /** `BTCPubRequest` (8) for an address of a script config. */
  address: (coin: number, keypath: readonly number[], config: ProtoWriter, display: boolean) =>
    request(8, new ProtoWriter().uint(1, coin).packed(2, keypath).message(4, config).uint(5, display)),
  /** `BTCRequest.is_script_config_registered` (1): `BTCScriptConfigRegistration {coin, script_config, keypath}`. */
  isRegistered: (coin: number, config: ProtoWriter, keypath: readonly number[]) =>
    btcRequest(1, new ProtoWriter().message(1, new ProtoWriter().uint(1, coin).message(2, config).packed(3, keypath))),
  /** `BTCRequest.register_script_config` (2), xpubs shown as xpub/tpub (`AUTO_XPUB_TPUB` = 1). */
  register: (coin: number, config: ProtoWriter, keypath: readonly number[], name: string) =>
    btcRequest(2, new ProtoWriter().message(1, new ProtoWriter().uint(1, coin).message(2, config).packed(3, keypath)).bytes(2, name).uint(3, 1)),
  /** `BTCSignInitRequest` (9). */
  signInit: (t: { coin: number; configs: ProtoWriter[]; version: number; numInputs: number; numOutputs: number; locktime: number }) => {
    const w = new ProtoWriter().uint(1, t.coin);
    for (const c of t.configs) w.message(2, c);
    w.uint(4, t.version).uint(5, t.numInputs).uint(6, t.numOutputs).uint(7, t.locktime).uint(8, 1 /* format unit: sat */);
    return request(9, w);
  },
  /** `BTCSignInputRequest` (10). `prevOutHash` in the transaction's own byte order. */
  signInput: (i: { prevOutHash: Uint8Array; prevOutIndex: number; prevOutValue: number; sequence: number; keypath: readonly number[]; configIndex: number; hostNonceCommitment?: Uint8Array }) => {
    const w = new ProtoWriter().bytes(1, i.prevOutHash).uint(2, i.prevOutIndex).uint(3, i.prevOutValue).uint(4, i.sequence).packed(6, i.keypath).uint(7, i.configIndex);
    if (i.hostNonceCommitment) w.message(8, new ProtoWriter().bytes(1, i.hostNonceCommitment));
    return request(10, w);
  },
  /** `BTCSignOutputRequest` (11): one of the wallet's own (change), or a payment. */
  signOutput: (o: { ours: true; value: number; keypath: readonly number[]; configIndex: number } | { ours: false; value: number; type: number; payload: Uint8Array }) =>
    request(
      11,
      o.ours ? new ProtoWriter().uint(1, true).uint(3, o.value).packed(5, o.keypath).uint(6, o.configIndex) : new ProtoWriter().uint(2, o.type).uint(3, o.value).bytes(4, o.payload),
    ),
  /** `BTCRequest.prevtx_init` (3). */
  prevtxInit: (p: { version: number; numInputs: number; numOutputs: number; locktime: number }) =>
    btcRequest(3, new ProtoWriter().uint(1, p.version).uint(2, p.numInputs).uint(3, p.numOutputs).uint(4, p.locktime)),
  /** `BTCRequest.prevtx_input` (4). */
  prevtxInput: (p: { prevOutHash: Uint8Array; prevOutIndex: number; signatureScript: Uint8Array; sequence: number }) =>
    btcRequest(4, new ProtoWriter().bytes(1, p.prevOutHash).uint(2, p.prevOutIndex).bytes(3, p.signatureScript).uint(4, p.sequence)),
  /** `BTCRequest.prevtx_output` (5). */
  prevtxOutput: (p: { value: number; pubkeyScript: Uint8Array }) => btcRequest(5, new ProtoWriter().uint(1, p.value).bytes(2, p.pubkeyScript)),
  /** `BTCRequest.sign_message` (6): `BTCSignMessageRequest {coin, script_config, msg, host_nonce_commitment?}`. */
  signMessage: (coin: number, config: ProtoWriter, msg: Uint8Array, hostNonceCommitment?: Uint8Array) => {
    const w = new ProtoWriter().uint(1, coin).message(2, config).bytes(3, msg);
    if (hostNonceCommitment) w.message(4, new ProtoWriter().bytes(1, hostNonceCommitment));
    return btcRequest(6, w);
  },
  /** `BTCRequest.antiklepto_signature` (7): `AntiKleptoSignatureRequest {host_nonce}`. */
  antikleptoSignature: (hostNonce: Uint8Array) => btcRequest(7, new ProtoWriter().bytes(1, hostNonce)),
};

/** The firmware's error codes (`hww/api/error.rs` `make_error`). */
export const ErrorCode = { INVALID_INPUT: 101, MEMORY: 102, GENERIC: 103, USER_ABORT: 104, INVALID_STATE: 105, DISABLED: 106, DUPLICATE: 107 } as const;

/** A `Response` (hww.proto): which member it is, and its message. */
export type Response =
  | { type: 'success' }
  | { type: 'error'; code: number; message: string }
  | { type: 'pub'; pub: string }
  | { type: 'fingerprint'; fingerprint: Uint8Array }
  | { type: 'signNext'; next: SignNext }
  | { type: 'btcSuccess' }
  | { type: 'isRegistered'; registered: boolean }
  | { type: 'signMessage'; signature: Uint8Array }
  | { type: 'signerCommitment'; commitment: Uint8Array }
  | { type: 'other'; field: number };

/** `BTCSignNextResponse`. */
export interface SignNext {
  type: number;
  index: number;
  hasSignature: boolean;
  signature: Uint8Array;
  prevIndex: number;
  signerCommitment?: Uint8Array;
}

function signNext(m: ProtoMessage): SignNext {
  const ak = m.message(6);
  return {
    type: m.uint(1),
    index: m.uint(2),
    hasSignature: m.bool(3),
    signature: m.bytes(4),
    prevIndex: m.uint(5),
    ...(ak ? { signerCommitment: ak.bytes(1) } : {}),
  };
}

export function parseResponse(bytes: Uint8Array): Response {
  const m = ProtoMessage.parse(bytes);
  const which = m.which([1, 2, 5, 6, 12, 13]);
  switch (which) {
    case 1:
      return { type: 'success' };
    case 2: {
      const e = m.message(2)!;
      return { type: 'error', code: e.uint(1), message: e.string(2) };
    }
    case 5:
      return { type: 'pub', pub: m.message(5)!.string(1) };
    case 6:
      return { type: 'signNext', next: signNext(m.message(6)!) };
    case 12:
      return { type: 'fingerprint', fingerprint: m.message(12)!.bytes(1) };
    case 13: {
      const b = m.message(13)!;
      switch (b.which([1, 2, 3, 4, 5])) {
        case 1:
          return { type: 'btcSuccess' };
        case 2:
          return { type: 'isRegistered', registered: b.message(2)!.bool(1) };
        case 3:
          return { type: 'signNext', next: signNext(b.message(3)!) };
        case 4:
          return { type: 'signMessage', signature: b.message(4)!.bytes(1) };
        case 5:
          return { type: 'signerCommitment', commitment: b.message(5)!.bytes(1) };
        default:
          return { type: 'other', field: 13 };
      }
    }
    default:
      return { type: 'other', field: which ?? 0 };
  }
}
