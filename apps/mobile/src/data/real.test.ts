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
import { SimplePoolRelayPool, encodeRecoveryUri, type RelayPool } from '@trikey/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { TX_OPTS } from '@trikey/core';
import { createOutputs, receiverAddress, silentPaymentKeysFromSeed } from '@trikey/silent-payments';
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
import type { DevicePrompt, WalletState } from './types';

const MNEMONICS = {
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  hardware2: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Generous: the guardian rig and the wallet share one machine with the other test files, and a busy one is slow.
// `detail` says what was there instead, so a timeout in CI (where only the message is kept) shows why.
async function waitFor<T>(fn: () => T | undefined | false, what: string, detail?: () => unknown, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      let seen = '';
      try {
        seen = detail ? `; instead: ${JSON.stringify(detail(), (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}` : '';
      } catch (e) {
        seen = `; (detail failed: ${String(e)})`;
      }
      throw new Error(`timed out waiting for ${what}${seen}`);
    }
    await sleep(20);
  }
}

/** The parts of a phone's state that say where a flow stands, for `waitFor`'s timeout message. */
const where = (svc: { getState(): WalletState }) => () => {
  const s = svc.getState();
  return {
    onboarded: s.onboarded,
    recovering: s.recovering,
    recoveryOutcome: s.recoveryOutcome,
    synced: s.synced,
    balanceSats: s.balanceSats,
    guardian: s.guardian.status,
    progress: s.progress,
    finishedRecovery: s.finishedRecovery ? { movedSats: s.finishedRecovery.movedSats } : null,
  };
};

/**
 * Relay pools for a phone whose next publish can be held back, as a relay that swallowed a request would: the call it
 * carries is still waiting when the test moves on, and fails (no relay took it) when the test lets go of it.
 */
function relayGate() {
  const held: (() => void)[] = [];
  let toHold = 0;
  return {
    held,
    holdNext(n = 1) {
      toHold = n;
    },
    failHeld() {
      for (const fail of held.splice(0)) fail();
    },
    pool: (): RelayPool => {
      const inner = new SimplePoolRelayPool();
      return {
        publish(relays, event) {
          if (toHold === 0) return inner.publish(relays, event);
          toHold--;
          return new Promise((resolve) => held.push(() => resolve(relays.map((relay) => ({ relay, ok: false, reason: 'held back by the test' })))));
        },
        subscribe: (relays, filter, handlers) => inner.subscribe(relays, filter, handlers),
        close: () => inner.close(),
      };
    },
  };
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
    relayPool?: () => RelayPool;
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
    ...(opts.relayPool ? { relayPool: opts.relayPool } : {}),
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

    const alert = await waitFor(() => A.svc.getState().recovery, 'A hears of the recovery', where(A.svc));
    expect(alert).toMatchObject({ id: started.id, origin: 'someone-else', acknowledged: false, lostKey: 'phone' });
    A.svc.acknowledgeRecovery();
    expect(A.svc.getState().recovery?.acknowledged).toBe(true);

    await A.svc.cancelRecovery();
    await waitFor(() => A.svc.getState().phoneSpending === 'paused_contested' || undefined, 'contested', where(A.svc));
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
    await waitFor(() => P.svc.getState().synced || undefined, 'the restored phone syncs', where(P.svc));
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
    // Mainnet is the person's pick in real mode (see real-mainnet.test.ts); its warning's answer goes when the network changes.
    real.setNetwork('bitcoin');
    expect(real.getState()).toMatchObject({ network: 'bitcoin', mainnetRiskAccepted: false });
    real.acceptMainnetRisk(true);
    expect(real.getState().mainnetRiskAccepted).toBe(true);
    real.setNetwork('signet');
    expect(real.getState()).toMatchObject({ network: 'signet', mainnetRiskAccepted: false });
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

  it('wallet details: the descriptor and the three fingerprints, for recovering in another wallet', async () => {
    const own4 = await GuardianRig.start();
    const ownDevice = new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' }));
    const p = await phone({ clock: own4.clock, hardware: ownDevice });
    expect(p.svc.getWalletDetails()).toBeNull();
    await p.svc.connectHardware('simulated');
    await p.svc.pairGuardian(own4.pairingUri());
    await p.svc.setUpRules(100_000, 7);
    const d = p.svc.getWalletDetails()!;
    const keys = p.svc.wallet!.multisig().keys;
    expect(d).toMatchObject({ network: 'regtest', walletId: p.svc.wallet!.state.wallet!.walletId });
    expect(d.descriptor).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(d.descriptor).toMatch(/#[a-z0-9]{8}$/);
    expect(d.fingerprints).toEqual({ phone: keys.app.fingerprint, hardware: keys.hardware.fingerprint, guardian: keys.cosigner.fingerprint });
    for (const fp of Object.values(d.fingerprints)) expect(fp).toMatch(/^[0-9a-f]{8}$/);
    await p.svc.close();
    await own4.stop();
  });

  it('onboarding contacts chosen before pairing go to the guardian with the first rules, with their names on the phone', async () => {
    // Its own guardian and its own device: the shared ones are paired and registered by the tests below.
    const own3 = await GuardianRig.start();
    const ownDevice = new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' }));
    const p = await phone({ clock: own3.clock, hardware: ownDevice });
    const ana = npubEncode(bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(11), true).slice(1)));
    const own = npubEncode(bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(12), true).slice(1)));
    expect(() => p.svc.setOnboardingContacts([{ name: 'Nope', npub: 'npub1nothing' }])).toThrow(WalletServiceError);
    p.svc.setOnboardingContacts([
      { name: 'Ana', npub: ana },
      { name: 'My other phone', npub: own },
      { name: 'Ana again', npub: ana }, // duplicates are dropped
    ]);
    await p.svc.connectHardware('simulated');
    await p.svc.pairGuardian(own3.pairingUri());
    await p.svc.setUpRules(100_000, 7);
    const pubkeys = (await p.svc.wallet!.getRules()).policy.alertContacts;
    expect(pubkeys).toHaveLength(2);
    expect(p.svc.getState().contacts.map((c) => ({ name: c.name, npub: c.npub }))).toEqual(
      expect.arrayContaining([
        { name: 'Ana', npub: ana },
        { name: 'My other phone', npub: own },
      ]),
    );
    await p.svc.close();
    await own3.stop();
  });

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
    await waitFor(() => P.svc.getState().recoveryOutcome === 'finished' || undefined, 'the switch to the new wallet', where(P.svc));
    const s = P.svc.getState();
    expect(s).toMatchObject({ recovering: false, onboarded: true, recovery: null, hardwareConfirmRequired: true, finishedRecovery: { lostKey: 'phone' } });
    expect(s.finishedRecovery!.movedSats).toBeGreaterThan(290_000);
    await waitFor(() => P.svc.getState().balanceSats === s.finishedRecovery!.movedSats || undefined, 'the new wallet synced', where(P.svc));
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

  it('lost phone: a sync under way when the guardian takes the new wallet over fails late; the new wallet still syncs and shows the guardian online', async () => {
    // Its own guardian and device: the shared ones carry on with P below. The phone's calls wait long enough for the
    // test, not the clock, to decide when the held one fails.
    const own = await GuardianRig.start();
    const ownDevice = new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' }));
    const old = await onboarded(own, ownDevice);
    own.fund(old.svc.wallet!.multisig().derive(0, 0).script, 300_000n);
    await old.svc.sync();
    await old.svc.close();

    const gate = relayGate();
    const N = await phone({ clock: own.clock, hardware: ownDevice, relayPool: gate.pool, rpcTimeoutMs: 20_000 });
    let syncs = 0;
    let wasSyncing = false;
    N.svc.subscribe(() => {
      const now = N.svc.getState().syncing;
      if (now && !wasSyncing) syncs++;
      wasSyncing = now;
    });
    const code = N.svc.readCode(encodeRecoveryUri({ guardianPubkey: own.pubkey, relays: own.relayUrls, network: 'regtest' }));
    if (code.kind !== 'recovery') throw new Error('not a recovery code');
    const started = await N.svc.startRecovery('phone', { guardian: code.guardian, hardwareKind: 'simulated' });
    await waitFor(() => (syncs >= 1 && !N.svc.getState().syncing) || undefined, 'the sync after starting the recovery', where(N.svc));
    // The refreshes after the "recovery started" alert settle too: a message on its way while the clock jumps a week
    // would expire on the relays, and its call would only end at its timeout.
    await sleep(500);

    // The delay passes. The access the hardware wallet gave this phone (half a day) is renewed, so the guardian answers
    // it right up to the switch.
    own.clock.set(new Date(started.completesAt).getTime() + 2 * HOUR);
    await N.svc.renewRecoveryAccess();

    // A sync starts just before the guardian takes the new wallet over; its request is lost on the way.
    gate.holdNext();
    const stale = N.svc.sync();
    await waitFor(() => gate.held.length === 1 || undefined, 'the sync request held back');
    await own.mine(11);
    await own.guardian.tick();
    await waitFor(() => N.svc.getState().recoveryOutcome === 'finished' || undefined, 'the switch to the new wallet', where(N.svc));
    const moved = N.svc.getState().finishedRecovery!.movedSats;
    expect(moved).toBeGreaterThan(290_000);

    // Only now does the old sync fail. The switch asked for a sync of the new wallet: it must still run.
    gate.failHeld();
    await stale;
    await waitFor(() => (N.svc.getState().balanceSats === moved && N.svc.getState().guardian.status === 'online') || undefined, 'the new wallet synced', where(N.svc), 10_000);
    expect(N.svc.getState()).toMatchObject({ synced: true, onboarded: true, guardian: { status: 'online' } });
    await N.svc.close();
    await own.stop();
  });

  it('locks the guardian from the phone, shows it, and unlocks it with the passphrase', async () => {
    await P.svc.lockGuardian();
    expect(R1.guardian.locked).toBe(true);
    expect(P.svc.getState().guardian.status).toBe('locked');
    await waitFor(() => P.svc.getState().activity.find((i) => i.type === 'security' && i.event.kind === 'guardian-locked' && i.event.byPhone), 'the lock in the activity', where(P.svc));
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
    await waitFor(() => N.svc.getState().synced || undefined, 'the restored phone syncs', where(N.svc));
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
    await waitFor(() => Q.svc.getState().balanceSats === (out.status === 'done' ? out.movedSats : -1) || undefined, 'the new wallet synced', where(Q.svc));
    expect(Q.svc.quoteSend({ address: externalAddress(), amountSats: 10_000, speed: 'normal' })).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
    // The old wallet stays listed; its stray coins need something that can read it.
    // The new guardian watches the old wallet, so stray coins can still be found and moved through it.
    expect(await Q.svc.sweepOldWallets()).toEqual({ movedSats: 0 });
    await Q.svc.close();
  });

  it('replace guardian with the old one offline: the person confirms it is gone, the new guardian sends the move, and the old wallet is retired when the box is back', async () => {
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

    // The new guardian watches the old wallet and relays its sweep, so nothing has to wait for the old box.
    const done = await Z.svc.replaceGuardian({ oldGuardianGone: true });
    expect(done).toMatchObject({ status: 'done', movedSats: expect.any(Number), oldWalletRetired: false });
    expect(Z.svc.getState()).toMatchObject({ replace: { pending: null }, oldWallets: [{ retiredOnGuardian: false }] });
    expect(Z.svc.getState().guardian.npub).toBe(npubEncode(R2.pubkey));

    await R4.restart(); // the old box comes back, locked: retiring the old wallet works all the same
    await Z.svc.retireOldWallet();
    expect(Z.svc.getState().oldWallets).toMatchObject([{ retiredOnGuardian: true }]);
    await Z.svc.close();
  });
});

describe('the real wallet service: silent payments', { timeout: 120_000 }, () => {
  let R: GuardianRig;
  let N: GuardianRig;
  let S: Phone;
  const events = (p: Phone) => p.svc.getState().activity.flatMap((i) => (i.type === 'payment' ? [i.tx] : []));
  /** Somebody outside pays silent payment addresses: a coin funded from nowhere, spent to 30,000 sats per recipient. */
  let seed = 1;
  const outsidePayment = (rig: GuardianRig, to: string) => {
    const key = sha256(new TextEncoder().encode(`outside payer ${seed++}`));
    const script = btc.p2wpkh(secp256k1.getPublicKey(key, true)).script;
    const coin = rig.fund(script, 200_000n);
    const out = createOutputs({ inputs: [{ txid: coin.txid, vout: 0, prevoutScript: script, privateKey: key }], recipients: [to], network: 'regtest' });
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script, amount: 200_000n } });
    tx.addOutput({ script: out.outputs[0]!.script, amount: 30_000n });
    tx.addOutput({ script, amount: 168_000n });
    tx.signIdx(key, 0);
    tx.finalize();
    expect(rig.electrs.applyTransaction(hex.encode(tx.extract()))).toBeUndefined();
    return tx.id;
  };
  const recipient = receiverAddress(silentPaymentKeysFromSeed(sha256(new TextEncoder().encode('someone else')), { coinType: 1 }), 'regtest');

  async function onboard(rig: GuardianRig, hw: SoftwareHardwareProvider): Promise<Phone> {
    const p = await phone({ clock: rig.clock, hardware: hw });
    await p.svc.connectHardware('simulated');
    await p.svc.pairGuardian(rig.pairingUri());
    await p.svc.setUpRules(100_000, 7);
    rig.fund(p.svc.wallet!.multisig().derive(0, 0).script, 500_000n);
    await p.svc.sync();
    return p;
  }

  it('is off until turned on; turning on registers with the guardian, gives an address and a helper address', async () => {
    R = await GuardianRig.start({ bitcoind: true });
    S = await onboard(R, new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' })));
    expect(S.svc.getState().silentPayments).toMatchObject({ support: 'full', setUp: false, receiving: false, scan: { state: 'off' } });
    await S.svc.silentPayments!.enable();
    expect(R.guardian.sp.registered).toBe(true);
    const sp = S.svc.getState().silentPayments;
    expect(sp).toMatchObject({ setUp: true, receiving: true, helper: { funded: false, viaGuardian: true }, balance: { sats: 0 } });
    expect(sp.scan.source).toBe('guardian');
    expect(await S.svc.silentPayments!.address()).toMatch(/^tsp1q/);
    expect(await S.svc.silentPayments!.helperAddress()).toMatch(/^bcrt1q/);
  });

  it('a silent payment needs the helper coin: before it is funded the quote says so, after, the guardian co-signs it', async () => {
    const before = S.svc.quoteSend({ address: recipient, amountSats: 20_000, speed: 'normal' });
    expect(before).toMatchObject({ ok: false, problem: 'needs_helper', message: expect.stringContaining('helper') });
    const address = await S.svc.silentPayments!.helperAddress();
    R.fund(btc.OutScript.encode(btc.Address(NETWORKS.regtest.btc).decode(address)), 30_000n);
    await S.svc.sync();
    expect(S.svc.getState().silentPayments.helper).toMatchObject({ sats: 30_000, funded: true });
    const q = S.svc.quoteSend({ address: recipient, amountSats: 20_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' }, silentPayment: { outputAddress: expect.stringMatching(/^bcrt1p/), helperFeeSats: expect.any(Number) } } });
    if (!q.ok) return;
    const tx = await S.svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ address: recipient, signedBy: 'phone+guardian' });
    await R.mine(1);
    await S.svc.sync();
    expect(events(S).find((t) => t.txid === tx.txid)).toMatchObject({ kind: 'sent', address: recipient, silentOutputAddress: q.quote.silentPayment!.outputAddress });
  });

  it('a payment arrives: it waits in its own balance, then one tap moves it into the vault', async () => {
    const mine = await S.svc.silentPayments!.address();
    const txid = outsidePayment(R, mine);
    await R.mine(1);
    await waitFor(() => S.svc.getState().silentPayments.balance.sats === 30_000 || undefined, 'the payment to show up');
    expect(events(S).find((t) => t.kind === 'silent_received')).toMatchObject({ amountSats: 30_000, txid });
    const plan = S.svc.getState().silentPayments.move;
    expect(plan).toMatchObject({ ready: 1 });
    expect(plan.totalNetSats).toBe(30_000 - plan.totalFeeSats);
    const vaultBefore = S.svc.getState().balanceSats;
    const r = await S.svc.silentPayments!.move();
    expect(r).toMatchObject({ moved: 1, movedSats: plan.totalNetSats, feeSats: plan.totalFeeSats, failed: 0 });
    await R.mine(1);
    await S.svc.sync();
    expect(S.svc.getState().balanceSats).toBe(vaultBefore + plan.totalNetSats);
    expect(S.svc.getState().silentPayments.balance.sats).toBe(0);
    expect(events(S).find((t) => t.kind === 'silent_sweep')).toMatchObject({ amountSats: plan.totalNetSats, feeSats: plan.totalFeeSats, status: 'confirmed' });
  });

  it('adds a label, turns receiving off (the guardian forgets the key) and refuses an address while it is off', async () => {
    const { label, address } = await S.svc.silentPayments!.addLabel();
    expect(label).toBe(1);
    expect(address).not.toBe(await S.svc.silentPayments!.address());
    expect(S.svc.getState().silentPayments.labels).toEqual([1]);
    await S.svc.silentPayments!.disable();
    expect(R.guardian.sp.registered).toBe(false);
    expect(S.svc.getState().silentPayments).toMatchObject({ receiving: false, scan: { state: 'off' } });
    expect(await failure(S.svc.silentPayments!.address())).toMatchObject({ kind: 'silent_payments_off' });
    await S.svc.silentPayments!.enable();
    expect(R.guardian.sp.registered).toBe(true);
  });

  it('a guardian without its node RPC: receiving is paused with the reason, sending still works', async () => {
    N = await GuardianRig.start();
    const P = await onboard(N, new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' })));
    await P.svc.silentPayments!.enable(); // does not fail
    const sp = P.svc.getState().silentPayments;
    expect(sp).toMatchObject({ setUp: true, receiving: true, scan: { state: 'needs_node_rpc', source: 'guardian', message: expect.stringContaining('RPC') }, helper: { viaGuardian: true } });
    expect(await failure(P.svc.silentPayments!.check())).toMatchObject({ kind: 'node_rpc_required', message: expect.stringContaining('Umbrel and Start9') });
    const address = await P.svc.silentPayments!.helperAddress();
    N.fund(btc.OutScript.encode(btc.Address(NETWORKS.regtest.btc).decode(address)), 30_000n);
    await P.svc.sync();
    expect(P.svc.quoteSend({ address: recipient, amountSats: 10_000, speed: 'normal' })).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
    await N.stop();
  });

  it('reads silent payment codes through the wallet', () => {
    expect(S.svc.readCode(recipient)).toMatchObject({ kind: 'address', address: recipient, silentPayment: true });
    expect(S.svc.readCode(`bitcoin:?sp=${recipient}&amount=0.0002`)).toMatchObject({ kind: 'address', address: recipient, silentPayment: true, amountSats: 20_000 });
    expect(S.svc.readCode(receiverAddress(silentPaymentKeysFromSeed(new Uint8Array(32).fill(3), { coinType: 0 }), 'bitcoin'))).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('mainnet') });
  });

  it('closes down', async () => {
    await S.svc.close();
    await R.stop();
  });
});

describe('the real wallet service: send max, and coins that arrive while a recovery waits', { timeout: 180_000 }, () => {
  // Its own guardian and its own devices: the shared ones are paired and registered by the tests above.
  const ownDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const ownProvider = new SoftwareHardwareProvider(ownDevice);
  const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
  let G: GuardianRig;
  let P: Phone;
  const fund = (index: number, sats: number) => G.fund(P.svc.wallet!.multisig().derive(0, index).script, BigInt(sats));
  const scriptHash = (script: Uint8Array) => hex.encode(sha256(script).reverse());
  const to = externalAddress(6);

  beforeAll(async () => {
    // The phones of the tests above are done, and some of their guardians are stopped: a phone left open would keep
    // knocking on a relay that is gone (and nostr-tools' pool fails badly at that, long after its own test).
    for (const s of opened) await s.close();
    G = await GuardianRig.start();
    P = await phone({ clock: G.clock, hardware: ownProvider });
    await P.svc.connectHardware('simulated');
    await P.svc.pairGuardian(G.pairingUri());
    await P.svc.setUpRules(100_000, 7);
  }, 60_000);

  afterAll(async () => {
    await P?.svc.close();
    await G?.stop();
  });

  const quoted = (address: string, speed: 'slow' | 'normal' | 'fast') => {
    const out = P.svc.quoteSendMax({ address, speed });
    if (!out.ok) throw new Error(out.message);
    return out.quote;
  };

  it('quotes the whole balance minus the fee at each speed, with the amount filled in, and gives the same quote for the same coins', async () => {
    fund(0, 40_000);
    fund(1, 15_000);
    await P.svc.sync();
    const fees: number[] = [];
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const q = quoted(to, speed);
      expect(q).toMatchObject({ max: true, totalSats: 55_000, request: { address: to, speed, amountSats: 55_000 - q.feeSats }, plan: { signer: 'phone+guardian' }, ref: expect.any(String) });
      expect(q.feeRateSatPerVb).toBeGreaterThan(0);
      fees.push(q.feeSats);
    }
    expect(fees[0]).toBeLessThan(fees[1]!);
    expect(fees[1]).toBeLessThan(fees[2]!);
    const a = P.svc.quoteSendMax({ address: to, speed: 'normal' });
    expect(P.svc.quoteSendMax({ address: to, speed: 'normal' })).toBe(a); // nothing changed: nothing is made again
    // An ordinary quote of the same address is a different thing, and is not a send max.
    const ordinary = P.svc.quoteSend({ address: to, amountSats: 10_000, speed: 'normal' });
    expect(ordinary).not.toBe(a);
    expect(ordinary.ok && ordinary.quote.max).toBeFalsy();
  });

  it('sends it with the phone and the guardian: every coin goes, the vault is empty, and the guardian counted what left', async () => {
    const q = quoted(to, 'normal');
    const used = G.guardian.engine.status().dailyLimit!.used;
    const tx = await P.svc.sendPayment(q);
    expect(tx).toMatchObject({ kind: 'sent', address: to, amountSats: q.request.amountSats, feeSats: q.feeSats, signedBy: 'phone+guardian' });
    expect(G.guardian.engine.status().dailyLimit!.used - used).toBe(55_000n);
    await G.mine(1);
    await P.svc.sync();
    expect(P.svc.getState().balanceSats).toBe(0);
    expect(P.svc.wallet!.snapshot()!.utxos).toEqual([]);
    expect(P.svc.getState().activity.find((i) => i.type === 'payment' && i.tx.id === tx.id)).toMatchObject({ tx: { amountSats: q.request.amountSats, signedBy: 'phone+guardian' } });
  });

  it('plans the hardware wallet over the limit, and signs it there', async () => {
    fund(2, 120_000);
    fund(3, 30_000);
    await P.svc.sync();
    const q = quoted(to, 'fast');
    expect(q).toMatchObject({ totalSats: 150_000, plan: { signer: 'hardware', reason: 'over-limit' } });
    const prompts = P.prompts.length;
    const tx = await P.svc.sendPayment(q);
    expect(tx).toMatchObject({ amountSats: 150_000 - q.feeSats, signedBy: 'phone+hardware' });
    expect(P.prompts.length).toBeGreaterThan(prompts);
    await G.mine(1);
    await P.svc.sync();
    expect(P.svc.getState().balanceSats).toBe(0);
  });

  it('is stale when the coins changed, and never sends from a quote the wallet no longer holds', async () => {
    fund(4, 20_000);
    await P.svc.sync();
    const q = quoted(to, 'normal');
    expect(await failure(P.svc.sendPayment({ ...q, ref: undefined }))).toMatchObject({ kind: 'quote_stale' });
    fund(5, 5_000); // a coin arrives: this quote would leave it behind
    await P.svc.sync();
    expect(await failure(P.svc.sendPayment(q))).toMatchObject({ kind: 'quote_stale' });
    const again = quoted(to, 'normal');
    expect(again.totalSats).toBe(25_000);
    await P.svc.sendPayment(again);
    await G.mine(1);
    await P.svc.sync();
    expect(P.svc.getState().balanceSats).toBe(0);
  });

  it('says in words why there is no send max: nothing to send, a bad address, a silent payment address without a helper, less than dust', async () => {
    expect(P.svc.quoteSendMax({ address: to, speed: 'normal' })).toMatchObject({ ok: false, problem: 'insufficient_funds', message: expect.stringContaining('nothing to send') });
    const sp = receiverAddress(silentPaymentKeysFromSeed(sha256(new TextEncoder().encode('someone else')), { coinType: 1 }), 'regtest');
    fund(6, 30_000);
    await P.svc.sync();
    expect(P.svc.quoteSendMax({ address: 'nonsense', speed: 'normal' })).toMatchObject({ ok: false, problem: 'invalid_address' });
    expect(P.svc.quoteSendMax({ address: sp, speed: 'normal' })).toMatchObject({ ok: false, problem: 'needs_helper', message: expect.stringContaining('helper') });
    await P.svc.sendPayment(quoted(to, 'normal'));
    await G.mine(1);
    await P.svc.sync();
    // 700 sats: the fee of one input at the slow rate (about 735) eats it whole.
    fund(7, 700);
    await P.svc.sync();
    expect(P.svc.quoteSendMax({ address: to, speed: 'slow' })).toMatchObject({ ok: false, problem: 'amount_too_small', message: expect.stringMatching(/smallest payment/) });
  });

  describe('a recovery with coins arriving', () => {
    let oldWallet: NonNullable<RealWalletService['wallet']> extends { multisig(): infer M } ? M : never;
    const update = () => P.svc.getState().recovery?.sweepUpdate;
    const moving = () => {
      const r = P.svc.wallet!.state.recovery!.recovery!;
      return r.amountSats + r.feeSats;
    };

    it('starts it with a new hardware wallet and moves the whole vault, dust included', async () => {
      fund(8, 200_000);
      await P.svc.sync();
      oldWallet = P.svc.wallet!.multisig();
      ownProvider.device = newDevice;
      const r = await P.svc.startRecovery('hardware', { hardwareKind: 'simulated' });
      ownProvider.device = ownDevice;
      expect(r).toMatchObject({ origin: 'this-phone', lostKey: 'hardware', state: 'pending' });
      expect(moving()).toBe(200_700);
      expect(r.sweepUpdate).toBeUndefined();
    });

    it('a coin that cannot be added shows as waiting and then as refused, in words, when the phone key is not unlocked', async () => {
      const seen: (string | undefined)[] = [];
      const stop = P.svc.subscribe(() => seen.push(update()?.status));
      P.secure.cancelNextPrompt = true; // the person cancels the fingerprint prompt
      fund(9, 900);
      await P.svc.sync();
      const refused = await waitFor(() => (update()?.status === 'refused' ? update() : undefined), 'the refusal in the state');
      stop();
      expect(seen).toContain('waiting');
      expect(refused).toMatchObject({ coins: 1, text: expect.stringContaining('1 new coin arrived but could not be added to your recovery') });
      expect(refused.text).toMatch(/phone key couldn't be unlocked/);
      expect(refused.text).toMatch(/can't finish until it is added/);
      expect(moving()).toBe(200_700); // the move is as it was
    });

    it('is tried again after a while, and then says that the coin was added', async () => {
      await P.svc.sync();
      expect(update()?.status).toBe('refused'); // not at once: the person just said no
      G.clock.advance(11 * 60_000);
      await P.svc.sync();
      const added = await waitFor(() => (update()?.status === 'added' ? update() : undefined), 'the coin to be added');
      expect(added).toEqual({ status: 'added', coins: 1, text: '1 new coin was added to your recovery' });
      expect(moving()).toBe(201_600);
    });

    it('another coin adds itself on the next refresh, and the wait is the one it started with', async () => {
      const started = P.svc.getState().recovery!;
      fund(10, 33_000);
      await P.svc.sync();
      await waitFor(() => (moving() === 234_600 ? true : undefined), 'the second update');
      const s = P.svc.getState().recovery!;
      expect(s.sweepUpdate).toEqual({ status: 'added', coins: 1, text: '1 new coin was added to your recovery' });
      expect(s).toMatchObject({ id: started.id, startedAt: started.startedAt, completesAt: started.completesAt });
      expect(s.movingSats).toBeGreaterThan(started.movingSats + 30_000);
    });

    it('finishes: everything moved to the new wallet, nothing left in the old one', async () => {
      const r = P.svc.getState().recovery!;
      G.clock.set(new Date(r.completesAt).getTime() + 2 * HOUR);
      await G.mine(11);
      await G.guardian.tick();
      await waitFor(() => (P.svc.getState().recoveryOutcome === 'finished' ? true : undefined), 'the switch to the new wallet');
      const left: string[] = [];
      for (const chain of [0, 1]) for (let i = 0; i < 14; i++) for (const u of G.electrs.unspent.get(scriptHash(oldWallet.derive(chain, i).script)) ?? []) left.push(`${u.txid}:${u.vout}`);
      expect(left).toEqual([]);
      const moved = P.svc.getState().finishedRecovery!.movedSats;
      await waitFor(() => (P.svc.getState().balanceSats === moved ? true : undefined), 'the new wallet to hold it');
      expect(moved).toBeGreaterThan(234_600 - 20_000);
    });
  });
});
