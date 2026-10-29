import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { addChecksum } from '@trikey/core';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { HardwareError, HardwareNotSupportedError, describeHardwareError, isHardwareError, throwIfAborted } from '../errors';
import { providersFor, browserHasCamera } from '../providers';
import { deviceSignatures, makeFixture, network } from '../test/fixtures';
import { HARDENED, coinTypeOf, formatPath, parseOriginPath, parsePath } from './path';
import {
  assertDeviceSignedAll,
  assertSameTransaction,
  decodePsbtBase64,
  extractPartialSignatures,
  inputsForFingerprint,
  mergePartialSignatures,
  parsePsbtBytes,
  signaturesFromRawTransaction,
  signaturesFromSignedPsbt,
} from './psbt';
import { assertNetworkFamily, deriveWalletPubkeys, parseWalletPolicy, walletScriptsAt } from './wallet';
import { bip32VersionsFor, decodeXpub, encodeXpub, normalizeXpub, xpubFamily } from './xpub';

const H = HARDENED;

describe('derivation paths', () => {
  it('parses apostrophe, h and H, with or without m/', () => {
    const want = [48 + H, 1 + H, 0 + H, 2 + H];
    expect(parsePath("m/48'/1'/0'/2'")).toEqual(want);
    expect(parsePath('m/48h/1h/0h/2h')).toEqual(want);
    expect(parsePath('M/48H/1H/0H/2H')).toEqual(want);
    expect(parsePath("48'/1'/0'/2'")).toEqual(want);
    expect(parsePath("m/84'/0'/0'/1/15")).toEqual([84 + H, 0 + H, 0 + H, 1, 15]);
    expect(parsePath('m')).toEqual([]);
  });

  it('rejects malformed paths', () => {
    for (const bad of ['', 'm/', "m/48'/", 'm//1', "m/48''", 'm/x', "m/-1", 'm/2147483648', "m/2147483648'", 'm/1.5']) {
      expect(() => parsePath(bad), bad).toThrowError(HardwareError);
    }
  });

  it('formats back, and finds the coin type', () => {
    expect(formatPath([48 + H, 1 + H, 0 + H, 2 + H])).toBe("m/48'/1'/0'/2'");
    expect(formatPath([48 + H, 1 + H, 0, 5], 'h')).toBe('m/48h/1h/0/5');
    expect(formatPath([])).toBe('m');
    expect(coinTypeOf([84 + H, 1 + H, 0 + H])).toBe(1);
    expect(coinTypeOf([84 + H, 0 + H])).toBe(0);
    expect(coinTypeOf([84 + H])).toBeUndefined();
    expect(coinTypeOf([84 + H, 1])).toBeUndefined();
    expect(parseOriginPath('48h/1h/0h/2h')).toEqual([48 + H, 1 + H, 0 + H, 2 + H]);
    expect(parseOriginPath('')).toEqual([]);
  });
});

describe('extended public keys', () => {
  it('round-trips and converts every SLIP-132 version to xpub or tpub', async () => {
    const f = await makeFixture();
    const tpub = f.hardwareXpub;
    const d = decodeXpub(tpub);
    expect(encodeXpub(d)).toBe(tpub);
    for (const version of [0x044a5262, 0x045f1cf6, 0x024289ef, 0x02575483, 0x043587cf]) {
      const exotic = encodeXpub({ ...d, version });
      expect(normalizeXpub(exotic)).toBe(tpub);
      expect(xpubFamily(exotic)).toBe('test');
    }
    const main = encodeXpub({ ...d, version: 0x0488b21e });
    for (const version of [0x049d7cb2, 0x04b24746, 0x0295b43f, 0x02aa7ed3, 0x0488b21e]) {
      const exotic = encodeXpub({ ...d, version });
      expect(normalizeXpub(exotic)).toBe(main);
      expect(xpubFamily(exotic)).toBe('main');
    }
    expect(normalizeXpub(`  ${tpub}\n`)).toBe(tpub);
    expect(bip32VersionsFor(tpub)).toEqual({ public: 0x043587cf, private: 0x04358394 });
    expect(bip32VersionsFor(main)).toEqual({ public: 0x0488b21e, private: 0x0488ade4 });
  });

  it('rejects private keys, bad checksums, wrong lengths and junk', async () => {
    const f = await makeFixture();
    const d = decodeXpub(f.hardwareXpub);
    expect(() => decodeXpub(encodeXpub({ ...d, version: 0x04358394 }))).toThrowError(/not an extended public key/);
    expect(() => decodeXpub(f.hardwareXpub.slice(0, -1) + (f.hardwareXpub.endsWith('a') ? 'b' : 'a'))).toThrowError(/base58check/);
    expect(() => decodeXpub('hello')).toThrowError(HardwareError);
    expect(() => decodeXpub('')).toThrowError(HardwareError);
  });

  it('known mainnet vector: BIP32 test vector 1 chain m', () => {
    const xpub = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
    const d = decodeXpub(xpub);
    expect(d.depth).toBe(0);
    expect(d.parentFingerprint).toBe(0);
    expect(Array.from(d.key.slice(0, 4))).toEqual([0x03, 0x39, 0xa3, 0x60]);
    expect(encodeXpub(d)).toBe(xpub);
  });
});

describe('the wallet as the adapters see it', () => {
  it('derives the same keys, scripts and addresses as @trikey/core', async () => {
    const f = await makeFixture();
    const wallet = parseWalletPolicy(f.policy);
    expect(wallet.keys.map((k) => k.fingerprint)).toEqual(['73c5da0a', 'b8688df1', 'f92b4e64']);
    expect(wallet.family).toBe('test');
    for (const [chain, index] of [[0, 0], [0, 7], [1, 3], [1, 100]] as const) {
      const d = f.wallet.derive(chain, index);
      const ours = walletScriptsAt(wallet, chain, index, 'regtest');
      expect(ours.address).toBe(d.address);
      expect(ours.script).toEqual(d.script);
      expect(ours.witnessScript).toEqual(d.witnessScript);
      expect(deriveWalletPubkeys(wallet, chain, index)).toEqual([d.pubkeys.app, d.pubkeys.hardware, d.pubkeys.cosigner]);
    }
    // The same keys give a different address on another network.
    expect(walletScriptsAt(wallet, 0, 0, 'signet').address).toMatch(/^tb1/);
    expect(walletScriptsAt(wallet, 0, 0, 'regtest').address).toMatch(/^bcrt1/);
  });

  it('checks the network family and the key set', async () => {
    const f = await makeFixture();
    const wallet = parseWalletPolicy(f.policy);
    expect(() => assertNetworkFamily(wallet, 'testnet')).not.toThrow();
    expect(() => assertNetworkFamily(wallet, 'bitcoin')).toThrowError(/test network/);

    const body = f.policy.descriptor.replace(/#.*$/, '');
    const mixed = addChecksum(body.replace(f.wallet.keys.app.xpub, encodeXpub({ ...decodeXpub(f.wallet.keys.app.xpub), version: 0x0488b21e })));
    expect(() => parseWalletPolicy({ name: 'x', descriptor: mixed })).toThrowError(/mixes mainnet/);
  });
});

describe('PSBT helpers', () => {
  it('decodes base64 and refuses everything else', async () => {
    const f = await makeFixture();
    expect(decodePsbtBase64(` ${f.psbtBase64}\n`)).toEqual(f.psbt);
    expect(() => decodePsbtBase64('%%%')).toThrowError(/base64/);
    expect(() => decodePsbtBase64(base64.encode(new Uint8Array([1, 2, 3, 4, 5, 6])))).toThrowError(/not a PSBT/);
    expect(() => parsePsbtBytes(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0]))).toThrowError(HardwareError);
  });

  it('merges signatures once, keeps existing ones, and refuses a different signature for the same key', async () => {
    const f = await makeFixture();
    const sigs = await deviceSignatures(f.psbtAppSigned);
    const once = mergePartialSignatures(f.psbtAppSigned, sigs);
    expect(once.merged).toBe(1);
    const twice = mergePartialSignatures(once.psbt, sigs);
    expect(twice.merged).toBe(0);
    expect(twice.psbt).toEqual(once.psbt);
    expect(extractPartialSignatures(once.psbt)).toHaveLength(2);

    // A different valid-looking signature from the same key: refused (it would not verify, or would replace a good one).
    const other = await makeFixture();
    const otherSigs = await deviceSignatures(other.psbt);
    expect(() => mergePartialSignatures(once.psbt, [{ ...sigs[0]!, signature: otherSigs[0]!.signature }])).toThrowError(HardwareError);
  });

  it('finds the inputs a device can sign, and checks it signed them all', async () => {
    const f = await makeFixture();
    const tx = parsePsbtBytes(f.psbt);
    expect(inputsForFingerprint(tx, f.hardwareFingerprint).map((i) => i.index)).toEqual([0]);
    expect(inputsForFingerprint(tx, '00000000')).toEqual([]);
    expect(() => assertDeviceSignedAll(f.psbt, f.hardwareFingerprint)).toThrowError(/did not sign input 0/);
    expect(() => assertDeviceSignedAll(f.psbt, '00000000')).toThrowError(/None of the inputs/);
    const signed = await hwSigner().signPsbt(f.psbt, network);
    expect(() => assertDeviceSignedAll(signed, f.hardwareFingerprint)).not.toThrow();
  });

  it('only takes signatures from a PSBT or transaction for the same transaction', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const signedOther = await hwSigner().signPsbt(other.psbtAppSigned, network);
    expect(() => assertSameTransaction(f.psbt, f.psbtAppSigned)).not.toThrow();
    expect(() => assertSameTransaction(f.psbt, signedOther)).toThrowError(/different transaction/);
    expect(() => signaturesFromSignedPsbt(f.psbt, signedOther)).toThrowError(HardwareError);

    const tx = parsePsbtBytes(signedOther);
    tx.finalize();
    const raw = tx.extract();
    expect(() => signaturesFromRawTransaction(f.psbt, raw)).toThrowError(/not the one we sent/);
    expect(() => signaturesFromRawTransaction(f.psbt, new Uint8Array([1, 2, 3]))).toThrowError(HardwareError);
  });

  it('takes the signatures out of a finalized transaction and attributes them to the right keys', async () => {
    const f = await makeFixture();
    const both = parsePsbtBytes(await hwSigner().signPsbt(f.psbtAppSigned, network));
    both.finalize();
    const sigs = signaturesFromRawTransaction(f.psbt, both.extract());
    const keys = [f.wallet.derive(0, 3).pubkeys.app, f.wallet.derive(0, 3).pubkeys.hardware].map((k) => Array.from(k).join(','));
    expect(sigs.map((s) => Array.from(s.pubkey).join(',')).sort()).toEqual(keys.sort());
    expect(mergePartialSignatures(f.psbt, sigs).merged).toBe(2);
  });
});

describe('errors', () => {
  it('carries a code and the device kind, and is recognised by isHardwareError', () => {
    const e = new HardwareError('device-locked', 'locked', { kind: 'ledger', detail: { raw: 1 } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'device-locked', kind: 'ledger', name: 'HardwareError', detail: { raw: 1 } });
    expect(isHardwareError(e)).toBe(true);
    expect(isHardwareError(e, 'device-locked')).toBe(true);
    expect(isHardwareError(e, 'timeout')).toBe(false);
    expect(isHardwareError(new Error('x'))).toBe(false);
  });

  it('HardwareNotSupportedError names the operation and the devices', () => {
    const e = new HardwareNotSupportedError('signMessage', 'no', { kind: 'qr', devices: ['Jade'] });
    expect(e).toBeInstanceOf(HardwareError);
    expect(e).toMatchObject({ code: 'not-supported', operation: 'signMessage', devices: ['Jade'], name: 'HardwareNotSupportedError' });
    expect(new HardwareNotSupportedError('x', 'y').devices).toEqual([]);
  });

  it('has a plain-language description for every code a screen shows', () => {
    expect(describeHardwareError(new HardwareError('user-rejected', 'x'))).toMatch(/rejected/);
    expect(describeHardwareError(new HardwareError('device-locked', 'x'))).toMatch(/PIN/);
    expect(describeHardwareError(new HardwareError('app-not-open', 'x'))).toMatch(/Bitcoin app/);
    expect(describeHardwareError(new HardwareError('disconnected', 'x'))).toMatch(/disconnected/);
    expect(describeHardwareError(new HardwareError('timeout', 'x'))).toMatch(/respond/);
    expect(describeHardwareError(new HardwareError('wallet-not-registered', 'x'))).toMatch(/registered/);
    expect(describeHardwareError(new HardwareError('device-error', 'the message'))).toBe('the message');
    expect(describeHardwareError(new Error('plain'))).toBe('plain');
    expect(describeHardwareError('text')).toBe('text');
  });

  it('throwIfAborted throws `cancelled` only for an aborted signal', () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    ac.abort();
    expect(() => throwIfAborted(ac.signal, 'trezor')).toThrowError(expect.objectContaining({ code: 'cancelled', kind: 'trezor' }));
  });
});

describe('providersFor', () => {
  it('offers Ledger, Trezor and QR on phones', () => {
    for (const platform of ['ios', 'android'] as const) {
      const providers = providersFor(platform);
      expect(providers.map((p) => p.kinds)).toEqual([['ledger'], ['trezor'], ['qr', 'coldcard', 'jade']]);
    }
  });

  it('offers nothing on web without a camera, and only QR with one', () => {
    expect(providersFor('web', {}, false)).toEqual([]);
    const withCamera = providersFor('web', {}, true);
    expect(withCamera).toHaveLength(1);
    expect(withCamera[0]!.kinds).toEqual(['qr', 'coldcard', 'jade']);
    expect(providersFor('windows')).toEqual([]);
  });

  it('web providers other than QR are never available', async () => {
    // The web stubs of the native providers: present, but they say no.
    const all = providersFor('ios');
    expect(await all[0]!.isAvailable()).toBe(false);
    expect(await all[1]!.isAvailable()).toBe(false);
    await expect(all[0]!.connect()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(all[1]!.connect()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('detects a browser camera from navigator.mediaDevices', () => {
    expect(browserHasCamera({ mediaDevices: { getUserMedia: () => {} } })).toBe(true);
    expect(browserHasCamera({ mediaDevices: {} })).toBe(false);
    expect(browserHasCamera({})).toBe(false);
  });
});
