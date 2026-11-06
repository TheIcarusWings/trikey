/**
 * What the phone writes to a Coldcard and reads from it, record by record (coldcard.ts), checked against the port of the
 * firmware's parser and maker in ../test/fake-coldcard-nfc.ts.
 */
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { ColdcardNdef, ccfileDecode, recordParser } from '../test/fake-coldcard-nfc';
import { makeFixture } from '../test/fixtures';
import { COLDCARD_NFC_MAX_SIZE, keyExportFromNdef, messageAnswerFromNdef, messageRequest, psbtRequest, signedFromNdef, walletRequest } from './coldcard';
import { decodeNdefMessage, textRecord } from './ndef';
import { decodeXpub, encodeXpub } from '../common/xpub';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const shared = (n: ColdcardNdef) => {
  const image = n.bytes();
  const cc = ccfileDecode(image);
  return decodeNdefMessage(image.slice(cc.start, cc.start + cc.length));
};

describe('what the phone writes', () => {
  it('a PSBT: its SHA-256, then the binary PSBT, as `start_psbt_rx` looks for them', async () => {
    const f = await makeFixture();
    const parsed = recordParser(psbtRequest(f.psbt, 1));
    expect(parsed.map((r) => r.urn)).toEqual(['urn:nfc:ext:bitcoin.org:sha256', 'urn:nfc:ext:bitcoin.org:psbt']);
    expect(parsed[0]!.payload).toEqual(sha256(f.psbt));
    expect(parsed[1]!.payload).toEqual(f.psbt);
    // `psbt_encoding_taster`: binary, starting `psbt\xff`; the record is over 100 bytes, which is what it tastes.
    expect(Array.from(parsed[1]!.payload.subarray(0, 5))).toEqual([0x70, 0x73, 0x62, 0x74, 0xff]);
    expect(parsed[1]!.payload.length).toBeGreaterThan(100);
  });

  it('refuses a PSBT whose signed copy would not fit what the Coldcard shares (under 8000 bytes), and anything else', async () => {
    const f = await makeFixture();
    const big = new Uint8Array(COLDCARD_NFC_MAX_SIZE - 50);
    big.set(f.psbt);
    expect(() => psbtRequest(big, 1)).toThrow(/too large for the Coldcard's NFC.*Coin control/);
    expect(() => psbtRequest(enc('not a psbt at all, really'), 1)).toThrow(/not a PSBT/);
  });

  it('the wallet: the multisig setup file as one text record, as `import_multisig_nfc` takes it', () => {
    const file = 'Name: Trikey\nPolicy: 2 of 3\nFormat: P2WSH\n\nDerivation: m/48h/1h/0h/2h\n0F056943: tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp\n';
    const parsed = recordParser(walletRequest(file));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.urn).toBe('urn:nfc:wkt:T');
    expect(dec(parsed[0]!.payload)).toBe(file);
    expect(() => walletRequest('Name: x')).toThrow(/not a multisig setup file/);
  });

  it('a text to sign: one text record, the Sparrow `signmessage` line with h for hardened steps', () => {
    const parsed = recordParser(messageRequest("m/48'/1'/0'/2'/0/0", 'Trikey pair v1 wallet=abc'));
    expect(parsed).toEqual([{ urn: 'urn:nfc:wkt:T', payload: enc('signmessage m/48h/1h/0h/2h/0/0 ascii:Trikey pair v1 wallet=abc') }]);
    // `start_msg_sign` takes a message of 1 to 3 lines: this is one.
    expect(dec(parsed[0]!.payload).split('\n')).toHaveLength(1);
    expect(() => messageRequest("m/48'/1'/0'/2'/0/0", 'two\nlines')).toThrow(/printable ASCII/);
  });
});

describe('what the phone reads', () => {
  it('the key export: application/json (Settings › Multisig Wallets › Export XPUB), or the same JSON as text', () => {
    // A key at the account path's depth and index (the export's keys are checked against their paths).
    const tpub = encodeXpub({ ...decodeXpub('tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp'), depth: 4, childNumber: 0x80000002 });
    const json = `{"p2wsh_deriv": "m/48h/1h/0h/2h", "p2wsh": "${tpub}", "account": "0", "xfp": "0F056943"}`;
    const asJson = new ColdcardNdef();
    asJson.addMimeData('application/json', enc(json));
    expect(keyExportFromNdef(shared(asJson))).toMatchObject({ fingerprint: '0f056943', keys: [{ path: [0x80000030, 0x80000001, 0x80000000, 0x80000002] }] });
    const asText = new ColdcardNdef();
    asText.addText(json);
    expect(keyExportFromNdef(shared(asText)).fingerprint).toBe('0f056943');
  });

  it('says what to do when the Coldcard shared something else', () => {
    const psbt = new ColdcardNdef();
    psbt.addText('Partly signed PSBT');
    psbt.addCustom('bitcoin.org:psbt', new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]));
    expect(() => keyExportFromNdef(shared(psbt))).toThrow(/not a key export.*Export XPUB/);
    const addr = new ColdcardNdef();
    addr.addText('tb1qexample');
    expect(() => keyExportFromNdef(shared(addr))).toThrow(/not a public key export/);
    expect(() => keyExportFromNdef([{ tnf: 4, type: enc('bitcoin.org:txid'), payload: new Uint8Array(32) }])).toThrow(/shared urn:nfc:ext:bitcoin.org:txid, not a key export/);
  });

  it('a signed PSBT: the checksum must match; a finished transaction is taken too', () => {
    const psbt = new Uint8Array(200).fill(3);
    psbt.set([0x70, 0x73, 0x62, 0x74, 0xff]);
    const ok = new ColdcardNdef();
    ok.addText('Partly signed PSBT');
    ok.addCustom('bitcoin.org:sha256', sha256(psbt));
    ok.addCustom('bitcoin.org:psbt', psbt);
    expect(signedFromNdef(shared(ok))).toEqual({ kind: 'psbt', bytes: psbt });

    const damaged = new ColdcardNdef();
    damaged.addCustom('bitcoin.org:sha256', sha256(enc('other')));
    damaged.addCustom('bitcoin.org:psbt', psbt);
    expect(() => signedFromNdef(shared(damaged))).toThrow(/did not arrive whole/);

    const tx = new Uint8Array(120).fill(2);
    const txn = new ColdcardNdef();
    txn.addText('Signed Transaction: ab');
    txn.addCustom('bitcoin.org:txid', new Uint8Array(32));
    txn.addCustom('bitcoin.org:sha256', sha256(tx));
    txn.addCustom('bitcoin.org:txn', tx);
    expect(signedFromNdef(shared(txn))).toEqual({ kind: 'tx', bytes: tx });

    // No checksum is fine (a Coldcard always sends one, but nothing depends on it).
    expect(signedFromNdef([{ tnf: 4, type: enc('bitcoin.org:psbt'), payload: psbt }])).toEqual({ kind: 'psbt', bytes: psbt });
    expect(() => signedFromNdef([{ tnf: 4, type: enc('bitcoin.org:psbt'), payload: new Uint8Array(10) }])).toThrow(/not a PSBT/);
    expect(() => signedFromNdef([textRecord('-----BEGIN BITCOIN SIGNED MESSAGE-----\nx')])).toThrow(/signed message, not the signed payment/);
    expect(() => signedFromNdef([textRecord('hello')])).toThrow(/not a signed payment/);
  });

  it("the signature: Coldcard's armored block in a text record", () => {
    const sig = 'I' + 'A'.repeat(86) + '=';
    const armored = `-----BEGIN BITCOIN SIGNED MESSAGE-----\nTrikey pair v1\n-----BEGIN BITCOIN SIGNATURE-----\nmkHS9ne12qx9pS9VojpwU5xtRd4T7X7ZUt\n${sig}\n-----END BITCOIN SIGNATURE-----\n`;
    const n = new ColdcardNdef();
    n.addText(armored);
    expect(messageAnswerFromNdef(shared(n))).toEqual({ signature: sig, address: 'mkHS9ne12qx9pS9VojpwU5xtRd4T7X7ZUt', message: 'Trikey pair v1' });
    expect(() => messageAnswerFromNdef([textRecord('signmessage m/48h/1h/0h/2h/0/0 ascii:x')])).toThrow(/still Trikey’s request/);
    expect(() => messageAnswerFromNdef([textRecord('garbage')])).toThrow(/not a message signature/);
  });
});
