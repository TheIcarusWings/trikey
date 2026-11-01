/**
 * One guest wallet's engine (docs/design/family-hosting.md, sections 4 and 5): delegated registration, co-signing under
 * the limit with tweak-proven change, the co-signed-coin ledger, guest-built recovery with `abandon` and the
 * write-once wallet map, rotation, recovery access (version-2 text only), and stopping hosting.
 */
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { buildSpend, keySetId, parsePsbt } from '@trikey/core';
import { HostedEngine, MemoryHostedStore, hostedAuthPath, serializeHosted } from '../src/hosting/engine.js';
import { HOSTED_RECOVERY_ID, slotOfRecoveryId } from '../src/hosting/service.js';
import { hostedAlertText } from '../src/hosting/alerts.js';
import { ClockChain, DAY, ManualClock, SoftwareCosignerSigner, pairingMessage, recoveryAccessMessage, signMessage, type Rules } from '../src/policy/index.js';
import { APP_NOSTR, AUTH_PATH, CONTACT_A, MNEMONICS, T0, appSigner, approve, fund, hwAuthPrivateKey, network, nostrKey } from './helpers.js';
import { destinationAfterHardwareLoss, externalScript, fakeMap, hostedWallet, offPathPayment, phoneSweep, type HostedFixture } from './support/hosted.js';

const SLOT = '0123456789abcdef';
const K3 = new Uint8Array(32).fill(21);
const RULES: Rules = { dailyLimitSats: 100_000n, recoveryDelayDays: 7, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000n };

async function setup(opts: { maxLedgerCoins?: number; rules?: Partial<Rules> } = {}) {
  const clock = new ManualClock(T0);
  const store = new MemoryHostedStore();
  const signer = new SoftwareCosignerSigner(K3);
  const engine = await HostedEngine.open({ slotId: SLOT, store, clock, chain: new ClockChain(clock), blocksPerDay: 1, maxLedgerCoins: opts.maxLedgerCoins });
  const fx = await hostedWallet({ cosignerPub: hex.encode(signer.accountPubkey) });
  const map = fakeMap();
  const res = await engine.register(
    {
      network: 'regtest',
      accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
      cosignerAccountPubkey: fx.accountPubkeys.cosigner,
      rules: { ...RULES, ...opts.rules },
      hardwareAuth: fx.hardwareAuth,
      hardwareAuthProof: fx.proof,
      appNostrPubkey: APP_NOSTR,
      walletLabel: 'Ana',
      walletMap: map,
    },
    signer,
  );
  if (!res.ok) throw new Error(JSON.stringify(res.refusal));
  engine.setSigner(signer);
  return { clock, store, engine, fx, signer, map };
}

const ctxOf = (fx: HostedFixture, clock: ManualClock) => ({ clock, walletId: fx.walletId });

describe('registration of a hosted wallet', () => {
  async function attempt(mutate: (input: Parameters<HostedEngine['register']>[0], fx: HostedFixture) => void) {
    const clock = new ManualClock(T0);
    const signer = new SoftwareCosignerSigner(K3);
    const engine = await HostedEngine.open({ slotId: SLOT, store: new MemoryHostedStore(), clock, chain: new ClockChain(clock) });
    const fx = await hostedWallet({ cosignerPub: hex.encode(signer.accountPubkey) });
    const input = {
      network: 'regtest' as const,
      accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
      cosignerAccountPubkey: fx.accountPubkeys.cosigner,
      rules: RULES,
      hardwareAuth: { ...fx.hardwareAuth },
      hardwareAuthProof: fx.proof,
      appNostrPubkey: APP_NOSTR,
      walletLabel: 'Ana',
      walletMap: fakeMap(),
    };
    mutate(input, fx);
    return engine.register(input, signer);
  }

  it('registers by account pubkeys: the wallet id is the key-set id, never a descriptor hash', async () => {
    const { engine, fx } = await setup();
    const reg = engine.registration()!;
    expect(reg.mode).toBe('delegated');
    expect(reg.walletId).toBe(keySetId(fx.wallet.accountPubkeys()));
    expect(reg.walletId).not.toBe(fx.wallet.fingerprint());
    expect(serializeHosted(engine.snapshot)).not.toContain(fx.wallet.keys.app.xpub);
    expect(serializeHosted(engine.snapshot)).not.toContain("wsh(");
  });

  it('proves the authorization key as hardware + tweak at 0/0, at the hosted path only', async () => {
    expect(hostedAuthPath('regtest')).toBe(AUTH_PATH);
    expect((await attempt((i) => void (i.hardwareAuth.tweak = '11'.repeat(32)))).ok).toBe(false);
    const wrongPath = await attempt((i) => void (i.hardwareAuth.path = "m/48'/1'/0'/2'/0/1"));
    expect(!wrongPath.ok && wrongPath.refusal).toMatchObject({ reason: 'invalid_registration', detail: expect.stringMatching(/must be at/) });
  });

  it('needs the pairing proof over the key-set id (a proof over the descriptor hash does not do)', async () => {
    const r = await attempt((i, fx) => void (i.hardwareAuthProof = signMessage(pairingMessage(fx.wallet.fingerprint(), fx.accountPubkeys.cosigner), hwAuthPrivateKey())));
    expect(!r.ok && r.refusal).toMatchObject({ reason: 'invalid_registration', detail: 'hardware pairing proof does not verify' });
  });

  it('refuses phase-2 rules (limit off, contact lock), a missing or oversized map, and repeated keys', async () => {
    expect((await attempt((i) => void (i.rules = { ...RULES, contactLock: true }))).ok).toBe(false);
    expect((await attempt((i) => void (i.rules = { ...RULES, dailyLimitSats: 2_100_000_000_000_000n }))).ok).toBe(false);
    expect((await attempt((i) => void (i.walletMap = 'not base64!'))).ok).toBe(false);
    expect((await attempt((i) => void (i.walletMap = fakeMap(4097)))).ok).toBe(false);
    expect((await attempt((i) => void (i.accountPubkeys.hardware = i.accountPubkeys.app))).ok).toBe(false);
  });

  it('refuses a key set the guardian already guards elsewhere', async () => {
    const r = await attempt((i, fx) => void (i.forbiddenKeySets = new Set([[fx.accountPubkeys.app, fx.accountPubkeys.hardware, fx.accountPubkeys.cosigner].sort().join(',')])));
    expect(!r.ok && r.refusal).toMatchObject({ reason: 'invalid_registration' });
  });

  it('on mainnet needs an alert contact, as for the host', async () => {
    const clock = new ManualClock(T0);
    const engine = await HostedEngine.open({ slotId: SLOT, store: new MemoryHostedStore(), clock });
    const r = await engine.register({
      network: 'bitcoin',
      accountPubkeys: { app: `02${'11'.repeat(32)}`, hardware: `03${'22'.repeat(32)}` },
      cosignerAccountPubkey: hex.encode(secp256k1.getPublicKey(K3, true)),
      rules: { ...RULES, alertContacts: [] },
      hardwareAuth: { pubkey: `02${'33'.repeat(32)}`, path: "m/48'/0'/0'/2'/0/0", tweak: '44'.repeat(32) },
      hardwareAuthProof: 'x',
      appNostrPubkey: APP_NOSTR,
      walletLabel: 'Ana',
      walletMap: fakeMap(),
    });
    expect(!r.ok && r.refusal).toMatchObject({ reason: 'invalid_registration' });
  });
});

describe('delegated co-signing under the limit', () => {
  it('co-signs within the limit, counts Σ inputs − tweak-proven change, and ledgers the change', async () => {
    const { engine, fx } = await setup();
    const u = fund(fx.wallet, 0, 3, 200_000n);
    const plan = buildSpend({ wallet: fx.wallet, utxos: [u], recipients: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: 50_000n }], feeRate: 2, changeIndex: 7 });
    const res = await engine.cosign(await appSigner().signPsbt(plan.psbt, network));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outflow).toBe(50_000n + plan.fee);
    expect(res.ledgered).toBe(1);
    const coin = engine.ledger()[0];
    expect(coin).toMatchObject({ txid: res.txid, valueSats: plan.change!.amount });
    expect(coin.tweaks.cosigner).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses over the limit; a replay counts once; an RBF replacement counts the larger', async () => {
    const { engine, fx } = await setup({ rules: { dailyLimitSats: 60_000n } });
    const u = fund(fx.wallet, 0, 0, 300_000n);
    const to = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    const a = await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [u], recipients: [{ address: to, amount: 40_000n }], feeRate: 1, changeIndex: 0 }).psbt, network);
    expect((await engine.cosign(a)).ok).toBe(true);
    const again = await engine.cosign(a);
    expect(again.ok && again.replay).toBe(true);
    const rbf = await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [u], recipients: [{ address: to, amount: 50_000n }], feeRate: 3, changeIndex: 0 }).psbt, network);
    expect((await engine.cosign(rbf)).ok).toBe(true);
    expect(engine.status().dailyLimit!.used).toBeGreaterThan(50_000n);
    const over = await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [fund(fx.wallet, 0, 1, 100_000n)], recipients: [{ address: to, amount: 30_000n }], feeRate: 1, changeIndex: 1 }).psbt, network);
    const r = await engine.cosign(over);
    expect(!r.ok && r.refusal.reason).toBe('over_daily_limit');
  });

  it('counts an OFF-PATH change output as change (it cannot tell), and remembers it in the ledger', async () => {
    const { engine, fx } = await setup();
    const u = fund(fx.wallet, 0, 0, 500_000n);
    const { psbt, changeScript } = await offPathPayment(fx, u, 10_000n, 489_000n, externalScript());
    const res = await engine.cosign(psbt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outflow).toBe(11_000n);
    expect(engine.ledger().map((c) => c.script)).toEqual([hex.encode(changeScript)]);
  });

  it('a later payment spending a ledger coin replaces it; the ledger is bounded (ledger_full)', async () => {
    const { engine, fx } = await setup({ maxLedgerCoins: 1 });
    const u = fund(fx.wallet, 0, 0, 500_000n);
    const first = await offPathPayment(fx, u, 10_000n, 489_000n, externalScript());
    const r1 = await engine.cosign(first.psbt);
    expect(r1.ok).toBe(true);
    const second = await offPathPayment(fx, fund(fx.wallet, 0, 1, 50_000n), 1_000n, 48_000n, externalScript());
    const r2 = await engine.cosign(second.psbt);
    expect(!r2.ok && r2.refusal).toMatchObject({ reason: 'ledger_full', limit: 1 });
  });

  it('refuses a hardware signature outside a recovery and foreign inputs', async () => {
    const { engine, fx } = await setup();
    const plan = buildSpend({ wallet: fx.wallet, utxos: [fund(fx.wallet, 0, 0, 100_000n)], recipients: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: 10_000n }], feeRate: 1, changeIndex: 0 });
    const { hwSigner } = await import('./helpers.js');
    const r = await engine.cosign(await hwSigner().signPsbt(plan.psbt, network));
    expect(!r.ok && r.refusal.reason).toBe('hardware_signed_outside_recovery');
    const other = await hostedWallet({ cosignerPub: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(5), true)), app: MNEMONICS.app2 });
    const foreign = buildSpend({ wallet: other.wallet, utxos: [fund(other.wallet, 0, 0, 100_000n)], recipients: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: 10_000n }], feeRate: 1, changeIndex: 0 });
    const f = await engine.cosign(await appSigner(MNEMONICS.app2).signPsbt(foreign.psbt, network));
    expect(!f.ok && f.refusal.reason).toBe('foreign_input');
  });
});

describe('guest-built recovery', () => {
  it('ids carry the slot (and fit the CANCEL pattern)', async () => {
    const { engine, fx, clock } = await setup();
    const u = fund(fx.wallet, 0, 0, 200_000n);
    const dest = await destinationAfterHardwareLoss(fx);
    const res = await engine.startRecovery({ psbt: await phoneSweep(fx, dest, [u]), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap(), initiator: APP_NOSTR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recovery.id).toMatch(HOSTED_RECOVERY_ID);
    expect(slotOfRecoveryId(res.recovery.id)).toBe(SLOT);
    expect(slotOfRecoveryId('1-0123456789ab')).toBeUndefined();
    expect(/\bcancel\s+([0-9a-z]+-[0-9a-f]{12})\b/i.exec(`CANCEL ${res.recovery.id}`)?.[1]).toBe(res.recovery.id);
    void clock;
  });

  it('checks the destination: keeps the surviving key, drops the lost one, every output tweak-proven to it', async () => {
    const { engine, fx } = await setup();
    const u = fund(fx.wallet, 0, 0, 200_000n);
    const dest = await destinationAfterHardwareLoss(fx);
    const sweep = await phoneSweep(fx, dest, [u]);
    const keepsLost = await engine.startRecovery({ psbt: sweep, destinationKeys: { ...dest.accountPubkeys, hardware: fx.accountPubkeys.hardware }, destinationMap: fakeMap() });
    expect(!keepsLost.ok && keepsLost.refusal.reason).toMatch(/destination|sweep_not_to_destination/);
    const elsewhere = await hostedWallet({ cosignerPub: fx.accountPubkeys.cosigner, app: MNEMONICS.app2, hardware: MNEMONICS.hardware2 });
    const r = await engine.startRecovery({ psbt: sweep, destinationKeys: elsewhere.accountPubkeys, destinationMap: fakeMap() });
    expect(!r.ok && r.refusal.reason).toBe('sweep_not_to_destination');
  });

  it('abandon names only ledger coins, never swept ones; the alerts say how much is left behind', async () => {
    const { engine, fx } = await setup();
    const u = fund(fx.wallet, 0, 0, 500_000n);
    const { psbt } = await offPathPayment(fx, u, 10_000n, 489_000n, externalScript());
    const c = await engine.cosign(psbt);
    if (!c.ok) throw new Error('cosign');
    const offPath = `${c.txid}:1`;
    const dest = await destinationAfterHardwareLoss(fx);
    const other = fund(fx.wallet, 0, 4, 80_000n);
    const sweep = await phoneSweep(fx, dest, [other]);
    const bogus = await engine.startRecovery({ psbt: sweep, destinationKeys: dest.accountPubkeys, destinationMap: fakeMap(), abandon: [`${'ab'.repeat(32)}:0`] });
    expect(!bogus.ok && bogus.refusal.reason).toBe('invalid_abandon');
    const res = await engine.startRecovery({ psbt: sweep, destinationKeys: dest.accountPubkeys, destinationMap: fakeMap(), abandon: [offPath] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recovery.abandon).toEqual([offPath]);
    expect(res.recovery.abandonSats).toBe(489_000n);
    const [alert] = engine.dueAlerts();
    const rec = engine.records()[0];
    expect(hostedAlertText(alert, rec, 'Ana')).toMatch(/leaves 1 coin \(0\.00489000 BTC/);
    expect(hostedAlertText(alert, rec, 'Ana')).toContain('"Ana"');
  });

  it('keeps wallet maps write-once: another map for the same destination is refused', async () => {
    const { engine, fx, clock } = await setup();
    const u = fund(fx.wallet, 0, 0, 200_000n);
    const dest = await destinationAfterHardwareLoss(fx);
    const map = fakeMap(100, 7);
    const first = await engine.startRecovery({ psbt: await phoneSweep(fx, dest, [u]), destinationKeys: dest.accountPubkeys, destinationMap: map, initiator: APP_NOSTR });
    if (!first.ok) throw new Error('start');
    await engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR });
    const second = await engine.startRecovery({ psbt: await phoneSweep(fx, dest, [u], 3), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap(100, 8) });
    expect(!second.ok && second.refusal).toMatchObject({ reason: 'invalid_destination', detail: expect.stringMatching(/another wallet map/) });
    expect(engine.walletMap(dest.walletId)?.map).toBe(map);
    void clock;
  });

  it('completes after the delay (three clocks), rotates: the destination is adopted with its map and the sweep as its ledger', async () => {
    const { engine, fx, clock } = await setup();
    const u = fund(fx.wallet, 0, 0, 200_000n);
    const dest = await destinationAfterHardwareLoss(fx);
    const destMap = fakeMap(90, 3);
    const res = await engine.startRecovery({ psbt: await phoneSweep(fx, dest, [u]), destinationKeys: dest.accountPubkeys, destinationMap: destMap, initiator: APP_NOSTR });
    if (!res.ok) throw new Error('start');
    expect((await engine.completeRecovery()).ok).toBe(false);
    clock.advance(7 * DAY + 1000);
    const done = await engine.completeRecovery();
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const rot = await engine.rotateAfterSweep(res.recovery.id);
    expect(rot.ok && rot.adopted?.walletId).toBe(dest.walletId);
    expect(engine.registration()!.hardwareAuthConfirmed).toBe(false);
    expect(engine.walletMap()?.map).toBe(destMap);
    expect(engine.ledger()).toHaveLength(1);
    expect(engine.ledger()[0].txid).toBe(done.txid);
    // The new hardware wallet confirms its authorization key with its own tweak.
    const auth = dest.hardwareAuth;
    const proof = signMessage(pairingMessage(dest.walletId, dest.accountPubkeys.cosigner), hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2));
    const wrong = await engine.confirmHardwareAuth({ hardwareAuth: { ...auth, tweak: fx.hardwareAuth.tweak }, proof });
    expect(wrong.ok).toBe(false);
    const ok = await engine.confirmHardwareAuth({ hardwareAuth: auth, proof });
    expect(ok.ok && ok.changed).toBe(true);
    // The old wallet is dead to key 3.
    const late = await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [fund(fx.wallet, 0, 9, 50_000n)], recipients: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: 1000n }], feeRate: 1, changeIndex: 0 }).psbt, network);
    const r = await engine.cosign(late);
    expect(!r.ok && r.refusal.reason).toBe('wallet_retired');
    expect(parsePsbt(done.psbt).inputsLength).toBe(1);
  });
});

describe('recovery access and stopping hosting', () => {
  it('accepts only the version-2 access text (bound to the key-set id)', async () => {
    const { engine, fx, clock } = await setup();
    const phone = nostrKey(31);
    const guardian = nostrKey(32);
    const expiresAt = Math.floor(clock.now() / 1000) + 3600;
    const v1 = signMessage(recoveryAccessMessage({ guardianPubkey: guardian, phonePubkey: phone, expiresAt }), hwAuthPrivateKey());
    expect((await engine.grantRecoveryAccess({ phonePubkey: phone, guardianPubkey: guardian, approval: { kind: 'bip137', expiresAt, signature: v1 } })).ok).toBe(false);
    const v2 = signMessage(recoveryAccessMessage({ guardianPubkey: guardian, phonePubkey: phone, expiresAt, walletId: fx.walletId }), hwAuthPrivateKey());
    expect((await engine.grantRecoveryAccess({ phonePubkey: phone, guardianPubkey: guardian, approval: { kind: 'bip137', expiresAt, signature: v2 } })).ok).toBe(true);
    expect(engine.hasRecoveryAccess(phone)).toBe(true);
  });

  it('hosting_ending goes to the phone and the contacts; ending is refused while a recovery runs', async () => {
    const { engine, fx } = await setup();
    await engine.noteHostingEnding(T0 + 30 * DAY);
    const [n] = engine.dueNotices();
    expect(n).toMatchObject({ kind: 'hosting_ending', recipients: [APP_NOSTR, CONTACT_A] });
    const dest = await destinationAfterHardwareLoss(fx);
    await engine.startRecovery({ psbt: await phoneSweep(fx, dest, [fund(fx.wallet, 0, 0, 100_000n)]), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap() });
    expect((await engine.endHosting()).ok).toBe(false);
    await engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR });
    const ended = await engine.endHosting();
    expect(ended.ok && ended.walletId).toBe(fx.walletId);
    expect(engine.registration()).toBeUndefined();
    expect(engine.snapshot.retired[0].retirement.reason).toBe('hosting_ended');
  });

  it('rule changes: tightening from the phone, loosening with the hardware approval naming the key-set id', async () => {
    const { engine, fx, clock } = await setup();
    expect((await engine.changeRules({ ...RULES, dailyLimitSats: 50_000n }, { authenticatedBy: 'app' })).ok).toBe(true);
    const looser = { ...RULES, dailyLimitSats: 200_000n };
    expect((await engine.changeRules(looser, { authenticatedBy: 'app' })).ok).toBe(false);
    const ok = await engine.changeRules(looser, { authenticatedBy: 'hardware', approval: approve(ctxOf(fx, clock), { action: 'policy', rules: looser }, 1) });
    expect(ok.ok).toBe(true);
    const off = await engine.changeRules({ ...RULES, dailyLimitSats: 2_100_000_000_000_000n }, { authenticatedBy: 'hardware', approval: approve(ctxOf(fx, clock), { action: 'policy', rules: { ...RULES, dailyLimitSats: 2_100_000_000_000_000n } }, 2) });
    expect(!off.ok && off.refusal.reason).toBe('invalid_rules');
  });

  it('persists through its store and reopens the same', async () => {
    const { store, engine } = await setup();
    const again = await HostedEngine.open({ slotId: SLOT, store });
    expect(again.registration()).toEqual(engine.registration());
    await expect(HostedEngine.open({ slotId: 'fedcba9876543210', store })).rejects.toThrow(/another slot/);
  });
});
