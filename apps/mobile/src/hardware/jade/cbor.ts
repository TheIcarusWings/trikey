/**
 * The small part of CBOR (RFC 8949) that Jade's RPC uses: maps with text keys, arrays, text and byte strings, unsigned
 * and negative integers, booleans and null. Jade's firmware encodes with tinycbor, always with definite lengths
 * (`main/process/process_utils.c`, `main/utils/cbor_rpc.c`); the client in `jadepy/jade.py` uses `cbor2`.
 *
 * Messages arrive over Bluetooth in pieces with nothing that says where one ends, as the firmware itself reads them
 * (`main/wire.c` `get_msg_len`: "parse a valid CBOR message from the buffer", else wait for more), so the decoder tells
 * a message that is cut short (`CborIncomplete`: wait for more bytes) from one that is wrong (`CborError`).
 *
 * Written here rather than taken from a library: about 200 lines, every branch tested (cbor.test.ts), nothing to audit
 * besides it.
 */

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

/** The bytes end before the item does: wait for more. */
export class CborIncomplete extends CborError {
  constructor() {
    super('The CBOR item is incomplete.');
    this.name = 'CborIncomplete';
  }
}

export type CborValue = null | boolean | number | string | Uint8Array | CborValue[] | { [key: string]: CborValue };

const MAX_DEPTH = 32;
/** Jade's largest reply is a few kilobytes (`MAX_OUTPUT_MSG_SIZE`, 3 KiB); nothing it sends needs more than this. */
const MAX_LENGTH = 1 << 24;

// ---- encoding ----------------------------------------------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number) {
    this.room(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  head(major: number, n: number) {
    const m = major << 5;
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >>> 8);
      this.byte(n & 0xff);
    } else if (n < 0x100000000) {
      this.byte(m | 26);
      this.byte(n >>> 24);
      this.byte((n >>> 16) & 0xff);
      this.byte((n >>> 8) & 0xff);
      this.byte(n & 0xff);
    } else {
      // Up to 2^53: high and low 32-bit halves.
      const hi = Math.floor(n / 0x100000000);
      const lo = n >>> 0;
      this.byte(m | 27);
      for (const word of [hi, lo]) {
        this.byte(word >>> 24);
        this.byte((word >>> 16) & 0xff);
        this.byte((word >>> 8) & 0xff);
        this.byte(word & 0xff);
      }
    }
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function encodeInto(w: Writer, v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new CborError('The value is nested too deeply.');
  if (v === null || v === undefined) return w.byte(0xf6);
  if (v === false) return w.byte(0xf4);
  if (v === true) return w.byte(0xf5);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new CborError(`Only whole numbers can be encoded, not ${v}.`);
    return v >= 0 ? w.head(0, v) : w.head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    w.head(3, b.length);
    return w.bytes(b);
  }
  if (v instanceof Uint8Array) {
    w.head(2, v.length);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    w.head(4, v.length);
    for (const item of v) encodeInto(w, item, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    // Fields set to undefined are left out, so optional parameters can be written inline.
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    w.head(5, entries.length);
    for (const [k, x] of entries) {
      encodeInto(w, k, depth + 1);
      encodeInto(w, x, depth + 1);
    }
    return;
  }
  throw new CborError(`A ${typeof v} cannot be encoded.`);
}

/** The CBOR encoding of `value` (maps keep their insertion order; undefined fields are left out). */
export function encodeCbor(value: unknown): Uint8Array {
  const w = new Writer();
  encodeInto(w, value, 0);
  return w.done();
}

// ---- decoding ----------------------------------------------------------------------------------------------------

class Reader {
  pos: number;
  constructor(
    private readonly b: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  byte(): number {
    if (this.pos >= this.b.length) throw new CborIncomplete();
    return this.b[this.pos++]!;
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new CborIncomplete();
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** The argument of a head byte: the value itself, or the length that follows. */
  arg(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return this.byte() * 0x100 + this.byte();
    if (info === 26) return ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
    if (info === 27) {
      const hi = ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
      const lo = ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
      if (hi >= 0x200000) throw new CborError('The number is too large.');
      return hi * 0x100000000 + lo;
    }
    if (info === 31) throw new CborError('Indefinite lengths are not used by Jade.');
    throw new CborError('Malformed CBOR (reserved length).');
  }
}

function length(r: Reader, info: number): number {
  const n = r.arg(info);
  if (n > MAX_LENGTH) throw new CborError('The CBOR item is too long.');
  return n;
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('The CBOR item is nested too deeply.');
  const head = r.byte();
  const major = head >> 5;
  const info = head & 0x1f;
  switch (major) {
    case 0:
      return r.arg(info);
    case 1:
      return -1 - r.arg(info);
    case 2:
      return r.take(length(r, info));
    case 3: {
      const bytes = r.take(length(r, info));
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new CborError('A CBOR text string is not valid UTF-8.');
      }
    }
    case 4: {
      const n = length(r, info);
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(decodeItem(r, depth + 1));
      return out;
    }
    case 5: {
      const n = length(r, info);
      const out: { [key: string]: CborValue } = {};
      for (let i = 0; i < n; i++) {
        const key = decodeItem(r, depth + 1);
        if (typeof key !== 'string') throw new CborError('A CBOR map key is not text.');
        // Own data property even for "__proto__", never the prototype.
        Object.defineProperty(out, key, { value: decodeItem(r, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 6:
      // A tag: Jade sends none; read through to the value it wraps.
      r.arg(info);
      return decodeItem(r, depth + 1);
    default:
      // Major type 7: simple values. Floats are never sent by Jade.
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 24) {
        r.byte();
        throw new CborError('Unknown CBOR simple value.');
      }
      if (info === 25 || info === 26 || info === 27) throw new CborError('Floating-point numbers are not used by Jade.');
      throw new CborError('Malformed CBOR (simple value).');
  }
}

/**
 * Decodes one CBOR item from `bytes` at `offset`. Returns it and where it ends. Throws `CborIncomplete` when the bytes
 * stop before the item does, `CborError` when they are not CBOR this decoder reads.
 */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const r = new Reader(bytes, offset);
  const value = decodeItem(r, 0);
  return { value, end: r.pos };
}
