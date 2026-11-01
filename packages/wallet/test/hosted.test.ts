/**
 * A hosted wallet's pure parts (docs/design/family-hosting.md): the encrypted wallet map, the classification of the
 * guardian's co-signed coins against the descriptor, PSBTs to the guardian without derivations, signing by tweak, and
 * the consents an invite needs before anything is sent.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import {
  MultisigWallet,
  SoftwareSigner,
  TX_OPTS,
  analyzePsbt,
  bip48Path,
  buildSpend,
  cosignerKeyExpression,
  delegatedScripts,
  keySetId,
  parsePsbt,
  tweakToBytes,
} from '@trikey/core';
import { encodeInviteUri, generatePairingSecret } from '@trikey/protocol';
import { BackupPayload } from '../src/backup.js';
import { TrikeyWallet } from '../src/index.js';
import { chainCodeOf, classifyLedgerCoins, decryptWalletMap, encryptWalletMap, ledgerInput, signByTweaks, stripDerivations, verifyWalletMap, walletMapKey } from '../src/hosted.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, network, phone } from './helpers.js';
import { ManualClock } from '@trikey/guardian/testing';

const APP = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const GUARDIAN = 'ab'.repeat(32);

async function hostedWallet(): Promise<MultisigWallet> {
  return new MultisigWallet(network, {
    app: await new SoftwareSigner('app', APP).getKey(network),
    hardware: await new SoftwareSigner('hardware', MNEMONICS.hardware).getKey(network),
    cosigner: cosignerKeyExpression(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), new Uint8Array(32).fill(3), network),
  });
}

function fundingTx(script: Uint8Array, value: bigint) {
  const raw = btc.RawTx.encode({ version: 2, segwitFlag: false, inputs: [{ txid: new Uint8Array(32).fill(1), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }], outputs: [{ script, amount: value }], lockTime: 0 });
  return { raw: hex.encode(raw), txid: btc.Transaction.fromRaw(raw, { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id };
}

describe('the wallet map', () => {
  it('round-trips under the hardware chaincode, padded, and fails under any other key', async () => {
    const w = await hostedWallet();
    const id = keySetId(w.accountPubkeys());
    const key = walletMapKey(chainCodeOf(w.keys.hardware.xpub, network), GUARDIAN, id);
    const map = encryptWalletMap({ version: 1, network: 'regtest', descriptor: w.descriptor(), birthHeight: 123 }, key);
    expect(map).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(map).not.toContain(w.keys.app.xpub.slice(4, 20));
    expect((map.length * 3) / 4).toBeLessThan(4096);
    expect(decryptWalletMap(map, key)).toEqual({ version: 1, network: 'regtest', descriptor: w.descriptor(), birthHeight: 123 });
    expect(() => decryptWalletMap(map, walletMapKey(new Uint8Array(32).fill(1), GUARDIAN, id))).toThrow();
    expect(() => decryptWalletMap(map, walletMapKey(chainCodeOf(w.keys.hardware.xpub, network), 'cd'.repeat(32), id))).toThrow();
    // Two maps of the same wallet differ (fresh nonce).
    expect(encryptWalletMap({ version: 1, network: 'regtest', descriptor: w.descriptor(), birthHeight: 123 }, key)).not.toBe(map);
  });

  it("is checked against the guardian's account pubkeys and the device's xpub", async () => {
    const w = await hostedWallet();
    const a = w.accountPubkeys();
    const acct = { app: hex.encode(a.app), hardware: hex.encode(a.hardware), cosigner: hex.encode(a.cosigner) };
    const content = { version: 1 as const, network: 'regtest' as const, descriptor: w.descriptor(), birthHeight: 0 };
    expect(verifyWalletMap(content, { network, accountPubkeys: acct, hardwareXpub: w.keys.hardware.xpub }).fingerprint()).toBe(w.fingerprint());
    expect(() => verifyWalletMap(content, { network, accountPubkeys: { ...acct, cosigner: acct.app }, hardwareXpub: w.keys.hardware.xpub })).toThrow(/cosigner/);
    expect(() => verifyWalletMap(content, { network, accountPubkeys: acct, hardwareXpub: w.keys.app.xpub })).toThrow(/hardware/);
  });
});

describe('classifying the co-signed coins', () => {
  it('finds coins at their path, and tells off-path ones (tweak-proven, at no path)', async () => {
    const w = await hostedWallet();
    const acct = w.accountPubkeys();
    const coin = (chain: number, index: number) => {
      const d = w.derive(chain, index);
      return { txid: `${chain}${index}`.padEnd(64, 'a'), vout: 0, valueSats: 1000, script: hex.encode(d.script), tweaks: { app: hex.encode(tweakToBytes(d.tweaks.app)), hardware: hex.encode(tweakToBytes(d.tweaks.hardware)), cosigner: hex.encode(tweakToBytes(d.tweaks.cosigner)) } };
    };
    const t = { app: 11n, hardware: 12n, cosigner: 13n };
    const off = { txid: 'f'.repeat(64), vout: 1, valueSats: 5000, script: hex.encode(delegatedScripts(acct, t, network).script), tweaks: { app: hex.encode(tweakToBytes(11n)), hardware: hex.encode(tweakToBytes(12n)), cosigner: hex.encode(tweakToBytes(13n)) } };
    const out = classifyLedgerCoins(w, [coin(1, 0), coin(0, 57), off, coin(1, 150)], 200);
    expect(out.map((c) => (c.onPath ? `${c.chain}/${c.index}` : 'off'))).toEqual(['1/0', '0/57', 'off', '1/150']);
    expect(classifyLedgerCoins(w, [coin(1, 150)], 100)[0].onPath).toBe(false);
  });
});

describe('PSBTs to the hosting guardian', () => {
  it('lose their BIP 32 derivations but keep the tweaks and signatures', async () => {
    const w = await hostedWallet();
    const f = fundingTx(w.derive(0, 0).script, 100_000n);
    const plan = buildSpend({ wallet: w, utxos: [{ txid: f.txid, vout: 0, value: 100_000n, chain: 0, index: 0, prevTxHex: f.raw }], recipients: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: 10_000n }], feeRate: 1, changeIndex: 0 });
    const signed = await new SoftwareSigner('app', APP).signPsbt(plan.psbt, network);
    const stripped = stripDerivations(signed);
    const tx = parsePsbt(stripped);
    expect(tx.getInput(0).bip32Derivation ?? []).toEqual([]);
    expect(tx.getOutput(1).bip32Derivation ?? []).toEqual([]);
    const a = analyzePsbt(stripped, w.accountPubkeys(), network, { requireNonWitnessUtxo: true });
    expect(a.inputs[0].signedBy).toEqual(['app']);
    expect(a.outputs.filter((o) => o.isSelf)).toHaveLength(1);
  });

  it('signs an off-path ledger coin by its tweak with key 2', async () => {
    const w = await hostedWallet();
    const acct = w.accountPubkeys();
    const t = { app: 21n, hardware: 22n, cosigner: 23n };
    const script = delegatedScripts(acct, t, network).script;
    const f = fundingTx(script, 50_000n);
    const coin = { txid: f.txid, vout: 0, valueSats: 50_000, script: hex.encode(script), tweaks: { app: hex.encode(tweakToBytes(21n)), hardware: hex.encode(tweakToBytes(22n)), cosigner: hex.encode(tweakToBytes(23n)) } };
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput(ledgerInput(acct, coin, f.raw, network));
    tx.addOutput({ script: w.derive(0, 1).script, amount: 49_000n, ...w.psbtFields(w.derive(0, 1)) });
    const account = new SoftwareSigner('app', APP).master(network).derive(bip48Path(network));
    const signed = signByTweaks(tx.toPSBT(), account.privateKey!, network);
    expect(analyzePsbt(signed, acct, network, { requireNonWitnessUtxo: true }).inputs[0].signedBy).toEqual(['app']);
    expect(() => ledgerInput(acct, { ...coin, script: hex.encode(w.derive(0, 0).script) }, f.raw, network)).toThrow(/not this wallet/);
  });
});

describe('accepting an invite: what is refused before anything is sent', () => {
  it('needs the disclosure acknowledged, the network right, and on mainnet the pre-alpha consent', async () => {
    const clock = new ManualClock(Date.now());
    for (const net of ['regtest', 'bitcoin'] as const) {
      const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
      const p = phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
      const w = await TrikeyWallet.create({ ...p.deps, network: net });
      if (net === 'regtest') await w.connectHardware();
      const now = Math.floor(clock.now() / 1000);
      const uri = encodeInviteUri({ guardianPubkey: 'ab'.repeat(32), relays: ['wss://relay.example.com'], secret: generatePairingSecret(), expiresAt: now + 3600, network: net, label: 'Maria' }, now);
      expect(w.parseScannedCode(uri)).toMatchObject({ kind: 'invite', network: net, label: 'Maria' });
      expect(w.previewInvite(uri)).toMatchObject({ hostLabel: 'Maria', mainnet: net === 'bitcoin' });
      const rules = { dailyLimitSats: 100_000, recoveryDelayDays: 7 as const, alertContacts: ['cd'.repeat(32)], sweepFeeCapSats: 20_000 };
      await expect(w.acceptInvite({ inviteUri: uri, rules, walletLabel: 'Me', understood: false })).rejects.toMatchObject({ code: 'consent_required' });
      if (net === 'bitcoin') await expect(w.acceptInvite({ inviteUri: uri, rules, walletLabel: 'Me', understood: true })).rejects.toMatchObject({ code: 'mainnet_consent_required' });
      else await expect(w.acceptInvite({ inviteUri: uri, rules, walletLabel: 'Me', understood: true })).rejects.toMatchObject({ code: 'chain_source_required' });
      const other = encodeInviteUri({ guardianPubkey: 'ab'.repeat(32), relays: ['wss://relay.example.com'], secret: generatePairingSecret(), expiresAt: now + 3600, network: net === 'bitcoin' ? 'signet' : 'bitcoin' }, now);
      await expect(w.acceptInvite({ inviteUri: other, rules, walletLabel: 'Me', understood: true, mainnetConsent: true })).rejects.toMatchObject({ code: 'network_mismatch' });
      await w.close();
    }
  });
});

describe('backup version 3', () => {
  it('is exactly the hosted wallet backup', () => {
    const base = { network: 'regtest', createdAt: 1, mnemonic: APP, deviceName: 'p' };
    const guardian = { pubkey: 'ab'.repeat(32), relays: ['wss://relay.example.com'], key: { fingerprint: '01234567', path: 'm', xpub: 'tpub'.padEnd(111, 'x') } };
    const hosted = { ...guardian, hosted: { walletLabel: 'Me', cosignerAccountPubkey: `02${'11'.repeat(32)}`, acceptedAt: 1 } };
    expect(BackupPayload.safeParse({ ...base, v: 3, guardian: hosted }).success).toBe(true);
    expect(BackupPayload.safeParse({ ...base, v: 1, guardian: hosted }).success).toBe(false);
    expect(BackupPayload.safeParse({ ...base, v: 3, guardian }).success).toBe(false);
    expect(BackupPayload.safeParse({ ...base, v: 1, guardian }).success).toBe(true);
  });
});
