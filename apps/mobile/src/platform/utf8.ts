// UTF-8 only TextEncoder / TextDecoder, for runtimes that lack them. Hermes in React Native 0.88
// has both, so this is a safety net: nostr-tools builds `new TextDecoder()` when its modules
// load, so a missing global would crash the app at startup. Follows the WHATWG Encoding
// Standard's UTF-8 decoder (replacement per maximal invalid subpart, `fatal`, BOM handling).
// Not supported: other encodings and the `stream` option's partial-sequence carry-over.

export class Utf8TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const s = String(input);
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    // Only whole characters may be written.
    let written = 0;
    let read = 0;
    for (const ch of source) {
      const n = this.encode(ch);
      if (written + n.length > destination.length) break;
      destination.set(n, written);
      written += n.length;
      read += ch.length;
    }
    return { read, written };
  }
}

export class Utf8TextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const l = String(label).trim().toLowerCase();
    if (l !== 'utf-8' && l !== 'utf8' && l !== 'unicode-1-1-utf-8') throw new RangeError(`unsupported encoding: ${label}`);
    this.fatal = !!options.fatal;
    this.ignoreBOM = !!options.ignoreBOM;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength);
    let out = '';
    let needed = 0;
    let seen = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    const emit = (c: number) => {
      out += c > 0xffff ? String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)) : String.fromCharCode(c);
    };
    const fail = () => {
      if (this.fatal) throw new TypeError('The encoded data was not valid UTF-8');
      out += '�';
    };

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (needed === 0) {
        if (b <= 0x7f) emit(b);
        else if (b >= 0xc2 && b <= 0xdf) {
          needed = 1;
          cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
          needed = 2;
          cp = b & 0xf;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
          needed = 3;
          cp = b & 0x7;
        } else fail();
        continue;
      }
      if (b < lower || b > upper) {
        cp = needed = seen = 0;
        lower = 0x80;
        upper = 0xbf;
        fail();
        i--; // reprocess this byte as the start of a new sequence
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (b & 0x3f);
      if (++seen === needed) {
        emit(cp);
        cp = needed = seen = 0;
      }
    }
    if (needed !== 0) fail(); // truncated sequence at the end
    if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
    return out;
  }
}
