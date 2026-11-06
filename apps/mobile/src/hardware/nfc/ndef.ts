/**
 * NDEF messages (NFC Forum Data Exchange Format), as the phone writes them to an NFC tag and reads them back: a list of
 * records, each with a type name format (TNF), a type, an optional id and a payload. Only what Coldcard's NFC uses and
 * sends is built (firmware `shared/ndef.py`, `ndefMaker`): text records (`urn:nfc:wkt:T`), NFC Forum external types
 * (`urn:nfc:ext:bitcoin.org:psbt`...) and MIME types (`application/json`). The parser takes any well-formed message,
 * refuses chunked records (as Coldcard's `record_parser` does) and checks every length against the bytes it has.
 *
 * The tag's own framing (the Type 5 capability container and the NDEF TLV around the message) is the phone's operating
 * system's business: Android's `Ndef` and iOS's `NFCNDEFTag` take and give the message alone.
 */
import { HardwareError } from '../errors';

export const TNF = {
  EMPTY: 0,
  WELL_KNOWN: 1,
  MIME: 2,
  ABSOLUTE_URI: 3,
  EXTERNAL: 4,
  UNKNOWN: 5,
  UNCHANGED: 6,
} as const;

export interface NdefRecord {
  /** Type name format, 0 to 6. */
  tnf: number;
  type: Uint8Array;
  payload: Uint8Array;
  id?: Uint8Array;
}

// Record header flags (the first byte of each record).
const MB = 0x80; // message begin
const ME = 0x40; // message end
const CF = 0x20; // chunk flag
const SR = 0x10; // short record: one byte of payload length
const IL = 0x08; // an id length byte is present

const bad = (message: string) => new HardwareError('invalid-response', message);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** The bytes of an NDEF message holding `records`, in order (MB on the first, ME on the last). */
export function encodeNdefMessage(records: readonly NdefRecord[]): Uint8Array {
  if (records.length === 0) throw new HardwareError('invalid-request', 'An NDEF message needs at least one record.');
  const parts: Uint8Array[] = [];
  records.forEach((r, i) => {
    if (!Number.isInteger(r.tnf) || r.tnf < 0 || r.tnf > 6) throw new HardwareError('invalid-request', `Bad NDEF type name format ${r.tnf}.`);
    if (r.type.length > 255 || (r.id?.length ?? 0) > 255) throw new HardwareError('invalid-request', 'NDEF type or id too long.');
    const short = r.payload.length <= 255;
    let flags = r.tnf;
    if (i === 0) flags |= MB;
    if (i === records.length - 1) flags |= ME;
    if (short) flags |= SR;
    if (r.id) flags |= IL;
    const head = [flags, r.type.length];
    if (short) head.push(r.payload.length);
    else head.push((r.payload.length >>> 24) & 0xff, (r.payload.length >>> 16) & 0xff, (r.payload.length >>> 8) & 0xff, r.payload.length & 0xff);
    if (r.id) head.push(r.id.length);
    parts.push(Uint8Array.from(head), r.type, ...(r.id ? [r.id] : []), r.payload);
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The records of an NDEF message. Throws `HardwareError('invalid-response')` on anything malformed or truncated. */
export function decodeNdefMessage(bytes: Uint8Array): NdefRecord[] {
  const records: NdefRecord[] = [];
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw bad('The NFC data is cut short. Hold the phone still against the device and try again.');
  };
  if (bytes.length === 0) throw bad('The NFC tag is empty.');
  for (;;) {
    need(2);
    const hdr = bytes[pos]!;
    const tnf = hdr & 0x07;
    if (hdr & CF) throw bad('Chunked NFC records are not supported.');
    if (records.length === 0 && !(hdr & MB)) throw bad('The NFC data does not start with a message.');
    if (records.length > 0 && hdr & MB) throw bad('The NFC data holds a second message start.');
    if (tnf === 7) throw bad('The NFC data has a reserved record type.');
    const typeLength = bytes[pos + 1]!;
    pos += 2;
    let payloadLength: number;
    if (hdr & SR) {
      need(1);
      payloadLength = bytes[pos]!;
      pos += 1;
    } else {
      need(4);
      payloadLength = ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
      pos += 4;
    }
    let idLength = 0;
    if (hdr & IL) {
      need(1);
      idLength = bytes[pos]!;
      pos += 1;
    }
    need(typeLength + idLength);
    const type = bytes.slice(pos, pos + typeLength);
    pos += typeLength;
    const id = hdr & IL ? bytes.slice(pos, pos + idLength) : undefined;
    pos += idLength;
    need(payloadLength);
    const payload = bytes.slice(pos, pos + payloadLength);
    pos += payloadLength;
    if (tnf === TNF.EMPTY && (typeLength !== 0 || payloadLength !== 0)) throw bad('An empty NFC record has content.');
    records.push({ tnf, type, payload, ...(id ? { id } : {}) });
    if (hdr & ME) break;
    if (pos >= bytes.length) throw bad('The NFC data has no message end. Hold the phone still against the device and try again.');
  }
  return records;
}

/** The record's type as Coldcard's parser names it: `urn:nfc:wkt:T`, `urn:nfc:ext:bitcoin.org:psbt`, `application/json`... */
export function recordTypeName(r: NdefRecord): string {
  const t = latin1(r.type);
  switch (r.tnf) {
    case TNF.WELL_KNOWN:
      return `urn:nfc:wkt:${t}`;
    case TNF.EXTERNAL:
      return `urn:nfc:ext:${t}`;
    case TNF.MIME:
      return t.toLowerCase();
    case TNF.ABSOLUTE_URI:
      return t;
    default:
      return '';
  }
}

/** A text record (`urn:nfc:wkt:T`), UTF-8, language `en`: what Coldcard's `ndefMaker.add_text` writes. */
export function textRecord(text: string, lang = 'en'): NdefRecord {
  const l = ascii(lang);
  if (l.length > 0x3f) throw new HardwareError('invalid-request', 'NDEF language code too long.');
  const body = new TextEncoder().encode(text);
  const payload = new Uint8Array(1 + l.length + body.length);
  payload[0] = l.length; // bit 7 clear: UTF-8
  payload.set(l, 1);
  payload.set(body, 1 + l.length);
  return { tnf: TNF.WELL_KNOWN, type: ascii('T'), payload };
}

/** The text of a text record, or undefined for any other record. UTF-16 text is refused (Coldcard writes UTF-8). */
export function readTextRecord(r: NdefRecord): string | undefined {
  if (r.tnf !== TNF.WELL_KNOWN || latin1(r.type) !== 'T') return undefined;
  if (r.payload.length === 0) return '';
  const status = r.payload[0]!;
  if (status & 0x80) throw bad('The NFC text is UTF-16, which Trikey does not read.');
  const langLength = status & 0x3f;
  if (1 + langLength > r.payload.length) throw bad('The NFC text record is cut short.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(r.payload.subarray(1 + langLength));
  } catch {
    throw bad('The NFC text is not valid UTF-8.');
  }
}

/** An NFC Forum external type record (`bitcoin.org:psbt` and the like). */
export function externalRecord(type: string, payload: Uint8Array): NdefRecord {
  return { tnf: TNF.EXTERNAL, type: ascii(type), payload };
}

/** A MIME type record (`application/json`). */
export function mimeRecord(type: string, payload: Uint8Array): NdefRecord {
  return { tnf: TNF.MIME, type: ascii(type), payload };
}
