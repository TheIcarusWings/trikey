/**
 * The NDEF codec (ndef.ts), record type by record type, checked against a port of Coldcard's own NDEF code
 * (`shared/ndef.py`: `ndefMaker`, `ccfile_decode`, `record_parser`, in ../test/fake-coldcard-nfc.ts): what the phone writes
 * the Coldcard parses, and what the Coldcard shares the phone parses.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { ColdcardNdef, ccfileDecode, recordParser, CC_WR_FILE } from '../test/fake-coldcard-nfc';
import { TNF, decodeNdefMessage, encodeNdefMessage, externalRecord, mimeRecord, readTextRecord, recordTypeName, textRecord, type NdefRecord } from './ndef';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** The NDEF message inside a Coldcard's tag memory. */
function messageOf(image: Uint8Array): Uint8Array {
  const cc = ccfileDecode(image);
  return image.slice(cc.start, cc.start + cc.length);
}

describe('records, one type at a time', () => {
  it('text (urn:nfc:wkt:T): UTF-8, language "en", byte for byte what Coldcard writes', () => {
    const r = textRecord('signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1');
    expect(r.tnf).toBe(TNF.WELL_KNOWN);
    expect(dec(r.type)).toBe('T');
    expect(Array.from(r.payload.subarray(0, 3))).toEqual([0x02, 0x65, 0x6e]);
    expect(recordTypeName(r)).toBe('urn:nfc:wkt:T');
    expect(readTextRecord(r)).toBe('signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1');
    const cc = new ColdcardNdef();
    cc.addText('signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1');
    expect(hex.encode(messageOf(cc.bytes()))).toBe(hex.encode(encodeNdefMessage([r])));
  });

  it('external type (urn:nfc:ext:bitcoin.org:psbt), short and long', () => {
    for (const size of [32, 255, 256, 7000]) {
      const payload = new Uint8Array(size).map((_, i) => i & 0xff);
      const r = externalRecord('bitcoin.org:psbt', payload);
      expect(recordTypeName(r)).toBe('urn:nfc:ext:bitcoin.org:psbt');
      const bytes = encodeNdefMessage([r]);
      // Short record (SR, one length byte) up to 255 bytes, four length bytes above.
      expect(bytes[0]).toBe(size <= 255 ? 0xd4 : 0xc4);
      expect(bytes.length).toBe(2 + (size <= 255 ? 1 : 4) + 16 + size);
      const [back] = decodeNdefMessage(bytes);
      expect(back).toEqual({ tnf: TNF.EXTERNAL, type: enc('bitcoin.org:psbt'), payload });
      expect(recordParser(bytes)).toEqual([{ urn: 'urn:nfc:ext:bitcoin.org:psbt', payload }]);
    }
  });

  it('MIME type (application/json), as Coldcard shares its key export', () => {
    const json = enc('{"xfp": "0F056943", "p2wsh_deriv": "m/48h/1h/0h/2h"}');
    const cc = new ColdcardNdef();
    cc.addMimeData('application/json', json);
    const [r] = decodeNdefMessage(messageOf(cc.bytes()));
    expect(recordTypeName(r!)).toBe('application/json');
    expect(r!.payload).toEqual(json);
    expect(encodeNdefMessage([mimeRecord('application/json', json)])).toEqual(messageOf(cc.bytes()));
  });

  it('several records: MB on the first, ME on the last, in order (a signed PSBT as Coldcard shares it)', () => {
    const psbt = new Uint8Array(600).fill(7);
    psbt.set([0x70, 0x73, 0x62, 0x74, 0xff]);
    const cc = new ColdcardNdef();
    cc.addText('Partly signed PSBT');
    cc.addCustom('bitcoin.org:sha256', new Uint8Array(32).fill(1));
    cc.addCustom('bitcoin.org:psbt', psbt);
    const records = decodeNdefMessage(messageOf(cc.bytes()));
    expect(records.map(recordTypeName)).toEqual(['urn:nfc:wkt:T', 'urn:nfc:ext:bitcoin.org:sha256', 'urn:nfc:ext:bitcoin.org:psbt']);
    expect(readTextRecord(records[0]!)).toBe('Partly signed PSBT');
    expect(records[2]!.payload).toEqual(psbt);
    // And the other way: the phone's encoding of the same records is what Coldcard's parser reads.
    const mine = encodeNdefMessage(records);
    expect(recordParser(mine).map((r) => r.urn)).toEqual(['urn:nfc:wkt:T', 'urn:nfc:ext:bitcoin.org:sha256', 'urn:nfc:ext:bitcoin.org:psbt']);
    expect(Array.from(mine.slice(0, 1))).toEqual([0x91]); // MB | SR | well-known
  });

  it('a record id round-trips; other well-known records are not text', () => {
    const r: NdefRecord = { tnf: TNF.WELL_KNOWN, type: enc('U'), payload: Uint8Array.from([0x04, ...enc('example.com')]), id: enc('a') };
    expect(decodeNdefMessage(encodeNdefMessage([r]))).toEqual([r]);
    expect(readTextRecord(r)).toBeUndefined();
  });

  it("reads the NXP example in Coldcard's notes (a type 2 capability container with a URI record)", () => {
    const image = hex.decode('e1408009' + '0310' + 'd1010c55016e78702e636f6d2f6e6663' + 'fe00');
    const [r] = decodeNdefMessage(messageOf(image));
    expect(recordTypeName(r!)).toBe('urn:nfc:wkt:U');
    expect(dec(r!.payload.subarray(1))).toBe('nxp.com/nfc');
  });
});

describe('the tag memory around the message (the phone OS’s job; checked here against Coldcard’s)', () => {
  it('what the Coldcard shares is read-only, 8 KiB; what it offers to be written is writable and empty', () => {
    const cc = new ColdcardNdef();
    cc.addText('x');
    expect(ccfileDecode(cc.bytes())).toMatchObject({ writable: false, size: 4096 });
    expect(ccfileDecode(Uint8Array.from(CC_WR_FILE))).toMatchObject({ writable: true, length: 0 });
  });

  it('a long message uses the three-byte TLV length', () => {
    const cc = new ColdcardNdef();
    cc.addCustom('bitcoin.org:psbt', new Uint8Array(1000));
    const image = cc.bytes();
    expect(Array.from(image.subarray(8, 12))).toEqual([0x03, 0xff, (1000 + 6 + 16) >> 8, (1000 + 6 + 16) & 0xff]);
    expect(image[image.length - 1]).toBe(0xfe);
  });
});

describe('malformed messages are refused with a message fit to show', () => {
  const good = encodeNdefMessage([textRecord('hello'), externalRecord('bitcoin.org:sha256', new Uint8Array(32))]);

  it('empty, truncated anywhere, or with no message end', () => {
    expect(() => decodeNdefMessage(new Uint8Array())).toThrow(/empty/);
    for (let cut = 1; cut < good.length; cut++) expect(() => decodeNdefMessage(good.slice(0, cut)), `cut at ${cut}`).toThrow(/cut short|no message end/);
    const noEnd = encodeNdefMessage([textRecord('hello')]);
    noEnd[0] = noEnd[0]! & ~0x40;
    expect(() => decodeNdefMessage(noEnd)).toThrow(/no message end/);
  });

  it('chunked records, a missing message begin, a second begin, a reserved type', () => {
    const chunked = good.slice();
    chunked[0] = chunked[0]! | 0x20;
    expect(() => decodeNdefMessage(chunked)).toThrow(/Chunked/);
    const noBegin = good.slice();
    noBegin[0] = noBegin[0]! & ~0x80;
    expect(() => decodeNdefMessage(noBegin)).toThrow(/does not start/);
    const twoBegins = good.slice();
    const second = 3 + 1 + 1 + 2 + 5 + 1 - 1; // header(1) type len(1) payload len(1) type(1) payload(1+2+5)
    twoBegins[second] = twoBegins[second]! | 0x80;
    expect(() => decodeNdefMessage(twoBegins)).toThrow(/second message start/);
    const reserved = good.slice();
    reserved[0] = (reserved[0]! & ~0x07) | 0x07;
    expect(() => decodeNdefMessage(reserved)).toThrow(/reserved/);
  });

  it('a UTF-16 or broken text record', () => {
    const r = textRecord('hello');
    expect(() => readTextRecord({ ...r, payload: Uint8Array.from([0x82, 0x65, 0x6e, 0, 0x68]) })).toThrow(/UTF-16/);
    expect(() => readTextRecord({ ...r, payload: Uint8Array.from([0x05, 0x65]) })).toThrow(/cut short/);
    expect(() => readTextRecord({ ...r, payload: Uint8Array.from([0x02, 0x65, 0x6e, 0xff, 0xfe]) })).toThrow(/UTF-8/);
  });

  it('the encoder refuses what it cannot write', () => {
    expect(() => encodeNdefMessage([])).toThrow(/at least one record/);
    expect(() => encodeNdefMessage([{ tnf: 7, type: new Uint8Array(), payload: new Uint8Array() }])).toThrow(/type name format/);
  });
});
