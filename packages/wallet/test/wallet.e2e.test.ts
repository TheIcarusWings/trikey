/**
 * The wallet end to end against the real guardian service, in-process
 * (`@trikey/guardian/testing`: temp data dir, in-memory relays, a fake
 * Electrs), with the software hardware wallet and in-memory platform stores.
 * Regtest only; throwaway keys and published BIP 39 test mnemonics.
 *
 * The tests run in order and share one guardian, like a user's life with the
 * wallet: onboard, receive, pay, rules, recovery, backup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey } from 'nostr-tools/pure';
import { MultisigWallet, analyzePsbt, parseSortedMultiDescriptor } from '@trikey/core';
import { RpcClient, RpcTimeoutError, SimplePoolRelayPool, approvalMessage, encodeRecoveryUri, policyHash, type Alert, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  BACKUP_FILE_PREFIX,
  KEY3_MIXED_NOTE,
  TrikeyWallet,
  WalletError,
  generateRecoveryCode,
  parseBackup,
  type WalletEvent,
} from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { FlakyPool, MNEMONICS, externalAddress, phone, waitFor, type Phone } from './helpers.js';

let rig: GuardianRig;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];

let phoneA: Phone;
let A: TrikeyWallet;
const eventsA: WalletEvent[] = [];
const alertsA = () => eventsA.flatMap((e) => (e.type === 'alert' ? [e.alert] : []));
const prompts = () => eventsA.flatMap((e) => (e.type === 'hardware_prompt' ? [e.text] : []));

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

function newPhone(extra: Partial<Parameters<typeof phone>[0]> = {}): Phone {
  return phone({ clock: rig.clock, hardware: provider, cloud, passkey, ...extra });
}

function track(w: TrikeyWallet, events?: WalletEvent[]): TrikeyWallet {
  opened.push(w);
  if (events) w.on((e) => events.push(e));
  return w;
}

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

const biometricLoads = (p: Phone) => p.secure.loads.filter((l) => l.biometric);

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  await rig?.stop();
});

describe('@trikey/wallet end to end', { timeout: 60_000 }, () => {
  let walletId: string;

  it('creates key 2 behind biometrics and onboards: hardware wallet, guardian QR, pairing, first address on the device', async () => {
    phoneA = newPhone();
    A = track(await TrikeyWallet.create(phoneA.deps, { deviceName: 'Test phone' }), eventsA);
    const s = A.state;
    expect(s.stage).toBe('new');
    expect(s.key2.path).toBe("m/48'/1'/0'/2'");
    expect(phoneA.secure.items.get(s.secrets.key2)).toMatchObject({ requireBiometrics: true });
    expect(phoneA.secure.items.get(s.secrets.key2)!.secret).toHaveLength(32); // 24 words of entropy
    expect(phoneA.secure.items.get(s.secrets.nostr)).toMatchObject({ requireBiometrics: false });
    await expect(TrikeyWallet.create(phoneA.deps)).rejects.toMatchObject({ code: 'wallet_exists' });

    const hw = await A.connectHardware();
    expect(hw).toMatchObject({ kind: 'ledger', fingerprint: device.info.fingerprint });
    const preview = await A.scanGuardian(rig.pairingUri());
    expect(preview.label).toBe('Test Guardian');
    expect(preview.key3Mixed).toBe(true);
    const out = await A.pair({ rules: RULES });
    walletId = out.walletId;
    expect(out).toMatchObject({ walletId: preview.walletId, descriptor: preview.descriptor, addressVerified: true });
    // The phone sent its contribution to key 3; the guardian mixed it in and said so.
    expect(out).toMatchObject({ key3Mixed: true, key3Note: KEY3_MIXED_NOTE });
    expect(KEY3_MIXED_NOTE).toBe("Your guardian's key was made with randomness from both this phone and your guardian.");
    expect(A.state.guardian!.key3Mixed).toBe(true);
    expect(rig.guardian.engine.registration()!.key3Mix?.entropy).toMatch(/^[0-9a-f]{64}$/);
    expect(A.state.guardian!.key.xpub).not.toBe(rig.guardian.keystore!.public.xpub);

    // Keys in the descriptor: phone, hardware, guardian; the guardian registered exactly that.
    const keys = parseSortedMultiDescriptor(out.descriptor);
    expect(keys[0]!.xpub).toBe(A.state.key2.xpub);
    expect(keys[1]!.fingerprint).toBe(device.info.fingerprint);
    const reg = rig.guardian.engine.registration()!;
    expect(reg).toMatchObject({ walletId, descriptor: out.descriptor, appNostrPubkey: A.state.nostrPubkey });
    expect(reg.hardwareAuth).toEqual({ kind: 'bip137', pubkey: device.publicKeyAt("m/48'/1'/0'/2'/0/0"), path: "m/48'/1'/0'/2'/0/0" });
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(100_000n);

    // The device signed the pairing text, registered the wallet and showed the first address.
    expect(prompts()[0]).toMatch(new RegExp(`^Trikey pair v1 wallet=${walletId} guardian=0[23][0-9a-f]{64}$`));
    const ops = device.calls.map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(['getXpub', 'signMessage', 'registerWallet', 'displayAddress']));
    expect(device.calls.find((c) => c.op === 'displayAddress')).toMatchObject({ chain: 0, index: 0, address: out.firstAddress });
    expect(A.state).toMatchObject({ stage: 'paired', hardware: { addressVerified: true, policyName: `Trikey ${walletId.slice(0, 4)}` } });
    expect(A.state.hardware!.registrationHmac).toMatch(/^[0-9a-f]{64}$/);
    // Key 2 itself was not needed to pair.
    expect(biometricLoads(phoneA)).toHaveLength(0);
  });

  it('refuses a damaged pairing code and an address the device does not confirm', async () => {
    const p = newPhone();
    const w = track(await TrikeyWallet.create(p.deps));
    await w.connectHardware();
    expect((await walletError(w.scanGuardian('trikey://pair?v=1&npub=nope'))).code).toBe('pairing_uri_invalid');
    // The guardian is paired already: a second wallet is refused there.
    const e = await walletError(w.scanGuardian(rig.pairingUri()));
    expect(e).toMatchObject({ code: 'guardian_refused', refusal: { kind: 'already_paired' } });
  });

  it('receives at the next unused address, shown on the device too', async () => {
    const r = await A.receiveAddress({ verifyOnDevice: true });
    expect(r).toMatchObject({ index: 0, verifiedOnDevice: true, address: A.multisig().derive(0, 0).address });
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    rig.fund(A.multisig().derive(0, 1).script, 50_000n);
    const snap = await A.sync();
    expect(snap.balance).toEqual({ confirmedSats: 350_000, unconfirmedSats: 0, totalSats: 350_000 });
    expect(snap.history.map((h) => h.netSats).sort()).toEqual([300_000, 50_000].sort());
    expect((await A.receiveAddress()).index).toBe(2);

    // A device showing something else is a hard stop.
    device.displayOverride = externalAddress(9);
    expect((await walletError(A.receiveAddress({ verifyOnDevice: true }))).code).toBe('address_mismatch');
    device.displayOverride = undefined;
  });

  it('pays within the daily limit with key 2 and the guardian, broadcast through the guardian', async () => {
    const to = externalAddress();
    const q = A.quoteSend({ address: to, amountSats: 30_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    expect(q.totalSats).toBe(30_000 + q.feeSats);
    const signsBefore = device.calls.filter((c) => c.op === 'signPsbt').length;
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian', amountSats: 30_000 });
    if (!res.ok) throw new Error('unreachable');
    expect(rig.electrs.broadcasts).toContain(res.txHex);
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signsBefore); // no hardware
    // Key 2 was loaded once, behind biometrics, for this payment.
    expect(biometricLoads(phoneA).map((l) => l.reason)).toEqual(['Approve the payment']);

    const tx = btc.Transaction.fromRaw(hex.decode(res.txHex));
    expect(tx.getOutput(0)).toMatchObject({ amount: 30_000n });
    // The guardian's count is the truth, and the phone's estimate agrees.
    const snap = A.snapshot()!;
    expect(snap.guardian?.dailyLimit?.usedSats).toBe(30_000 + q.feeSats);
    expect(snap.dailyLimit).toMatchObject({ limitSats: 100_000, spentEstimateSats: 30_000 + q.feeSats });
    expect(snap.history.find((h) => h.txid === res.txid)).toMatchObject({ height: 0, netSats: -(30_000 + q.feeSats), feeSats: q.feeSats });
    expect(snap.utxos.find((u) => u.txid === res.txid)).toMatchObject({ chain: 1, index: 0 });
  });

  it('pays over the limit with the hardware wallet instead', async () => {
    const q = A.quoteSend({ address: externalAddress(), amountSats: 120_000 });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    if (!res.ok) throw new Error('unreachable');
    expect(rig.electrs.broadcasts).toContain(res.txHex);
    expect(device.calls.at(-2)).toMatchObject({ op: 'signPsbt' });
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(used); // the guardian was not involved

    // The phone's estimate is only a hint: if it is wrong, the guardian refuses and the hardware wallet steps in.
    const q2 = A.quoteSend({ address: externalAddress(), amountSats: 80_000 });
    expect(q2.plan.signer).toBe('phone+hardware');
    const forced = { ...q2, plan: { signer: 'phone+guardian' as const } };
    const refused = await A.send(forced, { fallbackToHardware: false });
    expect(refused).toMatchObject({ ok: false, refusal: { kind: 'over_daily_limit', limitSats: 100_000 } });
    const fell = await A.send(forced);
    expect(fell).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit', guardianRefusal: { kind: 'over_daily_limit' } });
  });

  it('while the guardian is locked: syncs, pays with the hardware wallet, and unlocks it from the phone', async () => {
    await rig.lock();
    await waitFor(() => alertsA().find((a) => a.type === 'guardian_locked' && a.reason === 'manual'), 'locked alert');
    const snap = await A.sync(); // chain data while locked
    expect(snap.guardian).toMatchObject({ state: 'locked' });
    const q = A.quoteSend({ address: externalAddress(), amountSats: 5_000 });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'guardian-locked' });
    expect(await A.send(q)).toMatchObject({ ok: true, signedBy: 'phone+hardware' });

    // A stale "unlocked" view: the guardian refuses with "locked" and the hardware wallet signs.
    const stale = { ...A.quoteSend({ address: externalAddress(), amountSats: 5_000 }), plan: { signer: 'phone+guardian' as const } };
    expect(await A.send(stale)).toMatchObject({ ok: true, signedBy: 'phone+hardware', guardianRefusal: { kind: 'guardian_locked' } });

    expect(await A.unlockGuardian('not the passphrase')).toMatchObject({ ok: false, refusal: { kind: 'unlock_failed' } });
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(A.state.guardianStatus?.state).toBe('unlocked');
    expect(A.state.pending).toBeUndefined();
    expect(JSON.stringify([...phoneA.kv.data.values()])).not.toContain(rig.passphrase);
  });

  it('tightens a rule from the phone alone, and loosens one with a hardware approval', async () => {
    const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;
    const before = signs();
    const lower = await A.setDailyLimit(80_000);
    expect(lower).toMatchObject({ approvedBy: 'phone', policy: { dailyLimitSats: 80_000 } });
    expect(signs()).toBe(before);
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(80_000n);

    const raised = await A.setDailyLimit(150_000);
    expect(raised).toMatchObject({ approvedBy: 'hardware', policy: { dailyLimitSats: 150_000 }, nextHardwareSequence: 2 });
    expect(signs()).toBe(before + 1);
    // The device signed exactly the text the guardian rebuilt.
    const text = prompts().at(-1)!;
    const expiresAt = Number(new Date(text.match(/expires=(\S+)$/)![1]!).getTime() / 1000);
    expect(text).toBe(approvalMessage({ action: 'policy', policy: raised.policy }, { walletId, sequence: 1, expiresAt }));
    expect(text).toContain(`limit=150000 delay=7d feecap=20000 contacts=0 hash=${policyHash(raised.policy)}`);
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(150_000n);

    // A longer delay is a tightening too; a new alert contact needs the hardware wallet.
    expect(await A.setRecoveryDelay(14)).toMatchObject({ approvedBy: 'phone' });
    const contact = npubEncode(hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(21), true).slice(1)));
    const added = await A.addAlertContact(contact, 'Alice');
    expect(added).toMatchObject({ approvedBy: 'hardware', nextHardwareSequence: 3 });
    expect(A.alertContacts()).toEqual([expect.objectContaining({ npub: contact, name: 'Alice' })]);

    // A device answering with another key is caught before anything is sent.
    device.signWithWrongKeyOnce = true;
    expect((await walletError(A.setDailyLimit(160_000))).code).toBe('hardware_invalid_response');
    expect(rig.guardian.engine.status().nextHardwareSequence).toBe(3);
    expect((await A.getRules()).policy.dailyLimitSats).toBe(150_000);
  });

  it('settles a rule change left pending by an app crash: the guardian answers 1501 after its restart, the phone re-reads the rules', async () => {
    await A.close();
    const flaky = new FlakyPool();
    const crashing = phone({ clock: rig.clock, hardware: provider, cloud, passkey, pool: () => flaky, rpcTimeoutMs: 1500 });
    // Same phone storage, new process.
    const A2 = track((await TrikeyWallet.open({ ...crashing.deps, secureStore: phoneA.secure, store: phoneA.kv }))!);
    await A2.start();
    flaky.dropWhen = () => A2.state.pending?.method === 'policy.update'; // its answer never reaches the phone
    const e = await walletError(A2.setRecoveryDelay(30));
    expect(e.refusal?.kind).toBe('unreachable');
    expect(A2.state.pending).toMatchObject({ method: 'policy.update' });
    expect(rig.guardian.engine.status().rules?.recoveryDelayDays).toBe(30); // it did arrive
    await A2.close();

    // Ten minutes later (the relays have dropped the expired request and answers) the guardian has
    // restarted, forgetting its answers, and the app starts again.
    rig.clock.advance(10 * 60_000);
    await rig.restart();
    await rig.unlock();
    const events: WalletEvent[] = [];
    A = track((await TrikeyWallet.open(phoneA.deps))!);
    A.on((ev) => events.push(ev));
    A.on((ev) => eventsA.push(ev));
    await A.start();
    expect(events).toContainEqual({ type: 'pending_settled', method: 'policy.update', ok: true });
    expect(A.state.pending).toBeUndefined();
    expect(A.state.rules?.policy.recoveryDelayDays).toBe(30);
    expect(rig.logLines.some((l) => l.includes('rpc.replay_after_restart method=policy.update'))).toBe(true);
    // Back to a 7-day delay for the recovery tests (shortening needs the hardware wallet).
    expect(await A.setRecoveryDelay(7)).toMatchObject({ approvedBy: 'hardware' });
  });

  let phoneB: Phone;
  let B: TrikeyWallet;

  it('recovery: the hardware wallet starts one from a new phone after the old one is "lost"; the old phone is alerted and cancels it (contested), then resumes with the hardware wallet', async () => {
    await A.sync();
    const coins = A.snapshot()!.utxos.length;
    expect(coins).toBeGreaterThan(1);

    // A new phone with nothing but the hardware wallet and the guardian's npub and relays.
    phoneB = newPhone({ rpcTimeoutMs: 3000 });
    B = track(await TrikeyWallet.create(phoneB.deps, { deviceName: 'New phone' }));
    const bPrompts: string[] = [];
    const bAlerts: Alert[] = [];
    B.on((e) => e.type === 'hardware_prompt' && bPrompts.push(e.text));
    B.on((e) => e.type === 'alert' && bAlerts.push(e.alert));
    const rec = await B.recoverWithHardware({ guardian: { npub: npubEncode(rig.pubkey), relays: rig.relayUrls } });
    expect(bPrompts[0]).toMatch(new RegExp(`^Trikey recovery-access v1 guardian=${rig.pubkey} phone=${B.state.nostrPubkey} expires=`));
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'hardware', delayDays: 7 });
    expect(B.stage).toBe('recovering');
    // The new wallet: B's key 2, the same hardware wallet, the same guardian key; the lost phone key is gone.
    const dest = MultisigWallet.fromDescriptor(B.state.recovery!.destination!.descriptor, A.network);
    const old = A.multisig();
    expect(dest.keys.app.xpub).toBe(B.state.key2.xpub);
    expect(dest.keys.hardware).toEqual(old.keys.hardware);
    expect(dest.keys.cosigner).toEqual(old.keys.cosigner);
    expect(rec.destinationWalletId).toBe(dest.fingerprint());
    // The sweep takes every coin, signed by the hardware wallet alone.
    const sweep = rig.guardian.activeRecord()!;
    const a = analyzePsbt(Buffer.from(sweep.sweepPsbt, 'base64'), old.accountPubkeys(), A.network, { outputsAcct: dest.accountPubkeys() });
    expect(a.inputs).toHaveLength(coins);
    expect(a.inputs.every((i) => i.signedBy.join() === 'hardware')).toBe(true);
    expect(a.fee).toBeLessThanOrEqual(20_000n);
    // B may read the wallet but not spend through the guardian, and it is told about its recovery.
    expect((await B.sync()).balance.totalSats).toBe(A.snapshot()!.balance.totalSats);
    await waitFor(() => bAlerts.find((x) => x.type === 'recovery_started'), 'alert to the recovering phone');

    // B backs up its new key 2 mid-recovery; a restore of that backup follows the same recovery.
    const bBackup = await B.createBackup({ recoveryCode: true });
    const phoneE = newPhone();
    const E = track(await TrikeyWallet.restoreFromBackup(phoneE.deps, { recoveryCode: bBackup.recoveryCode! }, { name: bBackup.name }));
    expect(E.state).toMatchObject({ stage: 'recovering', key2: B.state.key2, wallet: { walletId }, recovery: { role: 'initiator', destination: { walletId: rec.destinationWalletId } } });
    expect((await E.recoveryStatus())?.recoveryId).toBe(rec.recoveryId);
    expect(await E.renewRecoveryAccess()).toMatchObject({ accessExpiresAt: expect.any(Number) });
    await E.close();
    cloud.files.delete(bBackup.name);

    // The old phone is told, and its phone-only payments are paused.
    const started = await waitFor(() => alertsA().find((x): x is Extract<Alert, { type: 'recovery_started' }> => x.type === 'recovery_started'), 'recovery alert');
    expect(started).toMatchObject({ recoveryId: rec.recoveryId, survivingRole: 'hardware' });
    await waitFor(() => A.state.recovery?.recovery?.recoveryId === rec.recoveryId, 'recovery tracked');
    expect(A.state.recovery?.role).toBe('observer');
    await A.sync();
    expect(A.quoteSend({ address: externalAddress(), amountSats: 1_000 }).plan).toEqual({ signer: 'phone+hardware', reason: 'recovery-pending' });

    // "That was not me": cancel from the phone. The phone did not start it, so the cancel is contested.
    const c = await A.cancelRecovery();
    expect(c).toMatchObject({ contested: true, recovery: { state: 'cancelled', cancelledBy: 'app' } });
    await waitFor(() => alertsA().find((x) => x.type === 'recovery_cancelled'), 'cancel alert');
    expect(A.state.guardianStatus?.phoneSpending).toBe('paused_contested');
    expect((await B.recoveryStatus(rec.recoveryId))?.state).toBe('cancelled');
    await waitFor(() => bAlerts.find((x) => x.type === 'recovery_cancelled'), 'cancel alert to the recovering phone');
    await A.sync();
    const paused = A.quoteSend({ address: externalAddress(), amountSats: 1_000 });
    expect(paused.plan).toEqual({ signer: 'phone+hardware', reason: 'phone-spending-paused' });
    const forced = await A.send({ ...paused, plan: { signer: 'phone+guardian' } }, { fallbackToHardware: false });
    expect(forced).toMatchObject({ ok: false, refusal: { kind: 'phone_spending_paused', cause: 'contested_recovery' } });

    // The hardware wallet confirms: phone payments resume.
    await A.resumePhoneSpending();
    expect(prompts().at(-1)).toMatch(new RegExp(`^Trikey resume-phone v1 wallet=${walletId} seq=\\d+ expires=`));
    expect(A.state.guardianStatus?.phoneSpending).toBe('enabled');
    expect(await A.send({ address: externalAddress(), amountSats: 2_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('recovery: the phone starts one after losing the hardware wallet, and the old hardware wallet cancels it', async () => {
    const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    provider.device = newDevice;
    const rec = await A.startRecovery({ lostKey: 'hardware' });
    provider.device = device;
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'app' });
    const dest = MultisigWallet.fromDescriptor(A.state.recovery!.destination!.descriptor, A.network);
    expect(dest.keys.app.xpub).toBe(A.state.key2.xpub);
    expect(dest.keys.hardware.fingerprint).toBe(newDevice.info.fingerprint);
    expect(A.state.recovery).toMatchObject({ role: 'initiator', destination: { hardware: { fingerprint: newDevice.info.fingerprint } } });
    // The phone cannot co-sign while it runs.
    await A.sync();
    expect(A.quoteSend({ address: externalAddress(), amountSats: 1_000 }).plan.signer).toBe('phone+hardware');

    // The "lost" hardware wallet turns up: it cancels with an approval. It did not start this one: contested.
    const c = await A.cancelRecovery({ withHardware: true });
    expect(c).toMatchObject({ contested: true, recovery: { state: 'cancelled', cancelledBy: 'hardware' } });
    expect(prompts().at(-1)).toMatch(new RegExp(`^Trikey cancel-recovery v1 wallet=${walletId} seq=\\d+ recovery=${rec.recoveryId} expires=`));
    await A.resumePhoneSpending();
    expect(A.state.guardianStatus?.phoneSpending).toBe('enabled');
  });

  let recoveryCode: string;

  it('backs up key 2 and the wallet, and restores on a new phone with the synced passkey', async () => {
    const before = biometricLoads(phoneA).length;
    const b = await A.createBackup({ passkey: true, recoveryCode: true });
    recoveryCode = b.recoveryCode!;
    expect(recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(biometricLoads(phoneA).slice(before).map((l) => l.reason)).toEqual(['Back up your phone key']);
    expect([...cloud.files.keys()]).toEqual([b.name]);
    const bytes = cloud.files.get(b.name)!;
    expect(parseBackup(bytes).header.slots.map((s) => s.type)).toEqual(['passkey-prf', 'recovery-code']);
    // Nothing in the clear: no key, descriptor, wallet id or words.
    const text = Buffer.from(bytes).toString('latin1');
    for (const secret of [A.state.key2.xpub, walletId, A.state.wallet!.descriptor.slice(0, 40)]) expect(text).not.toContain(secret);

    // A second backup replaces the first.
    const b2 = await A.createBackup({ passkey: true, recoveryCode: true });
    recoveryCode = b2.recoveryCode!;
    expect([...cloud.files.keys()]).toEqual([b2.name]);

    // Days later, on a new phone (the relays have long dropped the old phone's expired messages).
    rig.clock.advance(6 * 60_000);
    const phoneC = newPhone();
    const C = track(await TrikeyWallet.restoreFromBackup(phoneC.deps, { passkey: true }));
    expect(C.state).toMatchObject({ stage: 'paired', nostrPubkey: A.state.nostrPubkey, key2: A.state.key2, wallet: { walletId } });
    expect(phoneC.secure.items.get(C.state.secrets.key2)).toMatchObject({ requireBiometrics: true });
    expect(C.snapshot()!.balance).toEqual(A.snapshot()!.balance);
    expect((await C.getRules()).policy.alertContacts).toHaveLength(1);
    expect(C.alertContacts()[0]?.name).toBe('Alice');
    // The guardian already knows this phone (the nostr key comes from the seed): it co-signs right away.
    expect(await C.send({ address: externalAddress(), amountSats: 3_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    await expect(TrikeyWallet.restoreFromBackup(phoneC.deps, { passkey: true })).rejects.toMatchObject({ code: 'wallet_exists' });
  });

  it('restores with the recovery code; refuses a wrong code, a typo and a tampered or spliced backup', async () => {
    rig.clock.advance(6 * 60_000);
    const phoneD = newPhone();
    const D = track(await TrikeyWallet.restoreFromBackup(phoneD.deps, { recoveryCode: recoveryCode.toLowerCase().replace(/-/g, ' ') }));
    expect(D.state).toMatchObject({ stage: 'paired', wallet: { walletId } });

    const name = [...cloud.files.keys()].find((n) => n.startsWith(BACKUP_FILE_PREFIX))!;
    const good = cloud.files.get(name)!;
    const tryRestore = async (bytes: Uint8Array, code = recoveryCode) => {
      cloud.files.set(name, bytes);
      try {
        return await walletError(TrikeyWallet.restoreFromBackup(newPhone().deps, { recoveryCode: code }, { name }));
      } finally {
        cloud.files.set(name, good);
      }
    };
    expect((await tryRestore(good, generateRecoveryCode())).code).toBe('backup_wrong_secret');
    const typo = recoveryCode.slice(0, 3) + (recoveryCode[3] === 'A' ? 'B' : 'A') + recoveryCode.slice(4);
    expect((await tryRestore(good, typo)).code).toBe('recovery_code_typo');

    const flipped = good.slice();
    flipped[flipped.length - 5]! ^= 0x01; // the ciphertext
    expect((await tryRestore(flipped)).code).toBe('backup_invalid');
    // A changed header byte (here: a digit of createdAt) breaks the payload's associated data.
    const { header } = parseBackup(good);
    const headerText = new TextDecoder().decode(good);
    const at = headerText.indexOf(`"createdAt":${header.createdAt}`) + '"createdAt":'.length;
    const edited = good.slice();
    edited[at] = edited[at] === 0x31 ? 0x32 : 0x31;
    expect((await tryRestore(edited)).code).toBe('backup_invalid');
    // Another version byte is refused outright.
    const v2 = good.slice();
    v2[4] = 2;
    expect((await tryRestore(v2)).code).toBe('backup_invalid');
    // The header (slots) of one backup with the ciphertext of another: refused.
    const other = await A.createBackup({ recoveryCode: true });
    const otherBytes = cloud.files.get(other.name)!;
    cloud.files.delete(other.name);
    const p1 = parseBackup(good);
    const p2 = parseBackup(otherBytes);
    const spliced = new Uint8Array([...p2.aad, ...p1.ciphertext]);
    expect((await tryRestore(spliced, other.recoveryCode)).code).toBe('backup_invalid');
  });

  it('refuses to relay an unrelated transaction, and drops chain calls from an unpaired sender', async () => {
    const key = new Uint8Array(32).fill(5);
    const stranger = btc.p2wpkh(secp256k1.getPublicKey(key, true), A.network.btc);
    const coin = rig.fund(stranger.script, 10_000n);
    const tx = new btc.Transaction();
    tx.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script: stranger.script, amount: 10_000n } });
    tx.addOutputAddress(externalAddress(4), 9_000n, A.network.btc);
    tx.sign(key);
    tx.finalize();
    const e = await walletError(A.broadcast(hex.encode(tx.extract())));
    expect(e).toMatchObject({ code: 'guardian_refused', refusal: { kind: 'foreign_transaction' } });

    const pool = new SimplePoolRelayPool();
    const stray = new RpcClient({ pool, relays: rig.relayUrls, secretKey: generateSecretKey(), peer: rig.pubkey, now: () => rig.nowSec() });
    await expect(stray.call('wallet.sync', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(stray.call('tx.broadcast', { txHex: hex.encode(tx.extract()) }, { timeoutMs: 500 })).rejects.toBeInstanceOf(RpcTimeoutError);
    stray.close();
    pool.close();
    // A phone with recovery access may read, but not relay.
    await expect(B.broadcast(hex.encode(tx.extract()))).rejects.toMatchObject({ refusal: { kind: 'unreachable' } });
  });

  it('refuses mainnet in the software hardware wallet', () => {
    expect(() => new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'bitcoin' })).toThrow(/regtest only/);
  });

  it('reads the guardian\'s recovery code for a new phone', () => {
    const uri = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    expect(TrikeyWallet.parseRecoveryCode(uri, 'regtest')).toEqual({ npub: npubEncode(rig.pubkey), relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    expect(() => TrikeyWallet.parseRecoveryCode(uri, 'bitcoin')).toThrow(expect.objectContaining({ code: 'network_mismatch' }));
    expect(() => TrikeyWallet.parseRecoveryCode(rig.pairingUri())).toThrow(expect.objectContaining({ code: 'pairing_uri_invalid' }));
  });

  it('locks the guardian from the phone, then unlocks it with the passphrase', async () => {
    await A.lockGuardian();
    expect(rig.guardian.locked).toBe(true);
    expect(A.state.guardianStatus?.state).toBe('locked');
    await waitFor(() => alertsA().find((a) => a.type === 'guardian_locked' && a.reason === 'remote'), 'remote lock alert');
    await A.lockGuardian(); // already locked: fine
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
  });

  it('retires the wallet on the guardian with a hardware approval ("Replace guardian")', async () => {
    const walletId = A.state.wallet!.walletId;
    const res = await A.retireWallet();
    expect(res).toEqual({ walletId, retiredAt: rig.nowSec() });
    expect(prompts().at(-1)).toMatch(new RegExp(`^Trikey retire-wallet v1 wallet=${walletId} seq=\\d+ expires=`));
    expect(rig.guardian.engine.registration()).toBeUndefined();
    expect(rig.guardian.engine.retiredWallets().map((r) => r.registration.walletId)).toContain(walletId);
    await waitFor(() => alertsA().find((a) => a.type === 'wallet_retired' && a.walletId === walletId), 'retired alert');
  });
});
