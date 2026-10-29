import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { base32, base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { CryptoAccount, CryptoCoinInfo, CryptoHDKey, CryptoKeypath, CryptoOutput, CryptoPSBT, PathComponent, ScriptExpressions } from '@keystonehq/bc-ur-registry';
import { UR, UREncoder } from '@ngraveio/bc-ur';
import Xoshiro from '@ngraveio/bc-ur/dist/xoshiro';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { parsePsbt } from '@trikey/core';
import { HardwareError } from '../errors';
import { HARDENED } from '../common/path';
import { decodeXpub, encodeXpub } from '../common/xpub';
import { makeFixture, network } from '../test/fixtures';
import { BbqrFrameDecoder, encodeBbqr } from './bbqr';
import { QrFrameAssembler } from './frames';
import { describeHdKey, findExportedKey, parseDeviceExport } from './export';
import { signedFromPayload } from './payload';
import { acceptFrames } from './scan';
import { UrFrameDecoder, encodePsbtUr, encodeUrBytes, encodeUrCbor, psbtFromUr } from './ur';
import { HDKEY_VECTOR_2_CBOR_V1, HDKEY_VECTOR_2_TPUB, UR_MULTI_PART_256_FRAG_30, UR_SINGLE_PART_50 } from './ur-vectors';
import type { QrPayload } from './types';

const H = HARDENED;

function shuffled<T>(items: T[], seed = 1): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Feeds frames through the assembler the way the camera loop does and returns the payload. */
function scanAll(frames: string[]): QrPayload {
  const assembler = new QrFrameAssembler();
  for (const f of frames) {
    const step = assembler.receive(f);
    if (step.done) return step.payload;
  }
  throw new Error('the frames never completed');
}

// ------------------------------------------------------------------------------------------------ UR

describe('UR against the published reference vectors', () => {
  const message = (len: number) => Buffer.from(new Xoshiro(Buffer.from('Wolf')).nextData(len));

  it('encodes a single-part UR exactly like the reference (make_message_ur(50))', () => {
    const frames = encodeUrBytes('bytes', message(50));
    expect(frames).toEqual([UR_SINGLE_PART_50]);
  });

  it('encodes the multi-part UR exactly like the reference (make_message_ur(256), fragments of 30)', () => {
    const ur = UR.fromBuffer(message(256));
    // 9 plain frames, then fountain frames, as the reference's next_part() produces them.
    const frames = encodeUrCbor('bytes', ur.cbor, { maxFragmentLength: 30, extraFrames: UR_MULTI_PART_256_FRAG_30.length - 9 });
    expect(frames).toEqual(UR_MULTI_PART_256_FRAG_30);
    expect(frames).toEqual(Array.from({ length: 20 }, ((e) => () => e.nextPart())(new UREncoder(ur, 30))));
  });

  it('decodes the reference frames back to the message, from any order and from fountain frames alone', () => {
    const expected = Array.from(message(256));
    const decode = (frames: string[]) => {
      const d = new UrFrameDecoder();
      for (const f of frames) {
        d.receive(f);
        if (d.isComplete()) break;
      }
      expect(d.isComplete()).toBe(true);
      const result = d.result();
      expect(result.type).toBe('bytes');
      return Array.from(new UR(Buffer.from(result.cbor), 'bytes').decodeCBOR());
    };
    expect(decode(UR_MULTI_PART_256_FRAG_30)).toEqual(expected);
    expect(decode(shuffled(UR_MULTI_PART_256_FRAG_30, 7))).toEqual(expected);
    // Lose the first three plain frames: the fountain frames make up for them.
    expect(decode(UR_MULTI_PART_256_FRAG_30.slice(3))).toEqual(expected);
    // QR alphanumeric mode is uppercase: devices may show the frames in capitals.
    expect(decode(UR_MULTI_PART_256_FRAG_30.map((f) => f.toUpperCase()))).toEqual(expected);
    expect(decode([UR_SINGLE_PART_50])).toEqual(Array.from(message(50)));
  });

  it('reports progress, ignores junk and repeated frames, and refuses to give a partial result', () => {
    const d = new UrFrameDecoder();
    expect(d.receive('hello')).toBe(false);
    expect(d.receive('ur:bytes/zzz')).toBe(false);
    expect(() => d.result()).toThrowError(HardwareError);
    d.receive(UR_MULTI_PART_256_FRAG_30[0]!);
    d.receive(UR_MULTI_PART_256_FRAG_30[0]!);
    expect(d.progress().total).toBe(9);
    expect(d.progress().received).toBe(1);
    expect(d.progress().fraction).toBeGreaterThan(0);
    expect(d.progress().fraction).toBeLessThan(1);
  });
});

describe('switching to another UR halfway', () => {
  it('moves on to a different message instead of staying stuck on the first one', async () => {
    const f = await makeFixture();
    const d = new UrFrameDecoder();
    d.receive(UR_MULTI_PART_256_FRAG_30[0]!);
    d.receive(UR_MULTI_PART_256_FRAG_30[1]!);
    for (const frame of encodePsbtUr(f.psbt, { maxFragmentLength: 100 })) {
      d.receive(frame);
      if (d.isComplete()) break;
    }
    expect(d.isComplete()).toBe(true);
    expect(psbtFromUr(d.result())).toEqual(f.psbt);
  });

  it('keeps its progress when frames repeat or a junk frame comes between', () => {
    const d = new UrFrameDecoder();
    d.receive(UR_MULTI_PART_256_FRAG_30[0]!);
    d.receive(UR_MULTI_PART_256_FRAG_30[1]!);
    d.receive(UR_MULTI_PART_256_FRAG_30[1]!);
    d.receive('ur:bytes/not-a-frame');
    expect(d.progress().received).toBe(2);
  });
});

describe('crypto-psbt', () => {
  it('wraps the PSBT in a CBOR byte string and round-trips through frames of any size', async () => {
    const f = await makeFixture();
    for (const maxFragmentLength of [60, 100, 250, 2000]) {
      const frames = encodePsbtUr(f.psbt, { maxFragmentLength });
      expect(frames.every((fr) => fr.startsWith('ur:crypto-psbt/'))).toBe(true);
      const payload = scanAll(shuffled(frames, maxFragmentLength));
      if (payload.type !== 'ur') throw new Error('expected a UR');
      expect(payload.urType).toBe('crypto-psbt');
      expect(psbtFromUr({ type: payload.urType, cbor: payload.cbor })).toEqual(f.psbt);
    }
    expect(encodePsbtUr(f.psbt, { maxFragmentLength: 2000 })).toHaveLength(1);
    expect(encodePsbtUr(f.psbt, { maxFragmentLength: 100 }).length).toBeGreaterThan(5);
  });

  it('has the CBOR the registry expects: a definite-length byte string holding the PSBT', async () => {
    const f = await makeFixture();
    const frames = encodePsbtUr(f.psbt, { maxFragmentLength: 5000 });
    const payload = scanAll(frames);
    if (payload.type !== 'ur') throw new Error('expected a UR');
    // CBOR major type 2 (byte string), two-byte length for 256..65535 bytes.
    expect(f.psbt.length).toBeGreaterThan(255);
    expect(Array.from(payload.cbor.slice(0, 3))).toEqual([0x59, f.psbt.length >> 8, f.psbt.length & 255]);
    expect(payload.cbor.slice(3)).toEqual(f.psbt);
    expect(new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(payload.cbor)).getPSBT())).toEqual(f.psbt);
  });

  it('refuses another UR type, and garbage inside a crypto-psbt', () => {
    expect(() => psbtFromUr({ type: 'crypto-hdkey', cbor: new Uint8Array([0x40]) })).toThrowError(/crypto-hdkey/);
    expect(() => psbtFromUr({ type: 'crypto-psbt', cbor: new Uint8Array([0xa0]) })).toThrowError(HardwareError);
  });
});

// ------------------------------------------------------------------------------------------------ BBQr

describe('BBQr', () => {
  const sample = (n: number, seed = 3) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * (i >> 3) + (i % 7) * 13) & 255);

  it('hex encoding follows the spec: B$ H P <total> <index>, capital hex, equal blocks but the last', () => {
    const data = sample(300);
    const parts = encodeBbqr(data, 'P', { encoding: 'H', minVersion: 5, maxVersion: 7 });
    expect(parts.length).toBeGreaterThan(1);
    const total = parts.length.toString(36).toUpperCase().padStart(2, '0');
    parts.forEach((p, i) => {
      expect(p.slice(0, 8)).toBe(`B$HP${total}${i.toString(36).toUpperCase().padStart(2, '0')}`);
      expect(p.slice(8)).toMatch(/^[0-9A-F]+$/);
    });
    const body = parts.map((p) => p.slice(8));
    expect(body.join('')).toBe(hex.encode(data).toUpperCase());
    for (const b of body.slice(0, -1)) expect(b.length).toBe(body[0]!.length);
    expect(body[body.length - 1]!.length).toBeLessThanOrEqual(body[0]!.length);
    // A part decodes to a whole number of bytes.
    for (const b of body) expect(b.length % 2).toBe(0);
  });

  it('a payload that fits one QR is a single frame B$HP0100...', () => {
    const parts = encodeBbqr(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 'P', { encoding: 'H' });
    expect(parts).toEqual(['B$HP0100DEADBEEF']);
  });

  it('base32 uses the RFC 4648 alphabet without padding (RFC 4648 test vector "foobar")', () => {
    expect(encodeBbqr(new TextEncoder().encode('foobar'), 'U', { encoding: '2' })).toEqual(['B$2U0100MZXW6YTBOI']);
    expect(base32.encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI======');
  });

  it('zlib mode is raw deflate (no zlib or gzip header), then base32, as the spec requires', () => {
    const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(40));
    const parts = encodeBbqr(data, 'U', { encoding: 'Z', maxVersion: 40 });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.slice(0, 8)).toBe('B$ZU0100');
    // Decode it with node's zlib, an independent inflate implementation.
    const compressed = base32.decode(parts[0]!.slice(8) + '='.repeat((8 - (parts[0]!.length - 8) % 8) % 8));
    expect(new Uint8Array(inflateRawSync(compressed))).toEqual(data);
    expect(compressed.length).toBeLessThan(data.length / 5);
  });

  it('falls back to base32 when compression does not help', () => {
    const random = Uint8Array.from({ length: 200 }, (_, i) => (i * 167 + 13) % 251 ^ (i * 7));
    const parts = encodeBbqr(random, 'B', { encoding: 'Z', maxVersion: 40 });
    expect(parts[0]!.startsWith('B$2B') || parts[0]!.startsWith('B$ZB')).toBe(true);
  });

  it('decodes in any order, tolerates repeats and lower case, and round-trips every encoding', () => {
    const data = sample(1500);
    for (const encoding of ['H', '2', 'Z'] as const) {
      const parts = encodeBbqr(data, 'P', { encoding, minVersion: 5, maxVersion: 9 });
      expect(parts.length).toBeGreaterThan(2);
      const d = new BbqrFrameDecoder();
      const feed = [...shuffled(parts, 5), parts[0]!, parts[1]!.toLowerCase()];
      for (const p of feed) {
        d.receive(p);
        if (d.isComplete()) break;
      }
      expect(d.isComplete()).toBe(true);
      const r = d.result();
      expect(r.fileType).toBe('P');
      expect(r.data).toEqual(data);
    }
  });

  it('tracks progress and starts over when another series begins', () => {
    const a = encodeBbqr(sample(900), 'P', { encoding: 'H', minVersion: 5, maxVersion: 6 });
    const b = encodeBbqr(sample(900, 9), 'J', { encoding: 'H', minVersion: 5, maxVersion: 6 });
    const d = new BbqrFrameDecoder();
    expect(d.progress()).toEqual({ fraction: 0, received: 0, total: undefined });
    d.receive(a[0]!);
    d.receive(a[1]!);
    expect(d.progress()).toMatchObject({ received: 2, total: a.length });
    expect(d.isComplete()).toBe(false);
    d.receive(b[0]!);
    expect(d.progress()).toMatchObject({ received: 1, total: b.length });
    expect(d.receive('nonsense')).toBe(false);
    expect(d.receive('B$XP0100AA')).toBe(false);
    expect(d.receive('B$HP0105AA')).toBe(false);
    expect(() => d.result()).toThrowError(HardwareError);
  });

  it('round-trips a real PSBT', async () => {
    const f = await makeFixture();
    const payload = scanAll(shuffled(encodeBbqr(f.psbt, 'P')));
    if (payload.type !== 'bbqr') throw new Error('expected BBQr');
    expect(payload.fileType).toBe('P');
    expect(payload.data).toEqual(f.psbt);
  });
});

// ------------------------------------------------------------------------------------------------ assembler and payloads

describe('frame assembler', () => {
  it('tells UR, BBQr and bare text apart, and restarts when the kind changes', async () => {
    const f = await makeFixture();
    const ur = encodePsbtUr(f.psbt, { maxFragmentLength: 100 });
    const bbqr = encodeBbqr(f.psbt, 'P', { minVersion: 5, maxVersion: 8 });
    const a = new QrFrameAssembler();
    expect(a.receive(ur[0]!)).toMatchObject({ done: false });
    expect(a.receive(bbqr[0]!)).toMatchObject({ done: false });
    expect(a.receive('hello')).toEqual({ done: true, payload: { type: 'text', text: 'hello' } });
    let done: QrPayload | undefined;
    for (const frame of bbqr) {
      const step = a.receive(frame);
      if (step.done) done = step.payload;
    }
    expect(done).toMatchObject({ type: 'bbqr', fileType: 'P' });
  });

  it('turns converter errors into hints and keeps scanning from scratch', async () => {
    const f = await makeFixture();
    const accept = acceptFrames((p) => signedFromPayload(p));
    const hint = accept('just some text');
    expect(hint).toMatchObject({ done: false, hint: expect.stringMatching(/not a signed transaction/) });
    const frames = encodePsbtUr(f.psbt, { maxFragmentLength: 100 });
    let last = accept(frames[0]!);
    expect(last).toMatchObject({ done: false, progress: { received: 1 } });
    for (const fr of frames.slice(1)) {
      last = accept(fr);
      if (last.done) break;
    }
    expect(last).toMatchObject({ done: true, value: { kind: 'psbt' } });
  });
});

describe('signed transaction payloads', () => {
  it('reads base64 and hex PSBTs, hex transactions, BBQr P and T, and UR', async () => {
    const f = await makeFixture();
    const signed = await hwSigner().signPsbt(f.psbtAppSigned, network);
    const tx = parsePsbt(signed);
    tx.finalize();
    const raw = tx.extract();

    expect(signedFromPayload({ type: 'text', text: base64.encode(signed) })).toEqual({ kind: 'psbt', bytes: signed });
    expect(signedFromPayload({ type: 'text', text: hex.encode(signed).toUpperCase() })).toEqual({ kind: 'psbt', bytes: signed });
    expect(signedFromPayload({ type: 'text', text: hex.encode(raw) })).toEqual({ kind: 'tx', bytes: raw });
    expect(signedFromPayload({ type: 'bbqr', fileType: 'P', data: signed })).toEqual({ kind: 'psbt', bytes: signed });
    expect(signedFromPayload({ type: 'bbqr', fileType: 'T', data: raw })).toEqual({ kind: 'tx', bytes: raw });
    expect(signedFromPayload(scanAll(encodePsbtUr(signed)))).toEqual({ kind: 'psbt', bytes: signed });
  });

  it('refuses everything else', () => {
    expect(() => signedFromPayload({ type: 'text', text: 'bitcoin:bc1qxyz' })).toThrowError(/not a signed transaction/);
    expect(() => signedFromPayload({ type: 'text', text: 'abcd' })).toThrowError(HardwareError);
    expect(() => signedFromPayload({ type: 'bbqr', fileType: 'J', data: new Uint8Array() })).toThrowError(/BBQr type J/);
    expect(() => signedFromPayload({ type: 'ur', urType: 'crypto-account', cbor: new Uint8Array([0x40]) })).toThrowError(/crypto-account/);
  });
});

// ------------------------------------------------------------------------------------------------ key exports

function toRegistryHd(xpub: string, fingerprint: string, path: number[], opts: { network?: 0 | 1 } = {}): CryptoHDKey {
  const d = decodeXpub(xpub);
  const parent = Buffer.alloc(4);
  parent.writeUInt32BE(d.parentFingerprint);
  return new CryptoHDKey({
    isMaster: false,
    key: Buffer.from(d.key),
    chainCode: Buffer.from(d.chainCode),
    origin: new CryptoKeypath(
      path.map((n) => new PathComponent({ index: n >= H ? n - H : n, hardened: n >= H })),
      Buffer.from(fingerprint, 'hex'),
      path.length,
    ),
    parentFingerprint: parent,
    ...(opts.network !== undefined ? { useInfo: new CryptoCoinInfo(0, opts.network) } : {}),
  });
}

describe('public key export from a device', () => {
  it('decodes the published HDKey vector (BCR-2020-007, test vector 2) to the BIP32 string it must give', () => {
    const hd = CryptoHDKey.fromCBOR(Buffer.from(HDKEY_VECTOR_2_CBOR_V1, 'hex'));
    const described = describeHdKey(hd)!;
    expect(described.key.xpub).toBe(HDKEY_VECTOR_2_TPUB);
    expect(described.key.path).toEqual([44 + H, 1 + H, 1 + H, 0, 1]);
    expect(described.fingerprint).toBeUndefined();
    // Without a master fingerprint it is not usable as a device export.
    expect(() => parseDeviceExport({ type: 'ur', urType: 'crypto-hdkey', cbor: new Uint8Array(Buffer.from(HDKEY_VECTOR_2_CBOR_V1, 'hex')) })).toThrowError(/master fingerprint/);
  });

  it('reads crypto-hdkey, with the xpub, depth, parent fingerprint and child number rebuilt exactly', async () => {
    const f = await makeFixture();
    const hd = toRegistryHd(f.hardwareXpub, f.hardwareFingerprint, [48 + H, 1 + H, 0 + H, 2 + H]);
    const payload = scanAll(encodeUrCbor('crypto-hdkey', new Uint8Array(hd.toCBOR()), { maxFragmentLength: 60 }));
    const exp = parseDeviceExport(payload);
    expect(exp.fingerprint).toBe(f.hardwareFingerprint);
    expect(exp.keys).toEqual([{ path: [48 + H, 1 + H, 0 + H, 2 + H], xpub: f.hardwareXpub }]);
    expect(findExportedKey(exp, [48 + H, 1 + H, 0 + H, 2 + H]).xpub).toBe(f.hardwareXpub);
    expect(() => findExportedKey(exp, [84 + H, 1 + H, 0 + H])).toThrowError(/m\/48'\/1'\/0'\/2'/);
  });

  it('reads crypto-account (several accounts of one device) and picks mainnet or test from the path', async () => {
    const f = await makeFixture();
    const bip84 = toRegistryHd(f.hardwareXpub, f.hardwareFingerprint, [84 + H, 1 + H, 0 + H]);
    const bip48 = toRegistryHd(f.hardwareXpub, f.hardwareFingerprint, [48 + H, 1 + H, 0 + H, 2 + H]);
    const account = new CryptoAccount(Buffer.from(f.hardwareFingerprint, 'hex'), [
      new CryptoOutput([ScriptExpressions.WITNESS_PUBLIC_KEY_HASH], bip84),
      new CryptoOutput([ScriptExpressions.WITNESS_SCRIPT_HASH], bip48),
    ]);
    const exp = parseDeviceExport(scanAll(encodeUrCbor('crypto-account', new Uint8Array(account.toCBOR()), { maxFragmentLength: 120 })));
    expect(exp.fingerprint).toBe(f.hardwareFingerprint);
    expect(exp.keys.map((k) => k.path)).toEqual([[84 + H, 1 + H, 0 + H], [48 + H, 1 + H, 0 + H, 2 + H]]);
    expect(exp.keys.every((k) => k.xpub.startsWith('tpub'))).toBe(true);

    // A mainnet path gives an xpub.
    const main = toRegistryHd(f.hardwareXpub, f.hardwareFingerprint, [48 + H, 0 + H, 0 + H, 2 + H]);
    expect(describeHdKey(main)!.key.xpub).toMatch(/^xpub/);
  });

  it('refuses a UR that is not a key export', () => {
    expect(() => parseDeviceExport({ type: 'ur', urType: 'crypto-psbt', cbor: new Uint8Array([0x40]) })).toThrowError(/crypto-psbt/);
    expect(() => parseDeviceExport({ type: 'ur', urType: 'crypto-hdkey', cbor: new Uint8Array([0xff, 0xff]) })).toThrowError(HardwareError);
  });

  it('reads the Coldcard multisig export (SLIP-132 Vpub) as JSON text and as BBQr', async () => {
    const f = await makeFixture();
    const vpub = encodeXpub({ ...decodeXpub(f.hardwareXpub), version: 0x02575483 });
    expect(vpub).toMatch(/^Vpub/);
    const json = JSON.stringify({
      xfp: f.hardwareFingerprint.toUpperCase(),
      account: '0',
      p2sh_deriv: "m/45'",
      p2sh: vpub,
      p2sh_p2wsh_deriv: "m/48'/1'/0'/1'",
      p2sh_p2wsh: vpub,
      p2wsh_deriv: "m/48'/1'/0'/2'",
      p2wsh: vpub,
    });
    for (const payload of [{ type: 'text', text: json } as QrPayload, scanAll(encodeBbqr(new TextEncoder().encode(json), 'J'))]) {
      const exp = parseDeviceExport(payload);
      expect(exp.fingerprint).toBe(f.hardwareFingerprint);
      expect(findExportedKey(exp, [48 + H, 1 + H, 0 + H, 2 + H]).xpub).toBe(f.hardwareXpub);
    }
  });

  it('reads the Coldcard generic export and nested {deriv, xpub} objects', async () => {
    const f = await makeFixture();
    const json = JSON.stringify({
      chain: 'XTN',
      xfp: f.hardwareFingerprint.toUpperCase(),
      account: 0,
      xpub: f.hardwareXpub,
      bip44: { name: 'p2pkh', xfp: f.hardwareFingerprint.toUpperCase(), deriv: "m/44h/1h/0h", xpub: f.hardwareXpub },
      bip48_2: { name: 'p2wsh', xfp: f.hardwareFingerprint.toUpperCase(), deriv: "m/48h/1h/0h/2h", xpub: f.hardwareXpub },
    });
    const exp = parseDeviceExport({ type: 'text', text: json });
    expect(exp.keys.map((k) => k.path)).toEqual([[44 + H, 1 + H, 0 + H], [48 + H, 1 + H, 0 + H, 2 + H]]);
  });

  it('reads descriptor text with a key origin', async () => {
    const f = await makeFixture();
    const text = `[${f.hardwareFingerprint}/48h/1h/0h/2h]${f.hardwareXpub}/<0;1>/*`;
    const exp = parseDeviceExport({ type: 'text', text });
    expect(exp).toEqual({ fingerprint: f.hardwareFingerprint, keys: [{ path: [48 + H, 1 + H, 0 + H, 2 + H], xpub: f.hardwareXpub }] });
    expect(parseDeviceExport({ type: 'text', text: `wsh(sortedmulti(1,[${f.hardwareFingerprint}/48'/1'/0'/2']${f.hardwareXpub}/0/*))` }).keys).toHaveLength(1);
  });

  it('refuses exports that are ambiguous or incomplete, with a message the user can act on', async () => {
    const f = await makeFixture();
    // A bare xpub does not say whose it is.
    expect(() => parseDeviceExport({ type: 'text', text: f.hardwareXpub })).toThrowError(/fingerprint/);
    // JSON without xfp.
    expect(() => parseDeviceExport({ type: 'text', text: JSON.stringify({ p2wsh_deriv: "m/48'/1'/0'/2'", p2wsh: f.hardwareXpub }) })).toThrowError(/xfp/);
    // Keys of two devices (a full multisig descriptor).
    const two = `wsh(sortedmulti(2,[${f.hardwareFingerprint}/48h/1h/0h/2h]${f.hardwareXpub}/<0;1>/*,[11111111/48h/1h/0h/2h]${f.wallet.keys.app.xpub}/<0;1>/*))`;
    expect(() => parseDeviceExport({ type: 'text', text: two })).toThrowError(/more than one device/);
    // Not JSON, not anything.
    expect(() => parseDeviceExport({ type: 'text', text: '{oops' })).toThrowError(/JSON/);
    expect(() => parseDeviceExport({ type: 'text', text: 'hello' })).toThrowError(/not a public key export/);
    expect(() => parseDeviceExport({ type: 'bbqr', fileType: 'P', data: new Uint8Array() })).toThrowError(/BBQr type P/);
    // A private key export is refused outright.
    expect(() => describeHdKey(new CryptoHDKey({ isMaster: true, key: Buffer.alloc(33), chainCode: Buffer.alloc(32) }))).not.toThrow();
    expect(describeHdKey(new CryptoHDKey({ isMaster: true, key: Buffer.alloc(33), chainCode: Buffer.alloc(32) }))).toBeUndefined();
  });

  it('keeps a PSBT sanity check handy: our PSBT is not an export', async () => {
    const f = await makeFixture();
    expect(() => parseDeviceExport(scanAll(encodePsbtUr(f.psbt)))).toThrowError(/crypto-psbt/);
    expect(btc.Transaction.fromPSBT(f.psbt, { proprietary: 'ignore' }).inputsLength).toBe(1);
  });
});
