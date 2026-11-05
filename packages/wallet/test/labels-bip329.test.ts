/**
 * labels-bip329.ts: BIP 329 read and written, with the BIP's own test vectors, its additional fields, and every line
 * the strict reader refuses. Pure.
 */
import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { WalletError } from '../src/errors.js';
import {
  MAX_BIP329_BYTES,
  MAX_BIP329_LINE_BYTES,
  MAX_LABEL_CHARS,
  bip329Origin,
  checkBip329Record,
  normalizeOrigin,
  parseBip329,
  parseOutpoint,
  sameOrigin,
  serializeBip329,
} from '../src/labels-bip329.js';

/** The BIP's "Test Vectors" section, verbatim (bips/bip-0329.mediawiki). */
const BIP_VECTORS = [
  `{ "type": "tx", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd", "label": "Transaction", "origin": "wpkh([d34db33f/84'/0'/0'])" }`,
  `{ "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }`,
  `{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }`,
  `{ "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }`,
  `{ "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output", "spendable": false }`,
  `{ "type": "xpub", "ref": "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8", "label": "Extended Public Key" }`,
  `{ "type": "spscan", "ref": "spscan1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsq9q6qjevn2kmdrnpuxt0v6h2kr2a2epkr0g6nk55ftf0xcxtddazgkrth3e", "label": "Silent Payments Scan Key Expression" }`,
  `{ "type": "tx", "ref": "f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74", "label": "Account #1 Transaction", "origin": "wpkh([d34db33f/84'/0'/1'])" }`,
].join('\n');

const TX = 'f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd';
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const errorsOf = (text: string) => parseBip329(text).errors.map((e) => e.message);

describe('BIP 329: the test vectors', () => {
  it('reads every record of the BIP, with its types, labels, origins and the frozen output', () => {
    const r = parseBip329(BIP_VECTORS);
    expect(r.errors).toEqual([]);
    expect(r.truncated).toBe(0);
    expect(r.records.map((x) => x.type)).toEqual(['tx', 'addr', 'pubkey', 'input', 'output', 'xpub', 'spscan', 'tx']);
    expect(r.records[0]).toEqual({ type: 'tx', ref: TX, label: 'Transaction', origin: "wpkh([d34db33f/84'/0'/0'])" });
    expect(r.records[4]).toEqual({ type: 'output', ref: `${TX}:1`, label: 'Output', spendable: false });
    expect(r.records[7]!.origin).toBe("wpkh([d34db33f/84'/0'/1'])");
  });

  it('writes them back as one compact JSON object per line, in the order type, ref, label, origin, spendable', () => {
    const r = parseBip329(BIP_VECTORS);
    const out = serializeBip329(r.records);
    const lines = out.split('\n');
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(`{"type":"tx","ref":"${TX}","label":"Transaction","origin":"wpkh([d34db33f/84'/0'/0'])"}`);
    expect(lines[4]).toBe(`{"type":"output","ref":"${TX}:1","label":"Output","spendable":false}`);
    // Each line is the BIP's record, field for field.
    BIP_VECTORS.split('\n').forEach((l, i) => expect(JSON.parse(lines[i]!)).toEqual(JSON.parse(l)));
    expect(parseBip329(out).records).toEqual(r.records);
  });

  it("keeps the BIP's additional fields (and another wallet's own fields), checked and written back in their order", () => {
    const text = [
      line({ type: 'tx', ref: TX, label: 'Rent', height: 850_000, time: '2025-01-23T11:40:35Z', fee: 1_520, value: -250_000, rate: { USD: 105620.0 } }),
      line({ type: 'output', ref: `${TX}:1`, keypath: '/1/123', value: 12_345, fmv: { USD: 1233.45 }, height: 850_000, time: '2025-01-23T11:40:35Z' }),
      line({ type: 'addr', ref: 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c', heights: [], sparrow_note: { any: ['json'] } }),
    ].join('\n');
    const r = parseBip329(text);
    expect(r.errors).toEqual([]);
    expect(r.records[0]!.extra).toEqual({ height: 850_000, time: '2025-01-23T11:40:35Z', fee: 1_520, value: -250_000, rate: { USD: 105620 } });
    expect(r.records[1]!.label).toBeUndefined();
    expect(r.records[2]!.extra).toEqual({ heights: [], sparrow_note: { any: ['json'] } });
    expect(serializeBip329(r.records)).toBe(`${text}\n`);
  });
});

describe('BIP 329: strict, line by line', () => {
  it('skips each broken line with its line number, and keeps the rest', () => {
    const text = [line({ type: 'tx', ref: TX, label: 'ok' }), 'not json', '', line({ type: 'output', ref: `${TX}:0`, label: 'ok too' }), '[1,2]'].join('\n');
    const r = parseBip329(text);
    expect(r.records.map((x) => x.label)).toEqual(['ok', 'ok too']);
    expect(r.errors).toEqual([
      { line: 2, message: 'not valid JSON' },
      { line: 5, message: 'not a JSON object' },
    ]);
    expect(r.errorCount).toBe(2);
  });

  it('refuses spendable as a string (the BIP warns about "false" in quotes) and on anything but an output', () => {
    expect(errorsOf(line({ type: 'output', ref: `${TX}:1`, spendable: 'false' }))).toEqual(['spendable must be true or false (a JSON boolean, not a string)']);
    expect(errorsOf(line({ type: 'tx', ref: TX, spendable: false }))).toEqual(['spendable belongs to output records only']);
  });

  it('checks every ref by its type', () => {
    const bad = [
      { type: 'tx', ref: TX.slice(1) },
      { type: 'tx', ref: `${TX}:0` },
      { type: 'output', ref: TX },
      { type: 'output', ref: `${TX}:01` },
      { type: 'output', ref: `${TX}:4294967296` },
      { type: 'input', ref: `${TX}:-1` },
      { type: 'addr', ref: 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7d' },
      { type: 'addr', ref: 'not an address' },
      { type: 'pubkey', ref: '0583409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448' },
      { type: 'xpub', ref: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet9' },
      { type: 'spscan', ref: 'spscan1-not' },
      { type: 'tx', ref: 42 },
    ];
    const r = parseBip329(bad.map(line).join('\n'));
    expect(r.records).toEqual([]);
    expect(r.errorCount).toBe(bad.length);
  });

  it('never takes a private key in an xpub record', () => {
    const k = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
    expect(errorsOf(line({ type: 'xpub', ref: k.privateExtendedKey }))).toEqual(['an xpub ref must be an extended public key (never a private one)']);
    expect(parseBip329(line({ type: 'xpub', ref: k.publicExtendedKey })).records).toHaveLength(1);
  });

  it('checks the types of label, origin and the additional fields', () => {
    expect(errorsOf(line({ type: 'tx', ref: TX, label: 5 }))).toEqual(['label must be a string']);
    expect(errorsOf(line({ type: 'tx', ref: TX, origin: "wpkh([d34db33f/84'/0'/0'])#abcdefgh" }))).toEqual(['origin must be an abbreviated descriptor: key origins only, without a checksum']);
    expect(errorsOf(line({ type: 'tx', ref: TX, origin: '' }))).toEqual(['origin must be a descriptor of key origins']);
    expect(errorsOf(line({ type: 'tx', ref: TX, height: -1 }))).toEqual(['height must be a non-negative integer']);
    expect(errorsOf(line({ type: 'tx', ref: TX, fee: 1.5 }))).toEqual(['fee must be a non-negative integer']);
    expect(errorsOf(line({ type: 'tx', ref: TX, value: '100' }))).toEqual(['value must be an integer (sats)']);
    expect(errorsOf(line({ type: 'tx', ref: TX, time: 'yesterday' }))).toEqual(['time must be an ISO-8601 timestamp']);
    expect(errorsOf(line({ type: 'tx', ref: TX, rate: { USD: '1' } }))).toEqual(['rate must be a map of currency codes to numbers']);
    expect(errorsOf(line({ type: 'addr', ref: 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c', heights: [1, -2] }))).toEqual(['heights must be a list of block heights']);
    expect(errorsOf(line({ type: 'TX', ref: TX }))).toHaveLength(1);
    expect(errorsOf(line({ ref: TX }))).toHaveLength(1);
  });

  it('refuses a field named __proto__', () => {
    expect(errorsOf(`{"type":"tx","ref":"${TX}","__proto__":{"polluted":true}}`)).toEqual(['field __proto__ is not allowed']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps a type the BIP does not define, as read', () => {
    const r = parseBip329(line({ type: 'bolt11', ref: 'lnbc1...', label: 'Coffee', spendable: true, memo: 'x' }));
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([{ type: 'bolt11', ref: 'lnbc1...', label: 'Coffee', spendable: true, extra: { memo: 'x' } }]);
  });

  it('normalizes hex refs to lowercase', () => {
    const r = parseBip329([line({ type: 'tx', ref: TX.toUpperCase() }), line({ type: 'output', ref: `${TX.toUpperCase()}:7` })].join('\n'));
    expect(r.records.map((x) => x.ref)).toEqual([TX, `${TX}:7`]);
  });

  it(`cuts labels to ${MAX_LABEL_CHARS} characters, never inside an emoji, and counts them`, () => {
    const long = '🔥'.repeat(300);
    const r = parseBip329([line({ type: 'tx', ref: TX, label: long }), line({ type: 'tx', ref: TX, label: 'short' })].join('\n'));
    expect(r.truncated).toBe(1);
    expect(Array.from(r.records[0]!.label!)).toHaveLength(MAX_LABEL_CHARS);
    expect(r.records[0]!.label).toBe('🔥'.repeat(MAX_LABEL_CHARS));
  });

  it('accepts a byte order mark, CRLF line ends, blank lines and bytes', () => {
    const text = `﻿${line({ type: 'tx', ref: TX, label: 'a' })}\r\n\r\n   \n${line({ type: 'output', ref: `${TX}:0`, label: 'b' })}\r\n`;
    expect(parseBip329(text).records.map((x) => x.label)).toEqual(['a', 'b']);
    expect(parseBip329(new TextEncoder().encode(text)).records.map((x) => x.label)).toEqual(['a', 'b']);
  });

  it('a label with a line break stays on one line when written', () => {
    const out = serializeBip329([{ type: 'tx', ref: TX, label: 'two\nlines' }]);
    expect(out.split('\n')).toHaveLength(2);
    expect(parseBip329(out).records[0]!.label).toBe('two\nlines');
  });
});

describe('BIP 329: size limits', () => {
  it('refuses a whole file that is too large, or not UTF-8', () => {
    const big = new Uint8Array(MAX_BIP329_BYTES + 1).fill(0x20);
    expect(() => parseBip329(big)).toThrow(WalletError);
    expect(() => parseBip329(' '.repeat(MAX_BIP329_BYTES + 1))).toThrow(/larger than 8 MB/);
    try {
      parseBip329(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'labels_invalid', message: 'This labels file is not UTF-8 text.' });
    }
  });

  it('skips a line that is too long', () => {
    const r = parseBip329(line({ type: 'tx', ref: TX, label: 'x', note: 'y'.repeat(MAX_BIP329_LINE_BYTES) }));
    expect(r.errors).toEqual([{ line: 1, message: `longer than ${MAX_BIP329_LINE_BYTES} bytes` }]);
  });
});

describe('BIP 329: writing', () => {
  it('never writes a record it would refuse to read', () => {
    expect(() => serializeBip329([{ type: 'output', ref: TX }])).toThrow(/Invalid output record/);
    expect(() => serializeBip329([{ type: 'tx', ref: TX, spendable: false }])).toThrow(WalletError);
    expect(() => serializeBip329([{ type: 'tx', ref: TX, label: 'x'.repeat(MAX_LABEL_CHARS + 1) }])).toThrow(/longer than 255/);
    expect(checkBip329Record({ type: 'tx', ref: TX.toUpperCase(), label: 'ok' })).toEqual({ type: 'tx', ref: TX, label: 'ok' });
  });

  it('parseOutpoint reads txid:vout', () => {
    expect(parseOutpoint(`${TX}:3`)).toEqual({ txid: TX, vout: 3 });
    expect(parseOutpoint(`${TX}:4294967295`)).toEqual({ txid: TX, vout: 4294967295 });
    expect(parseOutpoint(`${TX}:4294967296`)).toBeUndefined();
    expect(parseOutpoint(TX)).toBeUndefined();
  });
});

describe('BIP 329: origin', () => {
  const desc =
    "wsh(sortedmulti(2,[aabbccdd/48h/1h/0h/2h]tpubDF2rnouQaaYrXF4noGTv6rQYmx87cQ4GrUdhpvXkhtChwQPbdGTi8GA88NUaSrwZBwNsTkC9bFkkC8vDyGBVVAQTZ2AS6gs68RQXtXcCvkP/<0;1>/*,[11223344/48h/1h/0h/2h]tpubDF2rnouQaaYrXF4noGTv6rQYmx87cQ4GrUdhpvXkhtChwQPbdGTi8GA88NUaSrwZBwNsTkC9bFkkC8vDyGBVVAQTZ2AS6gs68RQXtXcCvkP/<0;1>/*,[55667788]tpubDF2rnouQaaYrXF4noGTv6rQYmx87cQ4GrUdhpvXkhtChwQPbdGTi8GA88NUaSrwZBwNsTkC9bFkkC8vDyGBVVAQTZ2AS6gs68RQXtXcCvkP/<0;1>/*))";

  it("is the wallet's descriptor with key origins only (a hosted key 3 at m has its fingerprint alone)", () => {
    expect(bip329Origin(desc)).toBe("wsh(sortedmulti(2,[aabbccdd/48'/1'/0'/2'],[11223344/48'/1'/0'/2'],[55667788]))");
    expect(parseBip329(line({ type: 'tx', ref: TX, origin: bip329Origin(desc) })).errors).toEqual([]);
  });

  it("matches another wallet's spelling: h or ', key order, case, spaces", () => {
    const sparrow = "wsh(sortedmulti(2,[55667788],[11223344/48'/1'/0'/2'], [AABBCCDD/48'/1'/0'/2']))";
    expect(sameOrigin(sparrow, bip329Origin(desc))).toBe(true);
    expect(sameOrigin("wsh(sortedmulti(2,[aabbccdd/48'/1'/1'/2'],[11223344/48'/1'/0'/2'],[55667788]))", bip329Origin(desc))).toBe(false);
    expect(normalizeOrigin("wpkh([D34DB33F/84h/0H/0'])")).toBe("wpkh([d34db33f/84'/0'/0'])");
  });
});
