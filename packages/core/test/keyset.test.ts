/**
 * Hosted wallets (docs/design/family-hosting.md): the key-set id both sides compute without the descriptor, the
 * hardware authorization key as "account key + tweak at 0/0", and the two shapes considered for key 3.
 */
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  KEYSET_ID_TAG,
  MultisigWallet,
  cosignerKeyExpression,
  keyExpressionFromMaster,
  keySetId,
  syntheticCosignerKeyExpression,
} from '../src/wallet.js';
import { tweakFromPath, tweakPublicKey } from '../src/tweak.js';
import { bip48Path, getNetwork } from '../src/network.js';

const network = getNetwork('regtest');
const master = (b: number) => HDKey.fromMasterSeed(new Uint8Array(32).fill(b), network.bip32);

function wallet(chainCode = new Uint8Array(32).fill(9)): MultisigWallet {
  const k3 = master(3).derive(bip48Path(network));
  return new MultisigWallet(network, {
    app: keyExpressionFromMaster(master(1), bip48Path(network)),
    hardware: keyExpressionFromMaster(master(2), bip48Path(network)),
    cosigner: cosignerKeyExpression(k3.publicKey!, chainCode, network),
  });
}

describe('keySetId', () => {
  it('hashes the tag and the three account pubkeys in role order', () => {
    const acct = wallet().accountPubkeys();
    const enc = new TextEncoder().encode(KEYSET_ID_TAG);
    const buf = new Uint8Array([...enc, ...acct.app, ...acct.hardware, ...acct.cosigner]);
    expect(keySetId(acct)).toBe(hex.encode(sha256(buf)).slice(0, 16));
    expect(keySetId(acct)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is a fixed vector (both sides must agree byte for byte)', () => {
    expect(keySetId(wallet().accountPubkeys())).toBe(KEYSET_VECTOR);
  });

  it('does not depend on chaincodes, origins or the descriptor; does depend on role order', () => {
    const a = wallet(new Uint8Array(32).fill(9));
    const b = wallet(new Uint8Array(32).fill(10));
    expect(a.fingerprint()).not.toBe(b.fingerprint());
    expect(keySetId(a.accountPubkeys())).toBe(keySetId(b.accountPubkeys()));
    const acct = a.accountPubkeys();
    expect(keySetId({ app: acct.hardware, hardware: acct.app, cosigner: acct.cosigner })).not.toBe(keySetId(acct));
  });

  it('refuses pubkeys that are not compressed', () => {
    const acct = wallet().accountPubkeys();
    expect(() => keySetId({ ...acct, app: acct.app.slice(1) })).toThrow(/33 bytes/);
  });
});

describe('hardware authorization key from the tweak at 0/0', () => {
  it('H + tweakFromPath(H, chaincode, [0,0])·G is the descriptor-derived key at <account>/0/0', () => {
    const w = wallet();
    const hw = HDKey.fromExtendedKey(w.keys.hardware.xpub, network.bip32);
    const t = tweakFromPath(hw.publicKey!, hw.chainCode!, [0, 0]);
    expect(hex.encode(tweakPublicKey(hw.publicKey!, t.tweak))).toBe(hex.encode(hw.derive('m/0/0').publicKey!));
    expect(hex.encode(t.publicKey)).toBe(hex.encode(w.derive(0, 0).pubkeys.hardware));
  });
});

describe("key 3's shape in a hosted descriptor", () => {
  const k3 = master(3).derive(bip48Path(network));
  const cc = new Uint8Array(32).fill(9);

  it('depth-0: own fingerprint, no origin, the same pubkey and chaincode', () => {
    const k = cosignerKeyExpression(k3.publicKey!, cc, network);
    const hd = HDKey.fromExtendedKey(k.xpub, network.bip32);
    expect(k.originPath).toBe('');
    expect(hd.depth).toBe(0);
    expect(k.fingerprint).toBe(hd.fingerprint.toString(16).padStart(8, '0'));
    expect(hex.encode(hd.publicKey!)).toBe(hex.encode(k3.publicKey!));
  });

  it('synthetic origin: depth 4 agreeing with its path, same pubkey and chaincode, so the same addresses', () => {
    const s = syntheticCosignerKeyExpression(k3.publicKey!, cc, network, 'deadbeef');
    const hd = HDKey.fromExtendedKey(s.xpub, network.bip32);
    expect(hd.depth).toBe(4);
    expect(s.originPath).toBe(`48h/${network.coinType}h/0h/2h`);
    const a = wallet(cc);
    const b = new MultisigWallet(network, { ...a.keys, cosigner: s });
    expect(b.derive(0, 5).address).toBe(a.derive(0, 5).address);
    expect(keySetId(b.accountPubkeys())).toBe(keySetId(a.accountPubkeys()));
    // Different descriptors (so different fingerprints): the id both sides share is the key-set id.
    expect(b.fingerprint()).not.toBe(a.fingerprint());
  });
});

const KEYSET_VECTOR = '604fe364e2c7dfff';
