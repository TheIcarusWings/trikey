/**
 * Message signing over text QR (message.ts) and the QR model in the connect flow: the request each model scans, the
 * answers devices give (bare base64, Coldcard's armored block with or without an address, garbage, uncompressed keys),
 * the checks against the expected key and text, and the model hint a key export carries. Throwaway keys only.
 */
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { CryptoHDKey, CryptoKeypath, CryptoMultiAccounts, PathComponent } from '@keystonehq/bc-ur-registry';
import { QR_MODELS, QR_MODEL_INFO } from '@trikey/wallet';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { signMessage as signBip137 } from '../../../../../packages/wallet/src/bip137';
import { makeFixture, network } from '../test/fixtures';
import { decodeXpub } from '../common/xpub';
import { QrBridge, type QrScanRequest } from './bridge';
import { encodeBbqr } from './bbqr';
import { detectQrModel } from './export';
import { QrFrameAssembler } from './frames';
import { checkMessageAnswer, messageAddresses, parseMessageAnswer, signMessageRequest } from './message';
import { QrProvider } from './provider';
import type { QrPayload } from './types';

const AUTH_TEST = "m/48'/1'/0'/2'/0/0";
const TEXT = 'Trikey labels key v1 wallet=0123456789abcdef network=regtest';
const key = () => hwSigner().master(network).derive(AUTH_TEST);
const text = (t: string): QrPayload => ({ type: 'text', text: t });
const armored = (msg: string, lines: string[]) => [`-----BEGIN BITCOIN SIGNED MESSAGE-----`, msg, `-----BEGIN BITCOIN SIGNATURE-----`, ...lines, `-----END BITCOIN SIGNATURE-----`].join('\n');

describe('the request QR', () => {
  it.each(QR_MODELS.filter((m) => QR_MODEL_INFO[m].signsMessages))('%s scans "signmessage <path with h> ascii:<text>"', () => {
    // Every firmware read (Coldcard, Jade, Keystone, Passport Prime, Specter) parses the same line with `h` steps.
    expect(signMessageRequest(AUTH_TEST, TEXT)).toBe(`signmessage m/48h/1h/0h/2h/0/0 ascii:${TEXT}`);
    expect(signMessageRequest("m/48'/0'/0'/2'/0/0", 'x y')).toBe('signmessage m/48h/0h/0h/2h/0/0 ascii:x y');
    expect(signMessageRequest('m/48h/1h/4h/2h/0/0', TEXT)).toBe(`signmessage m/48h/1h/4h/2h/0/0 ascii:${TEXT}`);
  });

  it('fits in one QR (at most about 280 characters) and refuses text that is not printable ASCII on one line', () => {
    expect(signMessageRequest(AUTH_TEST, 'a'.repeat(240)).length).toBeLessThanOrEqual(280);
    expect(() => signMessageRequest(AUTH_TEST, 'two\nlines')).toThrow(/printable ASCII/);
    expect(() => signMessageRequest(AUTH_TEST, 'café')).toThrow(/printable ASCII/);
  });
});

describe('the answer QR', () => {
  const sig = () => signBip137(TEXT, key().privateKey!);
  const { p2pkh, others } = messageAddresses(key().publicKey!, 'regtest');

  it('a bare base64 signature (any whitespace around it)', () => {
    expect(parseMessageAnswer(text(`  ${sig()}\n`))).toEqual({ signature: sig() });
  });

  it("Coldcard's armored block, with the address, with an Address: line, or without one", () => {
    expect(parseMessageAnswer(text(armored(TEXT, [p2pkh, sig()])))).toEqual({ signature: sig(), address: p2pkh, message: TEXT });
    expect(parseMessageAnswer(text(armored(TEXT, ['Version: 1', `Address: ${p2pkh}`, sig()])))).toEqual({ signature: sig(), address: p2pkh, message: TEXT });
    expect(parseMessageAnswer(text(armored(TEXT, [sig()]).replace(/\n/g, '\r\n')))).toEqual({ signature: sig(), message: TEXT });
    // From BBQr too (a Coldcard Q may wrap a long answer).
    const frames = encodeBbqr(new TextEncoder().encode(armored(TEXT, [p2pkh, sig()])), 'U');
    const a = new QrFrameAssembler();
    let payload: QrPayload | undefined;
    for (const f of frames) {
      const step = a.receive(f);
      if (step.done) payload = step.payload;
    }
    expect(parseMessageAnswer(payload!)).toMatchObject({ signature: sig(), address: p2pkh });
  });

  it('refuses garbage, a cut armored block, a UR, and an uncompressed-key signature', () => {
    expect(() => parseMessageAnswer(text('hello'))).toThrow(/not a message signature/);
    expect(() => parseMessageAnswer(text(base64.encode(new Uint8Array(64).fill(1))))).toThrow(/not a message signature/);
    expect(() => parseMessageAnswer(text(`-----BEGIN BITCOIN SIGNED MESSAGE-----\n${TEXT}\n`))).toThrow(/incomplete/);
    expect(() => parseMessageAnswer(text(armored(TEXT, [p2pkh])))).toThrow(/no signature/);
    expect(() => parseMessageAnswer({ type: 'ur', urType: 'crypto-psbt', cbor: new Uint8Array([0x40]) })).toThrow(/plain QR code/);
    expect(() => parseMessageAnswer({ type: 'bbqr', fileType: 'P', data: new Uint8Array(3) })).toThrow(/not a message signature/);
    const raw = base64.decode(sig());
    raw[0] = 27;
    expect(() => parseMessageAnswer(text(base64.encode(raw)))).toThrow(/uncompressed key/);
    raw[0] = 50;
    expect(() => parseMessageAnswer(text(base64.encode(raw)))).toThrow(/unknown header/);
  });

  it('checks the signature against the expected key, the text and the address the device names', () => {
    const expected = { text: TEXT, pubkey: key().publicKey!, network: 'regtest' as const, path: AUTH_TEST, label: 'Coldcard Q' };
    expect(checkMessageAnswer({ signature: sig() }, expected)).toBe(sig());
    // Native and nested segwit addresses of the same key are fine too (some firmware prints those).
    for (const address of [p2pkh, ...others]) expect(checkMessageAnswer({ signature: sig(), address, message: TEXT }, expected)).toBe(sig());
    expect(() => checkMessageAnswer({ signature: sig(), message: `${TEXT}!` }, expected)).toThrow(/signed a different text/);
    const wrong = hwSigner().master(network).derive("m/84'/1'/0'/0/0");
    const wrongSig = signBip137(TEXT, wrong.privateKey!);
    expect(() => checkMessageAnswer({ signature: wrongSig, address: messageAddresses(wrong.publicKey!, 'regtest').p2pkh }, expected)).toThrow(/signed with another key/);
    expect(() => checkMessageAnswer({ signature: wrongSig }, { ...expected, account: 0 })).toThrow(/not from this wallet.s key m\/48'\/1'\/0'\/2'\/0\/0.*from account 0.*text was not changed/);
    // The same key, but for another text: it does not verify.
    expect(() => checkMessageAnswer({ signature: signBip137('other', key().privateKey!) }, expected)).toThrow(/not from this wallet/);
  });
});

describe('the model a key export names', () => {
  const ACCOUNT = [48, 1, 0, 2];
  async function hdKey(opts: { name?: string; note?: string } = {}) {
    const f = await makeFixture();
    const x = decodeXpub(f.hardwareXpub);
    const origin = new CryptoKeypath(ACCOUNT.map((n) => new PathComponent({ index: n, hardened: true })), Buffer.from(f.hardwareFingerprint, 'hex'));
    return {
      f,
      hd: new CryptoHDKey({ isMaster: false, key: Buffer.from(x.key), chainCode: Buffer.from(x.chainCode), origin, parentFingerprint: Buffer.alloc(4), name: opts.name, note: opts.note }),
    };
  }

  it('Coldcard Q: its JSON export as BBQr; not the same JSON as plain text (Passport shows that too)', async () => {
    const f = await makeFixture();
    const json = JSON.stringify({ xfp: f.hardwareFingerprint, p2wsh_deriv: "m/48'/1'/0'/2'", p2wsh: f.hardwareXpub });
    expect(detectQrModel({ type: 'bbqr', fileType: 'J', data: new TextEncoder().encode(json) })).toBe('coldcard-q');
    expect(detectQrModel({ type: 'text', text: json })).toBeUndefined();
    expect(detectQrModel({ type: 'bbqr', fileType: 'J', data: new TextEncoder().encode('not json') })).toBeUndefined();
  });

  it('Keystone: the device name in crypto-multi-accounts; a brand in a crypto-hdkey name; nothing otherwise', async () => {
    const { f, hd } = await hdKey();
    const multi = new CryptoMultiAccounts(Buffer.from(f.hardwareFingerprint, 'hex'), [hd], 'Keystone 3 Pro');
    expect(detectQrModel({ type: 'ur', urType: 'crypto-multi-accounts', cbor: new Uint8Array(multi.toCBOR()) })).toBe('keystone-3');
    const named = (await hdKey({ name: 'SeedSigner' })).hd;
    expect(detectQrModel({ type: 'ur', urType: 'crypto-hdkey', cbor: new Uint8Array(named.toCBOR()) })).toBe('seedsigner');
    expect(detectQrModel({ type: 'ur', urType: 'crypto-hdkey', cbor: new Uint8Array(hd.toCBOR()) })).toBeUndefined();
    expect(detectQrModel({ type: 'ur', urType: 'crypto-hdkey', cbor: new Uint8Array([1, 2, 3]) })).toBeUndefined();
  });

  it('connect: the owner’s pick wins; "Other" takes the model the export names; the Mk4 is refused', async () => {
    const f = await makeFixture();
    const json = JSON.stringify({ xfp: f.hardwareFingerprint, p2wsh_deriv: "m/48'/1'/0'/2'", p2wsh: f.hardwareXpub });
    const bbqr = encodeBbqr(new TextEncoder().encode(json), 'J');
    const connect = async (qrModel?: 'other' | 'jade' | 'coldcard-mk4') => {
      const bridge = new QrBridge();
      const provider = new QrProvider({ network: 'regtest', qr: { bridge } });
      let title = '';
      const off = bridge.subscribe(() => {
        const snap = bridge.getSnapshot();
        if (snap?.request.type === 'scan') {
          title = (snap.request as QrScanRequest).title;
          queueMicrotask(() => {
            for (const fr of bbqr) bridge.submitFrame(fr);
          });
        }
      });
      try {
        const signer = await provider.connect({ kind: 'qr', ...(qrModel ? { qrModel } : {}) });
        return { info: signer.info, title };
      } finally {
        off();
      }
    };
    expect(await connect('other')).toMatchObject({ info: { kind: 'qr', qrModel: 'coldcard-q', model: 'Coldcard Q' } });
    expect(await connect()).toMatchObject({ info: { qrModel: 'coldcard-q' } });
    expect(await connect('jade')).toMatchObject({ info: { qrModel: 'jade', model: 'Jade / Jade Plus' }, title: 'Connect your Jade / Jade Plus' });
    await expect(connect('coldcard-mk4')).rejects.toMatchObject({ code: 'not-supported', message: expect.stringMatching(/no camera/) });
  });
});

