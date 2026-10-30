/**
 * The guardian changes its relays (its web UI's "Change relays"), end to end with the real guardian service
 * (`@trikey/guardian/testing`: in-memory relays, a fake Electrs), the software hardware wallet and in-memory platform
 * stores. The phone follows, pays over the new relay alone, backs the new list up; a backup and a recovery code from
 * before the change still work during the grace period. Regtest only; throwaway keys and published test mnemonics.
 *
 * The tests run in order and share one guardian.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMessageId, encodeRecoveryUri, SimplePoolRelayPool, type Filter, type NostrEvent, type PublishOutcome, type RelayPool, type SubscriptionHandlers } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, sleep, waitFor, type Phone } from './helpers.js';

/** A phone's relay connection that can be cut from some relays (they are gone, as far as this phone can tell), and says where it went. */
class RelayCutPool implements RelayPool {
  readonly inner = new SimplePoolRelayPool();
  /** Every relay list it subscribed on, in order. */
  readonly subscribed: string[][] = [];
  /** Every relay it published to. */
  readonly published = new Set<string>();

  constructor(private readonly cut: Set<string>) {}

  publish(relays: string[], event: NostrEvent): Promise<PublishOutcome[]> {
    const open = relays.filter((r) => !this.cut.has(r));
    for (const r of open) this.published.add(r);
    return this.inner.publish(open, event).then((out) => [...out, ...relays.filter((r) => this.cut.has(r)).map((relay) => ({ relay, ok: false, reason: 'unreachable' }))]);
  }

  subscribe(relays: string[], filter: Filter, handlers: SubscriptionHandlers) {
    this.subscribed.push([...relays]);
    return this.inner.subscribe(
      relays.filter((r) => !this.cut.has(r)),
      filter,
      handlers,
    );
  }

  close(): void {
    this.inner.close();
  }
}

let rig: GuardianRig;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];

/** A phone whose relay pools can be cut from `cut` (shared by all of them), recording where they went. */
function newPhone(cut = new Set<string>()): Phone & { cut: Set<string>; relayPools: RelayCutPool[] } {
  const relayPools: RelayCutPool[] = [];
  const p = phone({
    clock: rig.clock,
    hardware: provider,
    cloud,
    passkey,
    pool: () => {
      const pool = new RelayCutPool(cut);
      relayPools.push(pool);
      return pool;
    },
  });
  return { ...p, cut, relayPools };
}

const track = (w: TrikeyWallet): TrikeyWallet => (opened.push(w), w);

let old: string[];
let C: string;
let D: string;
let A: TrikeyWallet;
let phoneA: ReturnType<typeof newPhone>;
let walletId: string;
let oldBackup: { name: string; recoveryCode?: string };

beforeAll(async () => {
  rig = await GuardianRig.start();
  old = rig.relayUrls;
  C = (await rig.addRelay()).url;
  D = (await rig.addRelay()).url;
}, 30_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  await rig?.stop();
});

describe('changing the guardian\'s relays', { timeout: 60_000 }, () => {
  it('a paired phone with coins and a backup, all on the setup relays', async () => {
    phoneA = newPhone();
    A = track(await TrikeyWallet.create(phoneA.deps, { deviceName: 'Test phone' }));
    await A.connectHardware();
    await A.scanGuardian(rig.pairingUri());
    walletId = (await A.pair({ rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 } })).walletId;
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    rig.fund(A.multisig().derive(0, 1).script, 50_000n);
    await A.sync();
    expect(A.state.guardian!.relays).toEqual(old);
    oldBackup = await A.createBackup({ recoveryCode: true });
  });

  it('the phone takes the new list from its guardian, confirms over it, and moves its connection there', async () => {
    expect(await rig.guardian.changeRelays([C])).toEqual({ ok: true, changed: true });
    await waitFor(() => A.state.guardian!.relays.join() === C, 'the phone to follow');
    // The phone switched only after the guardian answered its relays.ack over the new relay.
    expect(rig.guardian.service.get().relaysChange?.confirmedAt).toBeDefined();
    // Persisted: a fresh load of the phone's state has the new list.
    const stored = JSON.parse((await phoneA.kv.get('trikey.wallet.v1'))!) as { guardian: { relays: string[] } };
    expect(stored.guardian.relays).toEqual([C]);
    // The newest connection subscribes on the new relay only.
    expect(phoneA.relayPools.at(-1)!.subscribed).toEqual([[C]]);
  });

  it('pays with the guardian over the new relay alone', async () => {
    for (const r of old) phoneA.cut.add(r); // the old relays are gone, as far as this phone can tell
    const before = new Set(phoneA.relayPools.flatMap((p) => [...p.published]));
    await A.sync();
    const q = A.quoteSend({ address: externalAddress(), amountSats: 20_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) throw new Error('unreachable');
    expect(rig.electrs.broadcasts).toContain(res.txHex);
    const after = new Set(phoneA.relayPools.flatMap((p) => [...p.published]));
    expect([...after].filter((r) => !before.has(r))).toEqual([]);
    expect(after.has(C)).toBe(true);
  });

  it('only its paired guardian can move the phone, and only to a valid list', async () => {
    const onAlert = (A as unknown as { onAlert(a: unknown, m: { id: string; at: number }, from?: string): Promise<void> }).onAlert.bind(A);
    const at = rig.nowSec();
    // Another key (the connection's peer is what the client checked the sender against).
    await onAlert({ type: 'relays_changed', relays: ['wss://evil.example'], at }, { id: generateMessageId(), at }, 'ab'.repeat(32));
    // No peer named: an alert routed from nowhere in particular.
    await onAlert({ type: 'relays_changed', relays: ['wss://evil.example'], at }, { id: generateMessageId(), at });
    // The paired guardian, but a list the pairing code's rules refuse.
    await onAlert({ type: 'relays_changed', relays: ['ws://evil.example'], at }, { id: generateMessageId(), at }, rig.pubkey);
    expect(A.state.guardian!.relays).toEqual([C]);
  });

  it('a new list the phone cannot reach does not cut it off: it stays on the relays that work', async () => {
    phoneA.cut.add(D); // a relay that is down, or a typo in the web UI, as far as this phone is concerned
    const changedAt = rig.clock.now();
    expect(await rig.guardian.changeRelays([D])).toMatchObject({ ok: true, changed: true });
    // The phone tries D alone, the guardian does not answer there, so the phone keeps C (still watched by the guardian).
    await waitFor(() => phoneA.relayPools.some((p) => p.subscribed.some((l) => l.join() === D)), 'the phone to try the new relay');
    await sleep(5_500); // its probe's timeout (the phone's rpcTimeoutMs here)
    expect(A.state.guardian!.relays).toEqual([C]);
    expect(rig.guardian.service.get().relaysChange).toEqual({ at: changedAt });
    await A.sync();
    expect(await A.send(A.quoteSend({ address: externalAddress(), amountSats: 5_000 }))).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    // The owner sees "waiting for your phone" and puts C back: the phone hears it over C, and nothing changes for it.
    expect(await rig.guardian.changeRelays([C])).toMatchObject({ ok: true, changed: true });
    await A.refreshStatus();
    expect(A.state.guardian!.relays).toEqual([C]);
    phoneA.cut.delete(D);
  });

  it('a backup made before the change still restores during the grace period, and the phone then follows', async () => {
    rig.clock.advance(6 * 60_000);
    const phoneF = newPhone();
    const F = track(await TrikeyWallet.restoreFromBackup(phoneF.deps, { recoveryCode: oldBackup.recoveryCode! }, { name: oldBackup.name }));
    expect(phoneF.relayPools[0]!.subscribed[0]).toEqual(old); // the backup's (old) relays: the guardian still listens there
    expect(F.state).toMatchObject({ stage: 'paired', wallet: { walletId } });
    await waitFor(() => F.state.guardian!.relays.join() === C, 'the restored phone to follow');
    expect(F.snapshot()!.balance).toEqual(A.snapshot()!.balance);
    await F.close();
  });

  it('the next backup carries the new relays', async () => {
    const b = await A.createBackup({ recoveryCode: true });
    rig.clock.advance(6 * 60_000);
    const phoneE = newPhone(new Set(old));
    const E = track(await TrikeyWallet.restoreFromBackup(phoneE.deps, { recoveryCode: b.recoveryCode! }, { name: b.name }));
    expect(E.state.guardian!.relays).toEqual([C]);
    expect(phoneE.relayPools[0]!.subscribed[0]).toEqual([C]);
    expect(await E.refreshStatus()).toMatchObject({ paired: true });
    await E.close();
  });

  it('a recovery code printed before the change still lets a new phone in during the grace period', async () => {
    const code = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: old, network: 'regtest', label: 'Test Guardian', walletId });
    const phoneG = newPhone(new Set([C])); // it can reach only the old relays
    const G = track(await TrikeyWallet.create(phoneG.deps, { deviceName: 'New phone' }));
    const rec = await G.recoverWithHardware({ guardian: code });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'hardware' });
    expect(rig.guardian.activeRecord()?.id).toBe(rec.recoveryId);
    expect(G.state.guardian!.relays).toEqual(old); // it could not reach C, so it stayed
    // Once it can reach the new relay, it moves there like the paired phone (a recovering phone does not confirm).
    phoneG.cut.clear();
    rig.clock.advance(6 * 60_000); // past the retry interval for a list it already tried
    const confirmedAt = rig.guardian.service.get().relaysChange?.confirmedAt;
    await G.refreshStatus();
    await waitFor(() => G.state.guardian!.relays.join() === C, 'the recovering phone to follow', 20_000);
    expect(rig.guardian.service.get().relaysChange?.confirmedAt).toBe(confirmedAt);
    expect(phoneG.relayPools.at(-1)!.subscribed.at(-1)).toEqual([C]);
  });
});
