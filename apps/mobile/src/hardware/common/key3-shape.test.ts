/**
 * Decision 11 of docs/design/family-hosting.md: key 3's shape in a hosted wallet's descriptor, against every device
 * integration the app has in code. Key 3 is the hosting guardian's account pubkey under a chaincode the phone picks;
 * the two candidates are a depth-0 xpub with no origin (`[ownfp]xpub`, what the app uses) and a synthetic BIP 48 origin
 * over the same key (`[fp/48'/1'/0'/2']xpub` at depth 4). Both must give the same addresses; this checks what each
 * integration sends the device for both. What only a real device can confirm is listed in docs/alpha-test-plan.md.
 */
import { HDKey } from '@scure/bip32';
import { describe, expect, it } from 'vitest';
import { MultisigWallet, NETWORKS, bip48Path, cosignerKeyExpression, keyExpressionFromMaster, syntheticCosignerKeyExpression } from '@trikey/core';
import { toLedgerPolicy } from '../ledger/policy';
import { coldcardMultisigConfig } from '../qr/registration';
import { multisigAt } from '../trezor/convert';
import { parseWalletPolicy, walletScriptsAt } from './wallet';

const network = NETWORKS.regtest;
const master = (b: number) => HDKey.fromMasterSeed(new Uint8Array(32).fill(b), network.bip32);
const k3 = master(3).derive(bip48Path(network));
const cc = new Uint8Array(32).fill(9);
const base = { app: keyExpressionFromMaster(master(1), bip48Path(network)), hardware: keyExpressionFromMaster(master(2), bip48Path(network)) };
const depth0 = new MultisigWallet(network, { ...base, cosigner: cosignerKeyExpression(k3.publicKey!, cc, network) });
const synthetic = new MultisigWallet(network, { ...base, cosigner: syntheticCosignerKeyExpression(k3.publicKey!, cc, network, 'deadbeef') });
const policy = (w: MultisigWallet) => ({ name: 'Trikey hosted', descriptor: w.descriptor() });

describe("key 3's shape in a hosted descriptor, through every device integration", () => {
  it('both shapes give the same addresses (so either is the same wallet on chain)', () => {
    for (const [c, i] of [[0, 0], [1, 7], [0, 1000]] as const)
      expect(walletScriptsAt(parseWalletPolicy(policy(synthetic)), c, i, 'regtest').address).toBe(walletScriptsAt(parseWalletPolicy(policy(depth0)), c, i, 'regtest').address);
  });

  it('Ledger (wallet policy key info): depth-0 is "[fp]xpub", synthetic is "[fp/48\'/1\'/0\'/2\']xpub"', () => {
    const d = toLedgerPolicy(policy(depth0));
    const s = toLedgerPolicy(policy(synthetic));
    expect(d.descriptorTemplate).toBe('wsh(sortedmulti(2,@0/**,@1/**,@2/**))');
    expect(d.keys[2]).toBe(`[${depth0.keys.cosigner.fingerprint}]${depth0.keys.cosigner.xpub}`);
    expect(s.keys[2]).toBe(`[deadbeef/48'/1'/0'/2']${synthetic.keys.cosigner.xpub}`);
    // The device's own key keeps its real origin either way.
    expect(d.keys[1]).toMatch(/^\[[0-9a-f]{8}\/48'\/1'\/0'\/2'\]tpub/);
  });

  it('Trezor (multisig nodes): both send the xpub node with the [chain, index] suffix; no origin is sent for cosigners', () => {
    const d = multisigAt(parseWalletPolicy(policy(depth0)), 0, 5);
    const s = multisigAt(parseWalletPolicy(policy(synthetic)), 0, 5);
    expect(d.pubkeys.map((p) => p.address_n)).toEqual([[0, 5], [0, 5], [0, 5]]);
    expect(d.pubkeys.map((p) => p.node)).toContain(depth0.keys.cosigner.xpub);
    expect(s.pubkeys.map((p) => p.node)).toContain(synthetic.keys.cosigner.xpub);
  });

  it('Coldcard file (QR): depth-0 says "Derivation: m" for key 3, synthetic its made-up path; the fingerprints agree with the xpubs', () => {
    const d = coldcardMultisigConfig(parseWalletPolicy(policy(depth0)));
    const s = coldcardMultisigConfig(parseWalletPolicy(policy(synthetic)));
    expect(d).toContain(`Derivation: m\n${depth0.keys.cosigner.fingerprint.toUpperCase()}: ${depth0.keys.cosigner.xpub}`);
    expect(s).toContain(`Derivation: m/48'/1'/0'/2'\nDEADBEEF: ${synthetic.keys.cosigner.xpub}`);
    // A depth-0 key's fingerprint is its own (what Coldcard checks for a depth-0 xpub); the synthetic one's is invented.
    const hd = HDKey.fromExtendedKey(depth0.keys.cosigner.xpub, network.bip32);
    expect(hd.depth).toBe(0);
    expect(hd.fingerprint.toString(16).padStart(8, '0')).toBe(depth0.keys.cosigner.fingerprint);
  });

  it('descriptor import (Jade, Passport, Keystone): both are valid descriptors with a checksum', () => {
    expect(depth0.descriptor()).toMatch(/,\[[0-9a-f]{8}\]tpub[^/]+\/<0;1>\/\*\)\)#[a-z0-9]{8}$/);
    expect(synthetic.descriptor()).toMatch(/\[deadbeef\/48h\/1h\/0h\/2h\]tpub/);
  });
});
