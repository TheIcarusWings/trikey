/**
 * The real `WalletService` against the real wallet and the real guardian, in-process: `@trikey/wallet`'s in-memory
 * platform and software hardware wallet, `@trikey/guardian`'s rig (the guardian service, two in-memory relays, a fake
 * Electrs). Regtest, throwaway keys. The tests run in order and share one guardian, like a person's first weeks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { npubEncode } from 'nostr-tools/nip19';
import { NETWORKS } from '@trikey/core';
import { encodeRecoveryUri } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { createRealWalletService, type RealWalletService } from './real';
import type { DevicePrompt } from './types';

const MNEMONICS = {
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  hardware2: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

let rig: GuardianRig;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false; // the alpha without developer accounts: no passkeys
const opened: RealWalletService[] = [];

interface Phone {
  svc: RealWalletService;
  secure: MemorySecureKeyStore;
  kv: MemoryKeyValueStore;
  prompts: DevicePrompt[];
  shared: { name: string; bytes: Uint8Array }[];
}

async function phone(
  opts: {
    secure?: MemorySecureKeyStore;
    kv?: MemoryKeyValueStore;
    picked?: { name: string; bytes: Uint8Array };
    clock?: { now(): number };
    hardware?: SoftwareHardwareProvider;
    mode?: 'simulator' | 'real';
    network?: 'testnet' | 'signet' | 'regtest';
    rpcTimeoutMs?: number;
  } = {},
): Promise<Phone> {
  const secure = opts.secure ?? new MemorySecureKeyStore();
  const kv = opts.kv ?? new MemoryKeyValueStore();
  const prompts: DevicePrompt[] = [];
  const shared: Phone['shared'] = [];
  const svc = await createRealWalletService({
    mode: opts.mode ?? 'simulator',
    ...(opts.network ? { network: opts.network } : {}),
    platform: { os: 'ios', isSecure: true, secureKeys: secure, kv, cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [opts.hardware ?? provider],
    clock: opts.clock ?? rig.clock,
    rpcTimeoutMs: opts.rpcTimeoutMs ?? 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    shareBackupFile: async (name, bytes) => void shared.push({ name, bytes }),
    pickBackupFile: async () => opts.picked ?? null,
  });
  svc.prompts.subscribe(() => {
    const p = svc.prompts.getSnapshot();
    if (p) prompts.push(p);
  });
  opened.push(svc);
  return { svc, secure, kv, prompts, shared };
}

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const s of opened) await s.close();
  await rig?.stop();
});

describe('the real wallet service', { timeout: 60_000 }, () => {
  let A: Phone;
  let walletId: string;
  let recoveryCode: string;

  it('starts empty, creates the phone key when the hardware wallet connects, pairs, and shows the guardian', async () => {
    A = await phone();
    const s0 = A.svc.getState();
    expect(s0).toMatchObject({ backing: 'simulator', network: 'regtest', onboarded: false, recovering: false, synced: false, balanceSats: 0 });
    expect(s0.capabilities).toEqual({ lockGuardian: true, replaceGuardian: true, recoveryKey: true });
    expect(s0).toMatchObject({ hardwareConfirmRequired: false, replace: { plan: null, step: null, pending: null }, oldWallets: [], walletRetired: null });
    expect(await A.svc.getHardwareOptions()).toEqual([expect.objectContaining({ kind: 'simulated', available: true })]);

    const seen: (string | null)[] = [];
    A.svc.subscribe(() => seen.push(A.svc.getState().progress));
    const hw = await A.svc.connectHardware('simulated');
    expect(hw).toMatchObject({ kind: 'simulated', brand: 'simulated device' });
    expect(seen).toContain('Creating your phone key');
    expect(A.svc.getState().progress).toBeNull();
    expect(A.secure.items.size).toBe(2); // key 2 and the nostr key

    const guardian = await A.svc.pairGuardian(rig.pairingUri());
    expect(guardian).toMatchObject({ label: 'Test Guardian', status: 'online', relays: rig.relayUrls });
    expect(guardian.npub).toBe(npubEncode(rig.pubkey));

    await A.svc.setUpRules(100_000, 7);
    const s = A.svc.getState();
    expect(s).toMatchObject({ onboarded: true, addressVerified: true, recoveryDelayDays: 7, dailyLimit: { limitSats: 100_000 } });
    walletId = A.svc.wallet!.state.wallet!.walletId;
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(100_000n);

    // The device sheet showed what the device was asked, in order: the key, the pairing text, the wallet, the address.
    const details = A.prompts.map((p) => p.detail ?? '');
    expect(details[0]).toMatch(/public key/);
    expect(details.some((d) => d.includes(`Trikey pair v1 wallet=${walletId}`))).toBe(true);
    expect(details.some((d) => /Register the 2-of-3 wallet/.test(d))).toBe(true);
    expect(details.some((d) => d.includes(A.svc.wallet!.multisig().derive(0, 0).address))).toBe(true);
    expect(A.svc.prompts.getSnapshot()).toBeNull();
  });

  it('refuses a damaged pairing code politely, and a pairing code that ran out', async () => {
    const p = await phone();
    await p.svc.connectHardware('simulated');
    expect(await failure(p.svc.pairGuardian('trikey://pair?v=1&npub=nope'))).toMatchObject({ kind: 'pairing_invalid' });
    // Already paired guardian: the first phone won.
    expect(await failure(p.svc.pairGuardian(rig.pairingUri()))).toMatchObject({ kind: 'refused', message: expect.stringMatching(/already paired/) });
    await p.svc.wallet!.forget();
  });

  it('receives at the real address, verified on the device', async () => {
    const s = A.svc.getState();
    expect(s.receiveAddress).toBe(A.svc.wallet!.multisig().derive(0, 0).address);
    const r = await A.svc.receiveAddress({ verifyOnDevice: true });
    expect(r).toEqual({ address: s.receiveAddress, verifiedOnDevice: true });

    // A device that shows another address is a hard stop with its own message.
    device.displayOverride = externalAddress(9);
    expect(await failure(A.svc.receiveAddress({ verifyOnDevice: true }))).toMatchObject({ kind: 'address_mismatch' });
    device.displayOverride = undefined;
  });

  it('syncs the balance and the activity from the guardian', async () => {
    rig.fund(A.svc.wallet!.multisig().derive(0, 0).script, 500_000n);
    rig.fund(A.svc.wallet!.multisig().derive(0, 1).script, 50_000n);
    await A.svc.sync();
    const s = A.svc.getState();
    expect(s).toMatchObject({ synced: true, balanceSats: 550_000, syncing: false, guardian: { status: 'online' } });
    expect(s.activity.filter((i) => i.type === 'payment')).toHaveLength(2);
    expect(s.activity[0]).toMatchObject({ type: 'payment', tx: { kind: 'received', status: 'confirmed' } });
    expect(s.receiveAddress).toBe(A.svc.wallet!.multisig().derive(0, 2).address);
  });

  it('quotes, and pays within the limit with the phone and the guardian', async () => {
    const to = externalAddress();
    expect(A.svc.quoteSend({ address: 'nope', amountSats: 20_000, speed: 'normal' })).toMatchObject({ ok: false, problem: 'invalid_address' });
    expect(A.svc.quoteSend({ address: to, amountSats: 10, speed: 'normal' })).toMatchObject({ ok: false, problem: 'amount_too_small' });
    expect(A.svc.quoteSend({ address: to, amountSats: 900_000, speed: 'normal' })).toMatchObject({ ok: false, problem: 'insufficient_funds' });

    const q = A.svc.quoteSend({ address: to, amountSats: 30_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
    expect(q.quote.totalSats).toBe(30_000 + q.quote.feeSats);
    expect(q.quote.remainingAfterSats).toBe(100_000 - q.quote.totalSats);

    const tx = await A.svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ kind: 'sent', amountSats: 30_000, status: 'pending', signedBy: 'phone+guardian', address: to });
    expect(rig.electrs.broadcasts).toHaveLength(1);
    const s = A.svc.getState();
    expect(s.dailyLimit.usedSats).toBe(q.quote.totalSats);
    expect(s.dailyLimit.cosignedCount).toBe(1);
    const row = s.activity.find((i) => i.type === 'payment' && i.tx.id === tx.id);
    expect(row).toMatchObject({ tx: { kind: 'sent', amountSats: 30_000, address: to, signedBy: 'phone+guardian' } });
  });

  it('plans the hardware wallet for a payment over the limit and signs it there', async () => {
    const q = A.svc.quoteSend({ address: externalAddress(), amountSats: 120_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'over-limit' });
    const before = rig.guardian.engine.status().dailyLimit!.used;
    const signs = device.calls.filter((c) => c.op === 'signPsbt').length;
    const tx = await A.svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ amountSats: 120_000, signedBy: 'phone+hardware' });
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs + 1);
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(before);
    // The sheet said what the device would show.
    expect(A.prompts.some((p) => /Send 120000 sats to /.test(p.detail ?? ''))).toBe(true);

    // The user can also ask for the hardware wallet on a payment that would fit.
    const asked = A.svc.quoteSend({ address: externalAddress(), amountSats: 1_000, speed: 'normal', signer: 'hardware' });
    expect(asked).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'requested' } } });
  });

  it('turns the guardian\'s refusals into messages that offer the hardware wallet: over the limit, locked, recovery, paused', async () => {
    // The phone's estimate is only a hint. Force the guardian to be asked, with a payment over what is left.
    const q = A.svc.quoteSend({ address: externalAddress(), amountSats: 80_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan.signer).toBe('hardware');
    const refused = await failure(A.svc.sendPayment({ ...q.quote, plan: { signer: 'phone+guardian' } }));
    expect(refused).toMatchObject({ kind: 'over_limit', suggestsHardware: true });
    expect(refused.message).toMatch(/hardware wallet can approve it instead/);

    // Locked: the quote already knows it after the next sync, the refusal tells it as well.
    await rig.lock();
    await A.svc.sync(); // chain data keeps working while the guardian is locked
    expect(A.svc.getState().guardian.status).toBe('locked');
    const lockedQuote = A.svc.quoteSend({ address: externalAddress(), amountSats: 5_000, speed: 'normal' });
    expect(lockedQuote).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'guardian-locked' } } });
    if (!lockedQuote.ok) throw new Error('unreachable');
    const stale = await failure(A.svc.sendPayment({ ...lockedQuote.quote, plan: { signer: 'phone+guardian' } }));
    expect(stale).toMatchObject({ kind: 'guardian_locked', suggestsHardware: true });
  });

  it('unlocks the guardian with its passphrase, and keeps the passphrase out of storage', async () => {
    expect(await failure(A.svc.unlockGuardian(''))).toMatchObject({ kind: 'invalid_input' });
    const wrong = await failure(A.svc.unlockGuardian('not the passphrase'));
    expect(wrong).toMatchObject({ kind: 'unlock_failed' });
    await A.svc.unlockGuardian(rig.passphrase);
    expect(A.svc.getState().guardian.status).toBe('online');
    expect(JSON.stringify([...A.kv.data.values()])).not.toContain(rig.passphrase);
    // Also gone from the sheet and the state.
    expect(JSON.stringify(A.svc.getState())).not.toContain(rig.passphrase);
  });

  it('changes rules: lowering from the phone, raising with the hardware wallet, contacts and the delay', async () => {
    const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;
    const base = signs();
    await A.svc.setDailyLimit(80_000);
    expect(signs()).toBe(base);
    expect(A.svc.getState().dailyLimit.limitSats).toBe(80_000);
    expect(A.svc.getState().activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'limit-changed', direction: 'lowered', approvedOn: 'phone', limitSats: 80_000 }) }));

    await A.svc.setDailyLimit(150_000);
    expect(signs()).toBe(base + 1);
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(150_000n);
    expect(A.svc.getState().activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'limit-changed', direction: 'raised', approvedOn: 'hardware' }) }));
    // The sheet showed the exact approval text, with the new value in clear.
    expect(A.prompts.some((p) => /Trikey policy v1 .*limit=150000/.test(p.detail ?? ''))).toBe(true);

    await A.svc.setRecoveryDelay(14);
    expect(A.svc.getState().recoveryDelayDays).toBe(14);
    await A.svc.setRecoveryDelay(7); // shortening needs the hardware wallet
    expect(signs()).toBeGreaterThanOrEqual(base + 2);

    const friend = npubEncode(bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true).slice(1)));
    const c = await A.svc.addContact('Maria', friend);
    expect(c).toMatchObject({ name: 'Maria', npub: friend });
    expect(A.svc.getState().contacts).toEqual([expect.objectContaining({ name: 'Maria', npub: friend })]);
    expect(await failure(A.svc.addContact('Nobody', 'npub1notvalid'))).toMatchObject({ kind: 'invalid_input' });
    await A.svc.removeContact(c.id);
    expect(A.svc.getState().contacts).toEqual([]);
  });

  it('starts a recovery with a new hardware wallet, shows it, and cancels it; a contested cancel pauses phone payments until resumed', async () => {
    const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' });
    provider.device = newDevice;
    const r = await A.svc.startRecovery('hardware', { hardwareKind: 'simulated' });
    provider.device = device;
    expect(r).toMatchObject({ origin: 'this-phone', lostKey: 'hardware', acknowledged: true, state: 'pending' });
    expect(new Date(r.completesAt).getTime() - new Date(r.startedAt).getTime()).toBe(7 * 86_400_000);
    expect(A.svc.getState().recovery).toEqual(r);
    // Phone-only payments pause while it runs.
    await A.svc.sync();
    expect(A.svc.getState().phoneSpending).toBe('paused_recovery');
    const q = A.svc.quoteSend({ address: externalAddress(), amountSats: 1_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'recovery-pending' } } });
    expect(await failure(A.svc.sendPayment({ ...(q.ok ? q.quote : (undefined as never)), plan: { signer: 'phone+guardian' } }))).toMatchObject({
      kind: 'recovery_in_progress',
      suggestsHardware: true,
    });

    await A.svc.cancelRecovery();
    expect(A.svc.getState().recovery).toBeNull();
    expect(A.svc.getState().recoveryOutcome).toBe('cancelled');
    // Cancelled by the phone that started it: not contested.
    expect(A.svc.getState().phoneSpending).toBe('enabled');
  });

  it('a recovery started by someone else shows as an alert, can be cancelled (contested), and phone payments resume with the hardware wallet', async () => {
    // A new phone, with only the hardware wallet and the guardian's address, starts a recovery.
    const B = await phone();
    const started = await B.svc.startRecovery('phone', { guardian: { npub: npubEncode(rig.pubkey), relays: rig.relayUrls }, hardwareKind: 'simulated' });
    expect(started).toMatchObject({ origin: 'this-phone', lostKey: 'phone' });
    expect(B.svc.getState()).toMatchObject({ recovering: true, onboarded: false });
    expect(B.svc.getState().recovery).toMatchObject({ id: started.id });

    const alert = await waitFor(() => A.svc.getState().recovery, 'A hears of the recovery');
    expect(alert).toMatchObject({ id: started.id, origin: 'someone-else', acknowledged: false, lostKey: 'phone' });
    A.svc.acknowledgeRecovery();
    expect(A.svc.getState().recovery?.acknowledged).toBe(true);

    await A.svc.cancelRecovery();
    await waitFor(() => A.svc.getState().phoneSpending === 'paused_contested' || undefined, 'contested');
    expect(A.svc.getState().recoveryOutcome).toBe('cancelled');
    const q = A.svc.quoteSend({ address: externalAddress(), amountSats: 1_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'phone-spending-paused' } } });

    await A.svc.resumePhoneSpending();
    expect(A.svc.getState().phoneSpending).toBe('enabled');
    expect(A.prompts.some((p) => /Trikey resume-phone v1/.test(p.detail ?? ''))).toBe(true);
    const q2 = A.svc.quoteSend({ address: externalAddress(), amountSats: 1_000, speed: 'normal' });
    expect(q2).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
    expect(B.svc.wallet!.stage).toBe('recovering');
    // The recovering phone can still cancel nothing now, and renews its access with the hardware wallet.
    await B.svc.renewRecoveryAccess();
  });

  it('backs up with a recovery code only (no passkey, no cloud account), and exports the file', async () => {
    const opts = await A.svc.getBackupOptions();
    expect(opts.passkey).toBe(false);
    expect(opts.providers).toEqual([expect.objectContaining({ provider: 'file', available: true })]);

    const seen: (string | null)[] = [];
    A.svc.subscribe(() => seen.push(A.svc.getState().progress));
    const backup = await A.svc.createBackup('file');
    expect(seen).toContain('Encrypting your backup');
    expect(backup).toMatchObject({ provider: 'file', unlockedBy: ['recovery-code'] });
    expect(A.svc.getState().backup).toEqual(backup);
    recoveryCode = A.svc.recoveryCode()!;
    expect(recoveryCode).toMatch(/^[0-9A-Z]{5}( [0-9A-Z]{5}){4}$|^[0-9A-Za-z -]+$/);
    // The code is held in memory only until it is dismissed, and never stored.
    expect(JSON.stringify([...A.kv.data.values()])).not.toContain(recoveryCode);
    A.svc.dismissRecoveryCode();
    expect(A.svc.recoveryCode()).toBeNull();

    await A.svc.exportBackupFile();
    expect(A.shared).toHaveLength(1);
    expect(A.shared[0]!.name).toMatch(/^trikey-backup-[0-9a-f]{32}\.tkb$/);
    expect(A.shared[0]!.bytes).toEqual(cloud.files.get(A.shared[0]!.name));
  });

  it('restores on a new phone from an imported file and the recovery code; refuses a wrong code', async () => {
    const file = A.shared[0]!;
    const emptyCloudBackup = new Map(cloud.files);
    cloud.files.clear(); // the new phone has only the file the person saved
    const P = await phone({ picked: { name: 'Trikey backup (1).tkb', bytes: file.bytes } });
    expect(await P.svc.findBackup()).toBeNull();
    const found = await P.svc.importBackupFile();
    expect(found).toMatchObject({ provider: 'file', unlockedBy: ['recovery-code'] });
    expect(await P.svc.findBackup()).toMatchObject({ provider: 'file' });

    expect(await failure(P.svc.restoreFromBackup({ recoveryCode: '00000 00000 00000 00000 00000' }))).toMatchObject({ kind: expect.stringMatching(/^backup_/) });
    expect(P.svc.getState().onboarded).toBe(false);
    const seen: (string | null)[] = [];
    P.svc.subscribe(() => seen.push(P.svc.getState().progress));
    await P.svc.restoreFromBackup({ recoveryCode });
    expect(seen).toContain('Unlocking your backup');
    const s = P.svc.getState();
    expect(s.onboarded).toBe(true);
    expect(P.svc.wallet!.state.wallet!.walletId).toBe(walletId);
    expect(s.guardian.npub).toBe(npubEncode(rig.pubkey));
    await waitFor(() => P.svc.getState().synced || undefined, 'the restored phone syncs');
    expect(P.svc.getState().balanceSats).toBeGreaterThan(0);
    for (const [k, v] of emptyCloudBackup) cloud.files.set(k, v);
    await P.svc.close();
  });

  it('says "not available yet" for what has no wallet code behind it, and never pretends', async () => {
    expect(await failure(A.svc.recoverWithKit())).toMatchObject({ kind: 'not_available', message: expect.stringMatching(/isn't available yet/) });
    // Recovery Key mode is a wallet of its own (./rk-service.ts): the guardian's service has none of its actions.
    expect(A.svc.rk).toBeUndefined();
  });

  it('keeps the modes apart and survives a restart: the same wallet opens again, from its own storage', async () => {
    const again = await createRealWalletService({
      mode: 'simulator',
      platform: { os: 'ios', isSecure: true, secureKeys: A.secure, kv: A.kv, cloudBackups: [cloud], passkeys: passkey },
      hardware: () => [provider],
      clock: rig.clock,
      rpcTimeoutMs: 5000,
      rpcRetryIntervalMs: 0,
      syncIntervalMs: 0,
    });
    opened.push(again);
    expect(again.getState()).toMatchObject({ onboarded: true, dailyLimit: { limitSats: 150_000 } });
    expect(again.getState().activity.some((i) => i.type === 'security')).toBe(true);
    expect([...A.kv.data.keys()].some((k) => k.startsWith('trikey.wallet.simulator.regtest'))).toBe(true);

    // The same storage in "real" mode sees no wallet: nothing of the simulator's is touched or shown.
    const real = await createRealWalletService({
      mode: 'real',
      platform: { os: 'ios', isSecure: true, secureKeys: A.secure, kv: A.kv, cloudBackups: [cloud], passkeys: passkey },
      hardware: () => [],
      network: 'regtest',
      syncIntervalMs: 0,
    });
    opened.push(real);
    expect(real.getState()).toMatchObject({ backing: 'real', onboarded: false, network: 'regtest' });
    expect(await real.getHardwareOptions()).toEqual([]);
    expect(() => real.setNetwork('bitcoin')).toThrow(/Mainnet/);
    real.setNetwork('signet');
    expect(real.getState().network).toBe('signet');
    expect(A.svc.getState().onboarded).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Recovery that finishes, "Replace guardian", remote lock, scanning, and backups for another network.

const HOUR = 3_600_000;

/** `n` guardians on one fake Bitcoin network (they share the first rig's Electrs), on one clock. */
async function guardians(n: number): Promise<{ rigs: GuardianRig[]; stop: () => Promise<void> }> {
  const clock = new ManualClock(Date.now());
  const rigs = await Promise.all(Array.from({ length: n }, () => GuardianRig.start({ clock })));
  const orphans = [];
  for (const r of rigs.slice(1)) {
    orphans.push(r.electrs);
    r.electrs = rigs[0]!.electrs;
    await r.restart();
    await r.unlock();
  }
  for (const o of orphans) await o.stop();
  return { rigs, stop: async () => void (await Promise.all(rigs.map((r) => r.stop()))) };
}

const eventKinds = (p: Phone) => p.svc.getState().activity.flatMap((i) => (i.type === 'security' ? [i.event.kind] : []));

describe('the real wallet service: finishing a recovery, replacing the guardian, locking it', { timeout: 120_000 }, () => {
  let stopAll: (() => Promise<void>) | undefined;
  let R1: GuardianRig;
  let R2: GuardianRig;
  let R3: GuardianRig;
  let R4: GuardianRig;
  const dev = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const hw = new SoftwareHardwareProvider(dev);
  let P: Phone;

  beforeAll(async () => {
    const g = await guardians(4);
    stopAll = g.stop;
    [R1, R2, R3, R4] = g.rigs as [GuardianRig, GuardianRig, GuardianRig, GuardianRig];
  }, 60_000);
  afterAll(async () => {
    for (const s of opened) await s.close();
    await stopAll?.();
  });

  async function onboarded(r: GuardianRig, device = hw, rpcTimeoutMs?: number): Promise<Phone> {
    const p = await phone({ clock: r.clock, hardware: device, ...(rpcTimeoutMs ? { rpcTimeoutMs } : {}) });
    await p.svc.connectHardware('simulated');
    await p.svc.pairGuardian(r.pairingUri());
    await p.svc.setUpRules(100_000, 7);
    return p;
  }

  it('reads every kind of code through the wallet, checked against the network', async () => {
    const p = await phone({ clock: R1.clock, hardware: hw });
    const recover = encodeRecoveryUri({ guardianPubkey: R1.pubkey, relays: R1.relayUrls, network: 'regtest', label: 'Umbrel' });
    expect(p.svc.readCode(recover)).toMatchObject({ kind: 'recovery', guardian: { npub: npubEncode(R1.pubkey), relays: R1.relayUrls }, label: 'Umbrel' });
    expect(p.svc.readCode(encodeRecoveryUri({ guardianPubkey: R1.pubkey, relays: R1.relayUrls, network: 'signet' }))).toMatchObject({
      kind: 'unknown',
      reason: expect.stringMatching(/signet/),
    });
    expect(p.svc.readCode(R1.pairingUri())).toMatchObject({ kind: 'pairing', guardianNpub: npubEncode(R1.pubkey) });
    const addr = externalAddress(4);
    expect(p.svc.readCode(`bitcoin:${addr.toUpperCase()}?amount=0.0002`)).toEqual({ kind: 'address', address: addr, network: 'regtest', amountSats: 20_000 });
    expect(p.svc.readCode(btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true), NETWORKS.testnet.btc).address!)).toMatchObject({ kind: 'unknown' });
    expect(p.svc.readCode(npubEncode(R1.pubkey))).toMatchObject({ kind: 'contact' });
    expect(p.svc.readCode('hello')).toMatchObject({ kind: 'unknown' });
  });

  it('lost phone: the recovery QR on a new phone, the wait, then a normal Home once the guardian takes the new wallet over; the hardware wallet confirms it', async () => {
    const old = await onboarded(R1);
    R1.fund(old.svc.wallet!.multisig().derive(0, 0).script, 300_000n);
    await old.svc.sync();

    P = await phone({ clock: R1.clock, hardware: hw });
    const code = P.svc.readCode(encodeRecoveryUri({ guardianPubkey: R1.pubkey, relays: R1.relayUrls, network: 'regtest' }));
    if (code.kind !== 'recovery') throw new Error('not a recovery code');
    const started = await P.svc.startRecovery('phone', { guardian: code.guardian, hardwareKind: 'simulated' });
    expect(P.svc.getState()).toMatchObject({ recovering: true, onboarded: false, recovery: { id: started.id } });

    // The delay passes; the guardian co-signs, broadcasts and takes the new wallet over.
    R1.clock.set(new Date(started.completesAt).getTime() + 2 * HOUR);
    await R1.mine(11);
    await R1.guardian.tick();
    await waitFor(() => P.svc.getState().recoveryOutcome === 'finished' || undefined, 'the switch to the new wallet', 15_000);
    const s = P.svc.getState();
    expect(s).toMatchObject({ recovering: false, onboarded: true, recovery: null, hardwareConfirmRequired: true, finishedRecovery: { lostKey: 'phone' } });
    expect(s.finishedRecovery!.movedSats).toBeGreaterThan(290_000);
    await waitFor(() => P.svc.getState().balanceSats === s.finishedRecovery!.movedSats || undefined, 'the new wallet synced');
    expect(eventKinds(P)).toContain('recovery-finished');
    expect(s.receiveAddress).toBe(''); // until the hardware wallet has seen the new wallet

    await P.svc.confirmHardware();
    expect(P.svc.getState()).toMatchObject({ hardwareConfirmRequired: false, addressVerified: true });
    expect(P.svc.getState().receiveAddress).toBe(P.svc.wallet!.multisig().derive(0, P.svc.wallet!.state.chain!.nextReceiveIndex).address);
    expect(eventKinds(P)).toContain('hardware-confirmed');
    expect(P.prompts.some((p) => /Trikey pair v1 wallet=/.test(p.detail ?? ''))).toBe(true);

    const q = P.svc.quoteSend({ address: externalAddress(), amountSats: 20_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
    const tx = await P.svc.sendPayment(q.quote);
    expect(P.svc.getState().activity.find((i) => i.type === 'payment' && i.tx.id === tx.id)).toMatchObject({
      tx: { kind: 'sent', signedBy: 'phone+guardian', address: externalAddress() },
    });
    await old.svc.close();
  });

  it('locks the guardian from the phone, shows it, and unlocks it with the passphrase', async () => {
    await P.svc.lockGuardian();
    expect(R1.guardian.locked).toBe(true);
    expect(P.svc.getState().guardian.status).toBe('locked');
    await waitFor(() => P.svc.getState().activity.find((i) => i.type === 'security' && i.event.kind === 'guardian-locked' && i.event.byPhone), 'the lock in the activity');
    await P.svc.unlockGuardian(R1.passphrase);
    expect(P.svc.getState().guardian.status).toBe('online');
    expect(R1.guardian.locked).toBe(false);
  });

  it('a backup for another network: refused, then restored after the person agrees to switch', async () => {
    await P.svc.createBackup('file');
    const code = P.svc.recoveryCode()!;
    const N = await phone({ clock: R1.clock, hardware: hw, mode: 'real', network: 'testnet' });
    expect(await N.svc.findBackup()).toMatchObject({ network: 'regtest' });
    const refused = await failure(N.svc.restoreFromBackup({ recoveryCode: code }));
    expect(refused).toMatchObject({ kind: 'network_mismatch', network: 'regtest', message: expect.stringMatching(/regtest/) });
    expect(N.svc.getState()).toMatchObject({ onboarded: false, network: 'testnet' });
    R1.clock.advance(6 * 60_000); // past the relays' memory of P's last requests
    await N.svc.restoreFromBackup({ recoveryCode: code }, undefined, { switchNetwork: true });
    expect(N.svc.getState()).toMatchObject({ onboarded: true, network: 'regtest' });
    expect(N.svc.wallet!.state.wallet!.walletId).toBe(P.svc.wallet!.state.wallet!.walletId);
    // The send log came along in the backup.
    await waitFor(() => N.svc.getState().synced || undefined, 'the restored phone syncs');
    expect(N.svc.getState().activity.some((i) => i.type === 'payment' && i.tx.signedBy === 'phone+guardian' && i.tx.address === externalAddress())).toBe(true);
    await N.svc.close();
  });

  it('replace guardian: scan, see the plan, run it with progress, and land on the new guardian; the old one says the wallet is retired', async () => {
    const Q = await onboarded(R2);
    R2.fund(Q.svc.wallet!.multisig().derive(0, 0).script, 150_000n);
    R2.fund(Q.svc.wallet!.multisig().derive(0, 1).script, 50_000n);
    await Q.svc.sync();
    const oldId = Q.svc.wallet!.state.wallet!.walletId;

    expect(await failure(Q.svc.previewReplaceGuardian('not a code'))).toMatchObject({ kind: 'pairing_invalid' });
    const plan = await Q.svc.previewReplaceGuardian(R3.pairingUri());
    expect(plan).toMatchObject({ oldGuardianReachable: true, movingSats: 200_000, coins: 2, newGuardian: { label: 'Test Guardian' } });
    expect(plan.steps.map((s) => s.step)).toEqual(['pair', 'sign', 'broadcast', 'retire', 'switch']);
    expect(Q.svc.getState().replace.plan).toEqual(plan);

    const seen: string[] = [];
    Q.svc.subscribe(() => {
      const st = Q.svc.getState().replace.step;
      if (st && seen.at(-1) !== st) seen.push(st);
    });
    const out = await Q.svc.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', oldWalletRetired: true });
    expect(seen).toEqual(['pair', 'sign', 'broadcast', 'retire', 'switch']);
    const s = Q.svc.getState();
    expect(s).toMatchObject({ replace: { plan: null, step: null, pending: null }, oldWallets: [{ id: oldId, retiredOnGuardian: true }], progress: null, onboarded: true });
    expect(s.guardian.npub).toBe(npubEncode(R3.pubkey));
    expect(s.walletRetired).toBeNull(); // the alert was about the old wallet, not this one
    expect(eventKinds(Q)).toContain('guardian-replaced');
    await waitFor(() => eventKinds(Q).includes('wallet-retired') || undefined, "the old guardian's wallet_retired alert");
    await waitFor(() => Q.svc.getState().balanceSats === (out.status === 'done' ? out.movedSats : -1) || undefined, 'the new wallet synced');
    expect(Q.svc.quoteSend({ address: externalAddress(), amountSats: 10_000, speed: 'normal' })).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
    // The old wallet stays listed; its stray coins need something that can read it.
    expect(await failure(Q.svc.sweepOldWallets())).toMatchObject({ kind: 'refused', message: expect.stringMatching(/no longer serves/) });
    await Q.svc.close();
  });

  it('replace guardian with the old one offline: the person confirms it is gone, the signed move waits, and goes out when the box is back', async () => {
    const dev2 = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    const Z = await onboarded(R4, new SoftwareHardwareProvider(dev2), 1500);
    R4.fund(Z.svc.wallet!.multisig().derive(0, 0).script, 80_000n);
    await Z.svc.sync();
    await R4.guardian.stop(); // the box goes away

    // R2 retired Q's wallet in the last test, so it pairs again.
    const plan = await Z.svc.previewReplaceGuardian(R2.pairingUri());
    expect(plan).toMatchObject({ oldGuardianReachable: false, movingSats: 80_000 });
    expect(await failure(Z.svc.replaceGuardian())).toMatchObject({ kind: 'guardian_unreachable' });
    expect(R2.guardian.engine.registration()).toBeUndefined();

    const waiting = await Z.svc.replaceGuardian({ oldGuardianGone: true });
    expect(waiting).toMatchObject({ status: 'waiting', movedSats: expect.any(Number) });
    expect(Z.svc.getState().replace.pending).toEqual({ guardianLabel: 'Test Guardian', signed: true, oldGuardianOffline: true });
    expect(Z.svc.getState().guardian.npub).toBe(npubEncode(R4.pubkey)); // not switched yet

    await R4.restart(); // back, locked; chain data and retiring work all the same
    const done = await Z.svc.replaceGuardian();
    expect(done).toMatchObject({ status: 'done', oldWalletRetired: true });
    expect(Z.svc.getState()).toMatchObject({ replace: { pending: null }, oldWallets: [{ retiredOnGuardian: true }] });
    expect(Z.svc.getState().guardian.npub).toBe(npubEncode(R2.pubkey));
    await Z.svc.close();
  });
});
