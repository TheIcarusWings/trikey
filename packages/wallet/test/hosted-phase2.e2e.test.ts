/**
 * A hosted wallet, family hosting phase 2 (docs/design/family-hosting.md, section 16): the real wallet against real
 * guardian services in-process (`@trikey/guardian/testing`) on one fake Bitcoin network, with the guest's chain data
 * from an in-process Esplora-like server.
 *
 * - The contacts may pause the wallet from acceptance (the host's guardian reports `contact_lock`).
 * - The limit off, with the hardware wallet (the host's version-2 text over the key-set id), and back on from the phone.
 * - The phone pauses the wallet (`guardian.lock` from a guest): payments fall back to the hardware wallet; the phone
 *   cannot unlock the host's box; the hardware wallet resumes it.
 * - Leaving: the leave check names what is still there and `leaveHost` refuses; "Replace guardian" moves the money to
 *   a guardian of the guest's own, then releases the slot on the host's guardian; an empty wallet releases its slot
 *   directly.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock, type FakeElectrum } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { FakeEsplora, MNEMONICS, externalAddress, phone } from './helpers.js';

const clock = new ManualClock(Date.now());
let host: GuardianRig;
let own: GuardianRig;
let net: FakeElectrum;
let servers: ReturnType<typeof FakeEsplora.servers>;
const opened: TrikeyWallet[] = [];
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
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
  [host, own] = await Promise.all([GuardianRig.start({ clock, http: true }), GuardianRig.start({ clock })]);
  net = host.electrs;
  // One Bitcoin network for both boxes.
  const orphan = own.electrs;
  own.electrs = net;
  await own.restart();
  await own.unlock();
  await orphan.stop();
  servers = FakeEsplora.servers(net);
}, 60_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  for (const r of [host, own]) await r?.stop();
});

async function guest(name: string, mnemonic: string, rules: Policy): Promise<{ w: TrikeyWallet; slotId: string }> {
  const r = await host.api('POST', '/hosting/invites', { name });
  const device = new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind: 'ledger' });
  const p = phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey, hostedChain: servers.factory });
  const w = await TrikeyWallet.create(p.deps, { deviceName: `${name} phone` });
  opened.push(w);
  await w.connectHardware();
  await w.acceptInvite({ inviteUri: r.body.link, rules, walletLabel: name, understood: true });
  await w.createBackup({ passkey: true });
  return { w, slotId: host.guardian.hosting.registry.slots.find((s) => s.name === name)!.slotId };
}

describe('a hosted wallet, phase 2', { timeout: 120_000 }, () => {
  let A: TrikeyWallet;
  let slotA: string;

  it('accepts an invite with the contacts allowed to pause the wallet; the guest sees limit_off and contact_lock', async () => {
    ({ w: A, slotId: slotA } = await guest('Ana', MNEMONICS.hardware, { ...RULES, contactLock: true }));
    expect(A.contactLockOn).toBe(true);
    const st = await A.refreshStatus();
    expect(st.features).toEqual(expect.arrayContaining(['family_hosting', 'limit_off', 'contact_lock']));
    expect(A.limitOffSupported).toBe(true);
    expect(A.contactLockSupported).toBe(true);
    const { index } = await A.receiveAddress();
    host.fund(A.multisig().derive(0, index).script, 600_000n);
    await A.sync();
  });

  it('turns the limit off with the hardware wallet, pays past the old limit with the guardian, turns it back on alone', async () => {
    await A.turnLimitOff();
    await A.refreshStatus();
    expect(A.limitOff).toBe(true);
    const res = await A.send({ address: externalAddress(), amountSats: 250_000 });
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    await A.setDailyLimit(100_000);
    await A.refreshStatus();
    expect(A.limitOff).toBe(false);
  });

  it("pauses from the phone: the host's box stays unlocked, payments fall back to the hardware wallet, only it resumes", async () => {
    await A.lockGuardian();
    expect(A.hostedPause).toMatchObject({ by: 'phone' });
    expect(host.guardian.locked).toBe(false);
    expect((await walletError(A.unlockGuardian(host.passphrase))).code).toBe('wrong_state');
    const paid = await A.send({ address: externalAddress(), amountSats: 5_000 });
    expect(paid).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    await A.resumePhoneSpending();
    expect(A.hostedPause).toBeUndefined();
    clock.advance(25 * 3_600_000);
    await host.mine(12);
    expect(await A.send({ address: externalAddress(), amountSats: 5_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('the leave check names the money still there, and leaving is refused', async () => {
    await A.sync();
    const check = await A.hostedLeaveCheck();
    expect(check.safe).toBe(false);
    expect(check.blockers).toContainEqual(expect.objectContaining({ kind: 'money_left', server: 'primary' }));
    const e = await walletError(A.leaveHost());
    expect(e.code).toBe('not_safe_to_release');
    expect(e.blockers?.length).toBeGreaterThan(0);
    expect(host.guardian.hosting.registry.slot(slotA)?.state).toBe('active');
  });

  it("Replace guardian moves the money to the guest's own guardian, then releases the slot on the host's guardian", async () => {
    const oldHash = A.multisig().fingerprint();
    const plan = await A.previewReplaceGuardian(own.pairingUri());
    expect(plan.oldWalletId).toBe(A.state.wallet!.walletId);
    expect(plan.coins).toBeGreaterThan(0);
    const out = await A.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', oldWalletRetired: true });
    expect(A.isHosted).toBe(false);
    expect(A.state.guardian!.pubkey).toBe(own.pubkey);
    // The new guardian watches the old (hosted) wallet by its descriptor hash.
    expect(own.guardian.engine.registration()?.origin).toMatchObject({ kind: 'paired', replacesWalletId: oldHash });
    const slot = host.guardian.hosting.registry.slot(slotA)!;
    expect(slot.state).toBe('left');
    expect(slot.key3Mix).toBeUndefined();
    expect((await A.sync()).balance.totalSats).toBe(out.status === 'done' ? out.movedSats : -1);
    expect(await A.send({ address: externalAddress(), amountSats: 5_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('an empty hosted wallet releases its slot directly; the phone keeps it as retired', async () => {
    const { w: B, slotId } = await guest('Bob', MNEMONICS.hardware2, RULES);
    const check = await B.hostedLeaveCheck();
    expect(check).toEqual({ safe: true, blockers: [] });
    const res = await B.leaveHost();
    expect(res.walletId).toBe(B.state.wallet!.walletId);
    expect(host.guardian.hosting.registry.slot(slotId)?.state).toBe('left');
    expect(B.state.retiredByGuardian).toMatchObject({ reason: 'retired' });
  });
});
