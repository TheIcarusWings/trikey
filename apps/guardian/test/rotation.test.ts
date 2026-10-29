/**
 * Wallet rotation in the policy engine: one active wallet plus retired ones.
 * Migration of the single-wallet (v1) state, adopting a recovery's destination,
 * the fresh hardware proof required before loosening rules again, revoked
 * recovery access, retiring a wallet ("Replace guardian"), and reset.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, buildSweep } from '@trikey/core';
import {
  JsonFileStore,
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  deserializeState,
  pairingMessage,
  recoveryAccessMessage,
  serializeState,
  signMessage,
  type GuardianStateV1,
  type HardwareApproval,
  type Rules,
  type StateStore,
} from '../src/policy/index.js';
import {
  APP_NOSTR,
  AUTH_PATH,
  CONTACT_A,
  COSIGNER_PRIV,
  Ctx,
  DAY,
  DEFAULT_RULES,
  MNEMONICS,
  OTHER_COSIGNER_PRIV,
  T0,
  appSigner,
  approve,
  externalAddress,
  fund,
  hwAuthPrivateKey,
  hwAuthPubkey,
  hwSigner,
  makeWallet,
  network,
  nostrKey,
  phoneSpend,
  setup,
  spendPsbt,
} from './helpers.js';

const NEW_PHONE = nostrKey(21);
const GUARDIAN_NOSTR = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(31)));
const cosignerPub = () => hex.encode(new SoftwareCosignerSigner(COSIGNER_PRIV).accountPubkey);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-rotation-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Survivor = 'hardware' | 'app';

/** Runs a recovery of the active wallet to `dest` all the way to "completed". */
async function recoverTo(ctx: Ctx, survivor: Survivor, dest: MultisigWallet, opts: { initiator?: string; index?: number } = {}) {
  const utxos = [fund(ctx.wallet, RECEIVE, opts.index ?? 10, 400_000n)];
  const plan = buildSweep({ from: ctx.wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 });
  const signer = survivor === 'hardware' ? hwSigner() : appSigner();
  const started = await ctx.engine.startRecovery({ psbt: await signer.signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: opts.initiator });
  if (!started.ok) throw new Error(`start: ${JSON.stringify(started.refusal)}`);
  ctx.clock.set(started.recovery.readyAt);
  const done = await ctx.engine.completeRecovery();
  if (!done.ok) throw new Error(`complete: ${JSON.stringify(done.refusal)}`);
  return started.recovery.id;
}

/** An access approval signed by the (old) hardware wallet's authorization key. */
function access(ctx: Ctx, phone: string, inSec = 3600, priv = hwAuthPrivateKey()) {
  const expiresAt = Math.floor(ctx.clock.now() / 1000) + inSec;
  return { kind: 'bip137', expiresAt, signature: signMessage(recoveryAccessMessage({ guardianPubkey: GUARDIAN_NOSTR, phonePubkey: phone, expiresAt }), priv) };
}

describe('state migration from the single-wallet format', () => {
  async function v1State(): Promise<{ text: string; wallet: MultisigWallet; walletId: string; spendOutflow: bigint }> {
    const wallet = await makeWallet();
    const walletId = wallet.fingerprint();
    const v1: GuardianStateV1 = {
      version: 1,
      registration: {
        walletId,
        network: 'regtest',
        descriptor: wallet.descriptor(),
        cosignerAccountPubkey: cosignerPub(),
        hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
        appNostrPubkey: APP_NOSTR,
        registeredAt: T0 - DAY,
      },
      rules: DEFAULT_RULES,
      hardwareSequence: 4,
      spends: [{ txid: 'aa'.repeat(32), at: T0 - 3_600_000, outflow: 30_000n, shares: [{ outpoint: `${'bb'.repeat(32)}:0`, share: 30_000n }] }],
      recoveries: [],
      phoneSpending: { state: 'enabled' },
      activity: [{ id: 1, at: T0 - DAY, type: 'registered', walletId }],
      nextActivityId: 2,
    };
    return { text: serializeState(v1 as never), wallet, walletId, spendOutflow: 30_000n };
  }

  it('turns the saved wallet into the active one, keeping rules, limit usage, sequence and log', async () => {
    const { text, walletId } = await v1State();
    const s = deserializeState(text);
    expect(s.version).toBe(2);
    expect(s.retired).toEqual([]);
    expect(s.active?.registration).toMatchObject({ walletId, appNostrPubkey: APP_NOSTR, hardwareAuthConfirmed: true, origin: { kind: 'paired' } });
    expect(s.active?.accessGrants).toEqual([]);
    expect(s.hardwareSequence).toBe(4);
    expect(s.activity).toHaveLength(1);
  });

  it('opens a v1 file, keeps working on it, and writes it back as version 2', async () => {
    const { text, wallet, walletId } = await v1State();
    const path = join(dir, 'guardian-state.json');
    await writeFile(path, text);
    const clock = new ManualClock(T0);
    const engine = await PolicyEngine.open({ store: new JsonFileStore(path), clock, signer: new SoftwareCosignerSigner(COSIGNER_PRIV) });
    expect(engine.status()).toMatchObject({ registered: true, walletId, nextHardwareSequence: 5, hardwareConfirmRequired: false, retiredWallets: 0 });
    expect(engine.status().dailyLimit!.used).toBe(30_000n);

    // Co-signing and hardware approvals work as before the migration.
    const spend = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 20_000n);
    expect(await engine.cosign(spend.psbt)).toMatchObject({ ok: true });
    const raised: Rules = { ...DEFAULT_RULES, dailyLimitSats: 150_000n };
    expect(await engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve({ clock, walletId }, { action: 'policy', rules: raised }, 5) })).toMatchObject({ ok: true });

    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.active.registration.walletId).toBe(walletId);
    expect(saved.registration).toBeUndefined();
  });

  it('tags v1 recoveries with the wallet, and a phone-started one with the paired phone', async () => {
    const { text } = await v1State();
    const v1 = JSON.parse(text);
    v1.recoveries = [
      { id: '1-aaaaaaaaaaaa', status: 'cancelled', survivingRole: 'app', recipients: [APP_NOSTR], alertsSent: {} },
      { id: '2-bbbbbbbbbbbb', status: 'cancelled', survivingRole: 'hardware', recipients: [APP_NOSTR], alertsSent: {} },
    ];
    const s = deserializeState(JSON.stringify(v1));
    expect(s.recoveries.map((r) => [r.walletId, r.initiator])).toEqual([
      [v1.registration.walletId, APP_NOSTR],
      [v1.registration.walletId, undefined],
    ]);
  });
});

describe('adopting the destination wallet after a recovery', () => {
  it('lost phone: the new phone becomes the paired phone, the rules carry over, grants are revoked', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const { engine } = ctx;
    const spent = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 200_000n)], 30_000n);
    expect((await engine.cosign(spent.psbt)).ok).toBe(true);

    // The new phone gets in with the hardware wallet, starts the recovery to a wallet of its own key 2.
    const granted = await engine.grantRecoveryAccess({ phonePubkey: NEW_PHONE, guardianPubkey: GUARDIAN_NOSTR, approval: access(ctx, NEW_PHONE) });
    expect(granted).toMatchObject({ ok: true, renewed: false });
    expect(engine.hasRecoveryAccess(NEW_PHONE)).toBe(true);
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const id = await recoverTo(ctx, 'hardware', dest, { initiator: NEW_PHONE });
    expect(engine.status().phoneSpending).toBe('retired');
    // A week passed: the phone renewed its access (as the wallet package does) to follow the recovery.
    expect(engine.hasRecoveryAccess(NEW_PHONE)).toBe(false);
    expect(await engine.grantRecoveryAccess({ phonePubkey: NEW_PHONE, guardianPubkey: GUARDIAN_NOSTR, approval: access(ctx, NEW_PHONE) })).toMatchObject({ ok: true });

    const rot = await engine.rotateAfterSweep(id);
    expect(rot).toMatchObject({ ok: true, retiredWalletId: ctx.walletId, revokedGrants: 1 });
    if (!rot.ok) return;
    expect(rot.adopted).toMatchObject({
      walletId: dest.fingerprint(),
      appNostrPubkey: NEW_PHONE,
      hardwareAuthConfirmed: false,
      // The hardware wallet survived: the same authorization key, still to be proven for this wallet.
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
      origin: { kind: 'recovery', recoveryId: id, fromWalletId: ctx.walletId },
    });
    expect(engine.status()).toMatchObject({ registered: true, walletId: dest.fingerprint(), phoneSpending: 'enabled', hardwareConfirmRequired: true, retiredWallets: 1 });
    expect(engine.status().rules).toEqual({ ...DEFAULT_RULES, dailyLimitSats: 100_000n });
    // Phone payments were paused for the whole delay, so the new wallet's 24 h window starts empty.
    expect(engine.status().dailyLimit!.used).toBe(0n);
    expect(engine.hasRecoveryAccess(NEW_PHONE)).toBe(false);
    expect(engine.recoveryPeers()).toEqual([]);
    expect(engine.retiredWallets()).toMatchObject([{ registration: { walletId: ctx.walletId }, retirement: { reason: 'recovered', recoveryId: id, successorWalletId: dest.fingerprint() } }]);
    expect(engine.walletById(ctx.walletId)?.walletId).toBe(ctx.walletId);
    expect(engine.activity()[0]).toMatchObject({ type: 'wallet_rotated', recoveryId: id, fromWalletId: ctx.walletId, toWalletId: dest.fingerprint(), phone: NEW_PHONE, revokedGrants: 1 });

    // Rotating twice, or for a recovery that did not complete, is refused.
    expect(await engine.rotateAfterSweep(id)).toMatchObject({ ok: false, refusal: { reason: 'not_adoptable' } });
    expect(await engine.rotateAfterSweep('9-000000000000')).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });

    // The new phone co-signs from the new wallet, within the carried-over limit.
    const plan = spendPsbt(dest, [fund(dest, RECEIVE, 0, 300_000n)], [{ address: externalAddress(), amount: 60_000n }]);
    const signed = await appSigner(MNEMONICS.app2).signPsbt(plan.psbt, network);
    expect(await engine.cosign(signed)).toMatchObject({ ok: true });
    const big = spendPsbt(dest, [fund(dest, RECEIVE, 1, 300_000n)], [{ address: externalAddress(), amount: 40_000n }]);
    expect(await engine.cosign(await appSigner(MNEMONICS.app2).signPsbt(big.psbt, network))).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });

  it('requires a fresh pairing proof for the new wallet id before any hardware approval, then accepts them again', async () => {
    const ctx = await setup();
    const { engine, clock } = ctx;
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const id = await recoverTo(ctx, 'hardware', dest, { initiator: NEW_PHONE });
    expect((await engine.rotateAfterSweep(id)).ok).toBe(true);
    const walletId = dest.fingerprint();
    const seq = engine.status().nextHardwareSequence;

    // Loosening refused until confirmed, even with a valid approval; tightening from the phone still works.
    const raised: Rules = { ...DEFAULT_RULES, dailyLimitSats: 500_000n };
    const approval = approve({ clock, walletId }, { action: 'policy', rules: raised }, seq);
    expect(await engine.changeRules(raised, { authenticatedBy: 'hardware', approval })).toMatchObject({ ok: false, refusal: { reason: 'hardware_auth_unconfirmed', walletId } });
    expect(await engine.retireWallet(approve({ clock, walletId }, { action: 'retire-wallet' }, seq))).toMatchObject({ ok: false, refusal: { reason: 'hardware_auth_unconfirmed' } });
    expect(await engine.changeRules({ ...DEFAULT_RULES, dailyLimitSats: 50_000n }, { authenticatedBy: 'app' })).toMatchObject({ ok: true });
    expect(engine.status().nextHardwareSequence).toBe(seq); // nothing consumed

    const key = { kind: 'bip137' as const, pubkey: hwAuthPubkey(), path: AUTH_PATH };
    // The old wallet's proof does not count, nor a proof by another key, nor another key.
    expect(await engine.confirmHardwareAuth({ hardwareAuth: key, proof: signMessage(pairingMessage(ctx.walletId, cosignerPub()), hwAuthPrivateKey()) })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: 'hardware pairing proof does not verify' },
    });
    const otherPriv = hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2);
    expect(await engine.confirmHardwareAuth({ hardwareAuth: key, proof: signMessage(pairingMessage(walletId, cosignerPub()), otherPriv) })).toMatchObject({ ok: false });
    expect(
      await engine.confirmHardwareAuth({ hardwareAuth: { ...key, pubkey: hwAuthPubkey(AUTH_PATH, MNEMONICS.hardware2) }, proof: signMessage(pairingMessage(walletId, cosignerPub()), otherPriv) }),
    ).toMatchObject({ ok: false, refusal: { detail: 'not the authorization key the guardian expects for this wallet' } });
    expect(engine.status().hardwareConfirmRequired).toBe(true);

    const proof = signMessage(pairingMessage(walletId, cosignerPub()), hwAuthPrivateKey());
    expect(await engine.confirmHardwareAuth({ hardwareAuth: key, proof })).toMatchObject({ ok: true, changed: true });
    expect(engine.status().hardwareConfirmRequired).toBe(false);
    expect(await engine.confirmHardwareAuth({ hardwareAuth: key, proof })).toMatchObject({ ok: true, changed: false });

    // An approval for the OLD wallet id is no use; one for the new wallet is.
    expect(await engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve({ clock, walletId: ctx.walletId }, { action: 'policy', rules: raised }, seq) })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_invalid_signature' },
    });
    expect(await engine.changeRules(raised, { authenticatedBy: 'hardware', approval })).toMatchObject({ ok: true });
    expect(engine.status().nextHardwareSequence).toBe(seq + 1);
  });

  it('lost hardware wallet: derives the new device key at the same relative path, and the phone stays paired', async () => {
    const clock = new ManualClock(T0);
    const store = new MemoryStore();
    const engine = await PolicyEngine.open({ store, clock, signer: new SoftwareCosignerSigner(COSIGNER_PRIV) });
    const wallet = await makeWallet();
    const walletId = wallet.fingerprint();
    // The wallet package's fixed path: the hardware account, then /0/0.
    const hwPath = `m/${wallet.keys.hardware.originPath.replace(/h/g, "'")}/0/0`;
    const reg = await engine.register({
      network: 'regtest',
      descriptor: wallet.descriptor(),
      cosignerAccountPubkey: cosignerPub(),
      rules: DEFAULT_RULES,
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(hwPath), path: hwPath },
      hardwareAuthProof: signMessage(pairingMessage(walletId, cosignerPub()), hwAuthPrivateKey(hwPath)),
      appNostrPubkey: APP_NOSTR,
    });
    expect(reg.ok).toBe(true);
    const ctx: Ctx = { engine, clock, store, wallet, walletId, signer: new SoftwareCosignerSigner(COSIGNER_PRIV) };
    const dest = await makeWallet({ hardware: MNEMONICS.hardware2 });
    const id = await recoverTo(ctx, 'app', dest, { initiator: APP_NOSTR });
    const rot = await engine.rotateAfterSweep(id);
    if (!rot.ok) throw new Error('rotation failed');
    const newPath = `m/${dest.keys.hardware.originPath.replace(/h/g, "'")}/0/0`;
    expect(rot.adopted).toMatchObject({ appNostrPubkey: APP_NOSTR, hardwareAuth: { pubkey: hwAuthPubkey(newPath, MNEMONICS.hardware2), path: newPath }, hardwareAuthConfirmed: false });

    // Only the new device can confirm.
    const destId = dest.fingerprint();
    expect(await engine.confirmHardwareAuth({ hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(hwPath), path: hwPath }, proof: signMessage(pairingMessage(destId, cosignerPub()), hwAuthPrivateKey(hwPath)) })).toMatchObject({ ok: false });
    const res = await engine.confirmHardwareAuth({
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(newPath, MNEMONICS.hardware2), path: newPath },
      proof: signMessage(pairingMessage(destId, cosignerPub()), hwAuthPrivateKey(newPath, MNEMONICS.hardware2)),
    });
    expect(res).toMatchObject({ ok: true, changed: true });
  });

  it('lost hardware wallet with a key path the guardian cannot derive: the phone supplies the new key with its proof', async () => {
    const ctx = await setup(); // AUTH_PATH is not below the hardware account
    const dest = await makeWallet({ hardware: MNEMONICS.hardware2 });
    const id = await recoverTo(ctx, 'app', dest, { initiator: APP_NOSTR });
    const rot = await ctx.engine.rotateAfterSweep(id);
    expect(rot.ok && rot.adopted?.hardwareAuth).toBeUndefined();
    // Not even a recovery access grant works without a key.
    expect(await ctx.engine.grantRecoveryAccess({ phonePubkey: NEW_PHONE, guardianPubkey: GUARDIAN_NOSTR, approval: access(ctx, NEW_PHONE) })).toMatchObject({
      ok: false,
      refusal: { reason: 'hardware_auth_unconfirmed' },
    });
    const key = { kind: 'bip137' as const, pubkey: hwAuthPubkey(AUTH_PATH, MNEMONICS.hardware2), path: AUTH_PATH };
    const proof = signMessage(pairingMessage(dest.fingerprint(), cosignerPub()), hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2));
    expect(await ctx.engine.confirmHardwareAuth({ hardwareAuth: key, proof })).toMatchObject({ ok: true });
    expect(ctx.engine.registration()?.hardwareAuth).toEqual(key);
  });

  it('a sweep no node accepted does not rotate, and another recovery (say, with a higher fee) can still replace it', async () => {
    const ctx = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const first = await recoverTo(ctx, 'hardware', dest, { initiator: NEW_PHONE, index: 10 });
    // The service never got the first sweep relayed, so it never asked to rotate. A second recovery sweeps the coins again.
    const second = await recoverTo(ctx, 'hardware', dest, { initiator: NEW_PHONE, index: 10 });
    expect(second).not.toBe(first);
    expect(await ctx.engine.rotateAfterSweep(second)).toMatchObject({ ok: true, adopted: { walletId: dest.fingerprint() } });
    // The first one belongs to a retired wallet now: never rotated.
    expect(await ctx.engine.rotateAfterSweep(first)).toMatchObject({ ok: false, refusal: { reason: 'not_adoptable' } });
  });

  it('a destination with another guardian key, or with an unknown phone, retires the old wallet and leaves the guardian unpaired', async () => {
    const ctx = await setup();
    const elsewhere = await makeWallet({ app: MNEMONICS.app2, cosignerPriv: OTHER_COSIGNER_PRIV });
    const id = await recoverTo(ctx, 'hardware', elsewhere, { initiator: NEW_PHONE });
    const away = await ctx.engine.rotateAfterSweep(id);
    expect(away).toMatchObject({ ok: true, detail: 'the new wallet uses another guardian key' });
    expect(away.ok && away.adopted).toBeUndefined();
    expect(ctx.engine.status()).toMatchObject({ registered: false, retiredWallets: 1 });

    // Initiator unknown (a recovery started before the guardian recorded it): retire, and let the user pair the new wallet.
    const ctx2 = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const id2 = await recoverTo(ctx2, 'hardware', dest);
    const rot = await ctx2.engine.rotateAfterSweep(id2);
    expect(rot.ok && rot.adopted).toBeUndefined();
    expect(rot.ok && rot.detail).toMatch(/pairing code/);
    const res = await ctx2.engine.register({
      network: 'regtest',
      descriptor: dest.descriptor(),
      cosignerAccountPubkey: cosignerPub(),
      rules: DEFAULT_RULES,
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(dest.fingerprint(), cosignerPub()), hwAuthPrivateKey()),
      appNostrPubkey: NEW_PHONE,
    });
    expect(res).toMatchObject({ ok: true, walletId: dest.fingerprint() });
  });
});

describe('retired wallets refuse everything', () => {
  async function retired() {
    const ctx = await setup();
    const res = await ctx.engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1));
    expect(res).toMatchObject({ ok: true, walletId: ctx.walletId, retiredAt: ctx.clock.now() });
    return ctx;
  }

  it('co-signs nothing, starts no recovery, changes no rules and cannot be paired again', async () => {
    const ctx = await retired();
    const { engine, wallet } = ctx;
    expect(engine.status()).toMatchObject({ registered: false, retiredWallets: 1, phoneSpending: 'enabled' });
    expect(engine.registration()).toBeUndefined();
    expect(engine.activity()[0]).toMatchObject({ type: 'wallet_retired', walletId: ctx.walletId, sequence: 1 });

    const spend = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 10_000n);
    expect(await engine.cosign(spend.psbt)).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired', walletId: ctx.walletId } });
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: wallet, utxos: [fund(wallet, RECEIVE, 1, 100_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    expect(await engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor() })).toMatchObject({
      ok: false,
      refusal: { reason: 'wallet_retired', walletId: ctx.walletId },
    });
    expect(await engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'app' })).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
    expect(await engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
    expect(await engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR })).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
    expect(await engine.grantRecoveryAccess({ phonePubkey: NEW_PHONE, guardianPubkey: GUARDIAN_NOSTR, approval: access(ctx, NEW_PHONE) })).toMatchObject({
      ok: false,
      refusal: { reason: 'not_registered' },
    });
    const again = await engine.register({
      network: 'regtest',
      descriptor: wallet.descriptor(),
      cosignerAccountPubkey: cosignerPub(),
      rules: DEFAULT_RULES,
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(ctx.walletId, cosignerPub()), hwAuthPrivateKey()),
      appNostrPubkey: APP_NOSTR,
    });
    expect(again).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired', walletId: ctx.walletId } });
  });

  it('opens pairing for a new wallet with the same phone and hardware wallet, and refuses spends of the retired one from it', async () => {
    const ctx = await retired();
    const { engine } = ctx;
    // E.g. the same devices with a new key 3 elsewhere and then back here: any new descriptor pairs.
    const next = await makeWallet({ app: MNEMONICS.app2 });
    const res = await engine.register({
      network: 'regtest',
      descriptor: next.descriptor(),
      cosignerAccountPubkey: cosignerPub(),
      rules: DEFAULT_RULES,
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(next.fingerprint(), cosignerPub()), hwAuthPrivateKey()),
      appNostrPubkey: APP_NOSTR,
      replacesWalletId: ctx.walletId,
    });
    expect(res).toMatchObject({ ok: true, walletId: next.fingerprint() });
    expect(engine.registration()?.origin).toEqual({ kind: 'paired', replacesWalletId: ctx.walletId });
    // A spend of the retired wallet's coins is named as such, not just "foreign".
    const spend = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 200_000n)], 10_000n);
    expect(await engine.cosign(spend.psbt)).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired', walletId: ctx.walletId } });
    // The sequence counter never goes back.
    expect(engine.status().nextHardwareSequence).toBe(2);
  });

  it('refuses retiring without a valid approval, with a stale sequence, or while a recovery runs', async () => {
    const ctx = await setup();
    const { engine } = ctx;
    const bad: HardwareApproval = { ...approve(ctx, { action: 'retire-wallet' }, 1), signature: approve(ctx, { action: 'resume-phone' }, 1).signature };
    expect(await engine.retireWallet(bad)).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(await engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1, { walletId: '0123456789abcdef' }))).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    // Use sequence 1 elsewhere, then replay a retire approval with it.
    const raised: Rules = { ...DEFAULT_RULES, dailyLimitSats: 200_000n };
    expect((await engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: raised }, 1) })).ok).toBe(true);
    expect(await engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1))).toMatchObject({ ok: false, refusal: { reason: 'approval_stale_sequence', lastSequence: 1 } });
    expect(await engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 2, { expiresInSec: -1 }))).toMatchObject({ ok: false, refusal: { reason: 'approval_expired' } });

    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 3, 100_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor() });
    expect(started.ok).toBe(true);
    expect(await engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 2))).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress' } });
    expect(engine.status()).toMatchObject({ registered: true, nextHardwareSequence: 2 });
    expect(engine.activity({ limit: 10 }).filter((e) => e.type === 'wallet_retire_refused')).toHaveLength(5);
  });

  it('retiring revokes recovery access grants', async () => {
    const ctx = await setup();
    expect((await ctx.engine.grantRecoveryAccess({ phonePubkey: NEW_PHONE, guardianPubkey: GUARDIAN_NOSTR, approval: access(ctx, NEW_PHONE) })).ok).toBe(true);
    expect(ctx.engine.hasRecoveryAccess(NEW_PHONE)).toBe(true);
    expect((await ctx.engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1))).ok).toBe(true);
    expect(ctx.engine.hasRecoveryAccess(NEW_PHONE)).toBe(false);
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'wallet_retired', revokedGrants: 1 });
  });
});

describe('recovery access grants', () => {
  it('checks the hardware signature, binding and expiry, renews, and expires', async () => {
    const ctx = await setup();
    const { engine, clock } = ctx;
    const grant = (approval: ReturnType<typeof access>, phone = NEW_PHONE) => engine.grantRecoveryAccess({ phonePubkey: phone, guardianPubkey: GUARDIAN_NOSTR, approval });
    expect(await grant(access(ctx, NEW_PHONE), STRANGER())).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(await grant(access(ctx, NEW_PHONE, 3600, new Uint8Array(32).fill(3)))).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(await grant(access(ctx, NEW_PHONE, -1))).toMatchObject({ ok: false, refusal: { reason: 'approval_expired' } });
    expect(await grant(access(ctx, NEW_PHONE, 2 * 86_400))).toMatchObject({ ok: false, refusal: { reason: 'approval_expiry_too_far' } });
    expect(await grant({ ...access(ctx, NEW_PHONE), kind: 'psbt' })).toMatchObject({ ok: false, refusal: { reason: 'unsupported_approval' } });
    expect(engine.recoveryPeers()).toEqual([]);

    expect(await grant(access(ctx, NEW_PHONE))).toMatchObject({ ok: true, renewed: false });
    expect(await grant(access(ctx, NEW_PHONE, 7200))).toMatchObject({ ok: true, renewed: true });
    expect(engine.recoveryPeers()).toEqual([NEW_PHONE]);
    expect(engine.status().nextHardwareSequence).toBe(1); // consumes no sequence
    clock.advance(7201_000);
    expect(engine.hasRecoveryAccess(NEW_PHONE)).toBe(false);
  });
});

describe('reset', () => {
  it('is refused while a recovery is pending, and otherwise forgets every wallet', async () => {
    const ctx = await setup();
    const { engine } = ctx;
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 3, 100_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor() });
    if (!started.ok) throw new Error('start failed');
    expect(await engine.reset()).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress', recoveryId: started.recovery.id } });
    ctx.clock.set(started.recovery.readyAt); // ready is still running
    expect(await engine.reset()).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress' } });
    expect((await engine.cancelRecovery({ kind: 'nostr', pubkey: CONTACT_A })).ok).toBe(true);

    const res = await engine.reset();
    expect(res).toMatchObject({ ok: true, forgotten: [ctx.walletId] });
    expect(engine.status()).toMatchObject({ registered: false, retiredWallets: 0, nextHardwareSequence: 1, recovery: undefined });
    expect(engine.activity().map((e) => e.type)).toEqual(['guardian_reset']);
    // A wallet that was retired here before is forgotten too, so pairing is open for anything.
    const state = deserializeState(serializeState((engine as unknown as { state: Parameters<typeof serializeState>[0] }).state));
    expect(state.active).toBeUndefined();
  });

  it('survives a reload from the store', async () => {
    const store: StateStore = new MemoryStore();
    const ctx = await setup({ store });
    expect((await ctx.engine.reset()).ok).toBe(true);
    const again = await PolicyEngine.open({ store, clock: ctx.clock });
    expect(again.status().registered).toBe(false);
    expect(DAY).toBeGreaterThan(0);
  });
});

function STRANGER(): string {
  return nostrKey(99);
}
