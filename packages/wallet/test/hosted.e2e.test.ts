/**
 * A hosted wallet end to end (docs/design/family-hosting.md): the real wallet against the real guardian service (the
 * rig) acting as a host, with the guest's chain data from an in-process Esplora-like server over the rig's chain (the
 * hosting guardian serves none).
 *
 * The guest accepts an invite (disclosure acknowledged), the guardian keeps only account pubkeys and the encrypted
 * wallet map, the phone receives only after a key 2 backup, pays under the limit through the guardian (PSBTs without
 * derivations), reads its co-signed coins; a "hardware wallet lost" recovery is started and cancelled; then a new phone
 * with only the hardware wallet recovers from the wallet map, the guardian completes and rotates, and the new phone
 * confirms its hardware wallet with the tweak.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { keySetId, parseSortedMultiDescriptor } from '@trikey/core';
import { encodeRecoveryUri, type Policy } from '@trikey/protocol';
import { DAY, GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { FakeEsplora, MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

let rig: GuardianRig;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];
let servers: ReturnType<typeof FakeEsplora.servers>;
const CONTACT = 'cd'.repeat(32);
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [CONTACT], sweepFeeCapSats: 20_000 };

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  servers = FakeEsplora.servers(rig.electrs);
}, 30_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  await rig?.stop();
});

describe('a hosted wallet, end to end', { timeout: 90_000 }, () => {
  let A: TrikeyWallet;
  const events: WalletEvent[] = [];
  let walletId: string;
  let inviteLink: string;

  it('accepts an invite: the guardian learns the account pubkeys and an encrypted map, never the descriptor', async () => {
    const r = await rig.api('POST', '/hosting/invites', { name: 'Ana' });
    inviteLink = r.body.link;
    const p = phone({ clock: rig.clock, hardware: provider, cloud, passkey, hostedChain: servers.factory });
    A = await TrikeyWallet.create(p.deps, { deviceName: 'Ana phone' });
    opened.push(A);
    A.on((e) => events.push(e));
    expect(A.parseScannedCode(inviteLink)).toMatchObject({ kind: 'invite', network: 'regtest', label: 'Trikey Guardian' });
    await A.connectHardware();
    expect((await walletError(A.acceptInvite({ inviteUri: inviteLink, rules: RULES, walletLabel: 'Ana', understood: false }))).code).toBe('consent_required');
    const out = await A.acceptInvite({ inviteUri: inviteLink, rules: RULES, walletLabel: 'Ana', understood: true });
    walletId = out.walletId;
    expect(out).toMatchObject({ hosted: true, addressVerified: true, key3Mixed: true });
    expect(A.isHosted).toBe(true);
    const w = A.multisig();
    expect(walletId).toBe(keySetId(w.accountPubkeys()));
    // Key 3 is a depth-0 xpub over the slot's account key and this phone's chaincode.
    const [, , k3] = parseSortedMultiDescriptor(w.descriptor());
    expect(k3.originPath).toBe('');
    const slot = rig.guardian.hosting.registry.slots.find((s) => s.name === 'Ana')!;
    const engine = rig.guardian.hosting.engines.get(slot.slotId)!;
    expect(engine.registration()!.walletId).toBe(walletId);
    const stored = JSON.stringify(engine.snapshot, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(stored).not.toContain(w.keys.app.xpub);
    expect(stored).not.toContain(k3.xpub);
    expect(stored).not.toContain(w.derive(0, 0).address);
    expect(engine.walletMap()?.map).toBeTruthy();
  });

  it('receives only after the phone key backup; chain data comes from the guest server, not the host', async () => {
    expect((await walletError(A.receiveAddress())).code).toBe('backup_required');
    await A.createBackup({ passkey: true });
    const { address, index } = await A.receiveAddress();
    expect(index).toBe(0);
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    const before = rig.electrs.calls.length;
    const snap = await A.sync();
    expect(snap.balance.confirmedSats + snap.balance.unconfirmedSats).toBe(300_000);
    expect(servers.made.some((m) => m.role === 'primary' && m.source.calls > 0)).toBe(true);
    // The guardian's Electrs was asked nothing about the guest's addresses.
    const asked = rig.electrs.calls.slice(before).filter((c) => c.method === 'blockchain.scripthash.listunspent' || c.method === 'blockchain.scripthash.get_history');
    expect(asked).toEqual([]);
    expect(address).toBe(A.multisig().derive(0, 0).address);
  });

  it('pays under the limit with the guardian, and reads back the change it co-signed (on path)', async () => {
    const res = await A.send({ address: externalAddress(), amountSats: 40_000 });
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    const coins = await A.hostedCoins();
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({ onPath: true, chain: 1 });
    // The status is the slot's view.
    const st = await A.refreshStatus();
    expect(st.walletId).toBe(walletId);
    expect(st.features).toEqual(['family_hosting']);
  });

  it('a second server is asked before a recovery sweep; with it down the recovery waits unless the person accepts one server', async () => {
    servers.check.down = true;
    const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' });
    provider.device = newDevice;
    const e = await walletError(A.startRecovery({ lostKey: 'hardware' }));
    expect(e.code).toBe('second_server_unavailable');
    servers.check.down = false;
    const rec = await A.startRecovery({ lostKey: 'hardware' });
    expect(rec.recoveryId).toMatch(/^[0-9a-f]{16}g1-[0-9a-f]{12}$/);
    expect(rec.state).toBe('pending');
    provider.device = device;
    const c = await A.cancelRecovery();
    expect(c.contested).toBe(false);
  });

  it('a new phone with only the hardware wallet recovers from the wallet map; the guardian completes and rotates', async () => {
    const code = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.guardian.service.get().relays, network: 'regtest', walletId, hosted: true });
    expect(TrikeyWallet.prototype.parseScannedCode.call(A, code)).toMatchObject({ kind: 'recovery', hosted: true });
    const p = phone({ clock: rig.clock, hardware: provider, cloud, passkey, hostedChain: servers.factory });
    const B = await TrikeyWallet.create(p.deps, { deviceName: 'New phone' });
    opened.push(B);
    const rec = await B.recoverHostedWithHardware({ code });
    expect(rec.abandoned).toEqual([]);
    expect(B.stage).toBe('recovering');
    expect(B.isHosted).toBe(true);
    // The rebuilt wallet is A's wallet, from the map alone.
    expect(B.state.wallet!.descriptor).toBe(A.state.wallet!.descriptor);
    rig.clock.advance(7 * DAY + 2 * 3_600_000);
    await rig.mine(8);
    await rig.guardian.tick();
    await rig.guardian.tick();
    await waitFor(async () => {
      await B.sync().catch(() => undefined);
      return B.stage === 'paired';
    }, 'the new phone adopted', 20_000);
    expect(B.state.wallet!.walletId).not.toBe(walletId);
    expect(B.state.wallet!.walletId).toBe(keySetId(B.multisig().accountPubkeys()));
    const out = await B.confirmHardware();
    expect(out.addressVerified).toBe(true);
    const st = await B.refreshStatus();
    expect(st.hardwareConfirmRequired).toBe(false);
    void hex;
  });
});
