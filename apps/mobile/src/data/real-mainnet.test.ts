/**
 * The guardian mode on mainnet, against the real guardian in-process: `@trikey/guardian`'s rig started with
 * `network: 'bitcoin'` (the guardian's keys, rules and pairing are mainnet's; its chain is still the fake Electrs, so
 * nothing here reaches a real network) and a mainnet stand-in for the hardware wallet. Throwaway keys from the BIP 39
 * test vectors. Every test has its own guardian and its own device.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { npubEncode } from 'nostr-tools/nip19';
import { MultisigWallet, NETWORKS } from '@trikey/core';
import { GuardianRig } from '@trikey/guardian/testing';
import { messageHash, type HardwareDeviceInfo, type HardwareProvider, type HardwareSigner, type HardwareWalletPolicy } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore } from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { createRealWalletService, type RealWalletService } from './real';

const MNEMONICS = {
  a: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  b: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  c: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};

/**
 * A mainnet hardware wallet for these tests only. `@trikey/wallet/testing`'s software device refuses mainnet on
 * purpose, so this one does just what onboarding asks of a device: the account key, the wallet registration, the
 * address on its screen and the pairing signature (BIP 137). It refuses test-network paths, like a device in its
 * mainnet app, and signs no transaction.
 */
class MainnetTestDevice implements HardwareSigner {
  readonly info: HardwareDeviceInfo;
  readonly calls: string[] = [];
  private readonly master: HDKey;

  constructor(mnemonic: string) {
    this.master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic), NETWORKS.bitcoin.bip32);
    this.info = { kind: 'ledger', model: 'Mainnet test device', fingerprint: this.master.fingerprint.toString(16).padStart(8, '0') };
  }

  private checkPath(path: string): void {
    const m = /^m\/(\d+)'\/(\d+)'/.exec(path);
    if (m && m[2] !== '0') throw new Error(`refusing a coin type ${m[2]}' path on mainnet`);
  }

  async getXpub(path: string): Promise<string> {
    this.checkPath(path);
    this.calls.push(`getXpub ${path}`);
    return this.master.derive(path).publicExtendedKey;
  }

  async registerWallet(policy: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    MultisigWallet.fromDescriptor(policy.descriptor, NETWORKS.bitcoin);
    this.calls.push('registerWallet');
    return {};
  }

  async displayAddress(policy: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    const address = MultisigWallet.fromDescriptor(policy.descriptor, NETWORKS.bitcoin).derive(chain, index).address;
    this.calls.push(`displayAddress ${address}`);
    return address;
  }

  async signPsbt(): Promise<string> {
    throw new Error('this test device signs no transaction');
  }

  async signMessage(path: string, message: string): Promise<string> {
    this.checkPath(path);
    this.calls.push(`signMessage ${path}`);
    const rec = secp256k1.sign(messageHash(message), this.master.derive(path).privateKey!, { prehash: false, lowS: true, format: 'recovered' });
    const out = new Uint8Array(65);
    out[0] = 31 + rec[0]!; // BIP 137, P2PKH with a compressed key
    out.set(rec.subarray(1), 1);
    return base64.encode(out);
  }

  async close(): Promise<void> {}
}

const providerFor = (device: HardwareSigner): HardwareProvider => ({ kinds: ['ledger'], isAvailable: async () => true, connect: async () => device });
const npubOf = (seed: number) => npubEncode(bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true).slice(1)));

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

const opened: RealWalletService[] = [];
const rigs: GuardianRig[] = [];

/** A phone in real mode, with its own storage and cloud. It is asked to start on mainnet, which it must not do by itself. */
async function phone(opts: { rig: GuardianRig; device: HardwareSigner; cloud?: MemoryCloudBackupStore }) {
  const passkeys = new MemoryPasskeyPrf();
  passkeys.supported = false;
  const svc = await createRealWalletService({
    mode: 'real',
    network: 'bitcoin',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [opts.cloud ?? new MemoryCloudBackupStore()], passkeys },
    hardware: () => [providerFor(opts.device)],
    clock: opts.rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  opened.push(svc);
  return svc;
}

async function mainnetGuardian(): Promise<GuardianRig> {
  const rig = await GuardianRig.start({ network: 'bitcoin' });
  rigs.push(rig);
  return rig;
}

afterAll(async () => {
  for (const s of opened) await s.close().catch(() => undefined);
  for (const r of rigs) await r.stop().catch(() => undefined);
});

describe('the guardian mode on mainnet', { timeout: 60_000 }, () => {
  it('starts on testnet, takes mainnet when the person picks it, and makes no wallet before the warning is accepted', async () => {
    const rig = await mainnetGuardian();
    const device = new MainnetTestDevice(MNEMONICS.a);
    const p = await phone({ rig, device });
    // Asked to start on mainnet, with no wallet there: testnet, the default.
    expect(p.getState()).toMatchObject({ network: 'testnet', mainnetRiskAccepted: false });

    p.setNetwork('bitcoin');
    expect(p.getState()).toMatchObject({ network: 'bitcoin', mainnetRiskAccepted: false });
    expect(await failure(p.connectHardware('ledger'))).toMatchObject({ kind: 'wrong_state', message: expect.stringMatching(/mainnet warning/) });
    expect(device.calls).toEqual([]);

    // The answer is kept until the network changes.
    p.acceptMainnetRisk(true);
    expect(p.getState().mainnetRiskAccepted).toBe(true);
    p.setNetwork('bitcoin');
    expect(p.getState().mainnetRiskAccepted).toBe(true);
    p.setNetwork('signet');
    expect(p.getState()).toMatchObject({ network: 'signet', mainnetRiskAccepted: false });
    p.setNetwork('bitcoin');
    expect(p.getState().mainnetRiskAccepted).toBe(false);
  });

  it('pairs on mainnet with an alert contact: a bc1q address, and a descriptor of xpubs at coin type 0', async () => {
    const rig = await mainnetGuardian();
    const device = new MainnetTestDevice(MNEMONICS.b);
    const p = await phone({ rig, device });
    p.setNetwork('bitcoin');
    p.acceptMainnetRisk(true);
    p.setOnboardingContacts([{ name: 'My laptop', npub: npubOf(21) }]);

    await p.connectHardware('ledger');
    // The device was asked for its mainnet account key (BIP 48, coin type 0'), nothing on a test path.
    expect(device.calls[0]).toBe("getXpub m/48'/0'/0'/2'");
    await p.pairGuardian(rig.pairingUri());
    await p.setUpRules(100_000, 7);

    const s = p.getState();
    expect(s).toMatchObject({ network: 'bitcoin', onboarded: true, addressVerified: true, guardian: { status: 'online' } });
    expect(s.receiveAddress).toMatch(/^bc1q[02-9ac-hj-np-z]{58}$/);
    expect(s.receiveAddress).toBe(p.wallet!.multisig().derive(0, 0).address);
    expect(device.calls).toContain(`displayAddress ${p.wallet!.multisig().derive(0, 0).address}`);
    expect((await p.receiveAddress()).address).toMatch(/^bc1q/);

    const d = p.getWalletDetails()!;
    expect(d.network).toBe('bitcoin');
    expect(d.descriptor).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(d.descriptor).not.toMatch(/tpub/);
    // The phone's and the device's keys carry their BIP 48 origin at coin type 0'; all three keys are xpubs.
    expect(d.descriptor.match(/xpub/g)).toHaveLength(3);
    expect(d.descriptor).toContain(`[${d.fingerprints.phone}/48h/0h/0h/2h]xpub`);
    expect(d.descriptor).toContain(`[${d.fingerprints.hardware}/48h/0h/0h/2h]xpub`);

    // The guardian holds the rules with the contact, on its mainnet registration.
    expect(rig.guardian.engine.status().rules?.alertContacts).toHaveLength(1);
    expect(p.getState().contacts.map((c) => c.name)).toEqual(['My laptop']);
  });

  it('refuses to pair on mainnet without an alert contact', async () => {
    const rig = await mainnetGuardian();
    const device = new MainnetTestDevice(MNEMONICS.c);
    const p = await phone({ rig, device });
    p.setNetwork('bitcoin');
    p.acceptMainnetRisk(true);
    await p.connectHardware('ledger');
    await p.pairGuardian(rig.pairingUri());
    const refused = await failure(p.setUpRules(100_000, 7));
    expect(refused).toMatchObject({ kind: 'refused', message: expect.stringMatching(/^On mainnet your guardian needs at least one alert contact/) });
    expect(p.getState().onboarded).toBe(false);
    expect(rig.guardian.engine.status().rules).toBeFalsy();
  });

  it('restores a mainnet backup on a phone set to testnet once the person agrees to switch and accepts the warning', async () => {
    const rig = await mainnetGuardian();
    const cloud = new MemoryCloudBackupStore();
    const device = new MainnetTestDevice(MNEMONICS.a);
    const p = await phone({ rig, device, cloud });
    p.setNetwork('bitcoin');
    p.acceptMainnetRisk(true);
    p.setOnboardingContacts([{ name: 'Ana', npub: npubOf(22) }]);
    await p.connectHardware('ledger');
    await p.pairGuardian(rig.pairingUri());
    await p.setUpRules(100_000, 7);
    await p.createBackup('file');
    const code = p.recoveryCode()!;
    const walletId = p.wallet!.state.wallet!.walletId;
    await p.close();

    const n = await phone({ rig, device: new MainnetTestDevice(MNEMONICS.a), cloud });
    expect(n.getState().network).toBe('testnet');
    expect(await n.findBackup()).toMatchObject({ network: 'bitcoin' });
    // Not without saying so: the backup's network comes back with the refusal, for the screen to offer the switch.
    expect(await failure(n.restoreFromBackup({ recoveryCode: code }))).toMatchObject({ kind: 'network_mismatch', network: 'bitcoin' });
    // Agreeing to switch is not enough on mainnet: the warning has to be accepted too.
    expect(await failure(n.restoreFromBackup({ recoveryCode: code }, undefined, { switchNetwork: true }))).toMatchObject({ kind: 'wrong_state' });
    expect(n.getState()).toMatchObject({ onboarded: false, network: 'testnet' });
    n.acceptMainnetRisk(true);
    rig.clock.advance(6 * 60_000); // past the relays' memory of the first phone's last requests
    await n.restoreFromBackup({ recoveryCode: code }, undefined, { switchNetwork: true });
    expect(n.getState()).toMatchObject({ onboarded: true, network: 'bitcoin' });
    expect(n.wallet!.state.wallet!.walletId).toBe(walletId);
    expect(n.getState().receiveAddress).toMatch(/^bc1q/);
  });
});
