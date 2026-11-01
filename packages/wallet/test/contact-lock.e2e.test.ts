/**
 * "Alert contacts can lock the guardian" end to end, against the real guardian service in-process
 * (`@trikey/guardian/testing`), with a software hardware wallet, regtest and throwaway keys
 * (docs/design/contact-lock.md):
 *
 * - pairing may set it on, but only with a guardian that reports `contact_lock` (pair.prepare): nothing is signed for
 *   one that does not;
 * - an alert contact (a plain nostr app) locks the guardian with `LOCK`; the phone hears who (with the name it keeps
 *   for that contact) and payments go phone + hardware; the phone's unlock is unchanged;
 * - turning it off needs the hardware wallet, over the version-3 text that says `lock=off`; on again from the phone
 *   alone; other hardware-approved changes while on sign `lock=on`;
 * - a guardian without the feature is never offered it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nip17 from 'nostr-tools/nip17';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { SimplePoolRelayPool, policyHash, wrapDirectMessage, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, phoneMayApply, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, sleep, waitFor } from './helpers.js';

// The alert contact: any nostr app that reads and sends NIP-17 DMs. A fixed throwaway key.
const contactKey = new Uint8Array(32).fill(43);
const contactPub = getPublicKey(contactKey);
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
let rig: GuardianRig;
let w: TrikeyWallet;
const events: WalletEvent[] = [];
const alerts = () => events.flatMap((e) => (e.type === 'alert' ? [e.alert] : []));
const prompts = () => events.flatMap((e) => (e.type === 'hardware_prompt' ? [e.text] : []));
const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;
const contactPool = new SimplePoolRelayPool();
const contactInbox: string[] = [];

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
  rig = await GuardianRig.start();
  contactPool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [contactPub] }, {
    onevent: (e: NostrEvent) => {
      try {
        const rumor = nip17.unwrapEvent(e, contactKey);
        if (rumor.kind === 14 && rumor.pubkey === rig.pubkey && !contactInbox.includes(rumor.content)) contactInbox.push(rumor.content);
      } catch {
        /* not for us */
      }
    },
  });
}, 30_000);

afterAll(async () => {
  contactPool.close();
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

const fundVault = (index: number, sats: number) => rig.fund(w.multisig().derive(0, index).script, BigInt(sats));

describe('the rule, as the phone decides', () => {
  it('turning it on is tightening, turning it off is not', () => {
    expect(phoneMayApply(RULES, { ...RULES, contactLock: true })).toBe(true);
    expect(phoneMayApply({ ...RULES, contactLock: true }, RULES)).toBe(false);
    expect(phoneMayApply({ ...RULES, contactLock: true }, { ...RULES, contactLock: true, dailyLimitSats: 50_000 })).toBe(true);
  });
});

describe('alert contacts can lock the guardian', { timeout: 90_000 }, () => {
  it('pairing with it on is refused by the phone for a guardian that does not report it: nothing is signed or registered', async () => {
    rig.guardian.features = ['limit_off'];
    const other = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps, { deviceName: 'Old guardian phone' });
    try {
      const before = signs();
      const e = await walletError(other.onboard({ pairingUri: rig.pairingUri(), rules: { ...RULES, contactLock: true } }));
      expect(e.code).toBe('guardian_unsupported');
      expect(signs()).toBe(before);
      expect(rig.guardian.engine.registration()).toBeUndefined();
    } finally {
      rig.guardian.features = ['limit_off', 'contact_lock'];
      await other.close().catch(() => undefined);
    }
  });

  it('a guardian that reports it can be paired with it on; the contact keeps its name on the phone', async () => {
    const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey });
    w = await TrikeyWallet.create(p.deps, { deviceName: 'Contact lock phone' });
    w.on((e) => events.push(e));
    await w.onboard({ pairingUri: rig.pairingUri(), rules: { ...RULES, contactLock: true } });
    await w.nameAlertContact(contactPub, 'Maria');
    fundVault(0, 400_000);
    await w.sync();
    expect(w.contactLockSupported).toBe(true);
    expect(w.contactLockOn).toBe(true);
    expect(rig.guardian.engine.status().rules!.contactLock).toBe(true);
  });

  it('the contact sends LOCK: the guardian locks, the phone hears who, and payments need the hardware wallet', async () => {
    await contactPool.publish(rig.relayUrls, wrapDirectMessage('LOCK', { senderSecretKey: contactKey, recipient: rig.pubkey, now: rig.nowSec() }));
    await waitFor(() => rig.guardian.locked, 'guardian locked');
    await waitFor(() => contactInbox.find((m) => m.startsWith('Trikey: the guardian is locked.')), 'answer to the contact');
    const alert = await waitFor(() => alerts().find((a) => a.type === 'guardian_locked' && a.reason === 'contact'), 'guardian_locked alert');
    expect(alert).toMatchObject({ contact: contactPub });
    await w.refreshStatus();
    expect(w.guardianLock).toMatchObject({ reason: 'contact', contact: { pubkey: contactPub, name: 'Maria' } });
    expect(w.guardianLock!.contact!.npub).toMatch(/^npub1/);
    expect(w.quoteSend({ address: externalAddress(), amountSats: 10_000 }).plan).toMatchObject({ signer: 'phone+hardware' });
  });

  it('the phone unlocks it as before, with the passphrase', async () => {
    expect(await w.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(w.guardianLock).toBeUndefined();
  });

  it('other hardware-approved changes while on are signed over version 3, lock=on', async () => {
    const res = await w.setDailyLimit(150_000);
    expect(res).toMatchObject({ approvedBy: 'hardware', policy: { dailyLimitSats: 150_000, contactLock: true } });
    expect(prompts().at(-1)).toMatch(/^Trikey policy v3 wallet=[0-9a-f]{16} seq=\d+ limit=150000 delay=7d feecap=20000 contacts=1 lock=on hash=/);
  });

  it('turning it off needs the hardware wallet, over a text that says lock=off; the contact is told', async () => {
    const before = signs();
    const res = await w.setContactLock(false);
    expect(res.approvedBy).toBe('hardware');
    expect(res.policy).not.toHaveProperty('contactLock');
    expect(signs()).toBe(before + 1);
    expect(prompts().at(-1)).toMatch(new RegExp(`^Trikey policy v3 .* contacts=1 lock=off hash=${policyHash(res.policy)} expires=`));
    expect(w.contactLockOn).toBe(false);
    await waitFor(() => contactInbox.find((m) => m.includes('can no longer lock')), 'contact told');
    // A LOCK now does nothing, and gets no answer: off, the command does not exist.
    const told = contactInbox.length;
    await contactPool.publish(rig.relayUrls, wrapDirectMessage('lock', { senderSecretKey: contactKey, recipient: rig.pubkey, now: rig.nowSec() }));
    await sleep(800);
    expect(contactInbox.length).toBe(told);
    expect(rig.guardian.locked).toBe(false);
  });

  it('on again from the phone alone: nothing is signed', async () => {
    const before = signs();
    const res = await w.setContactLock(true);
    expect(res).toMatchObject({ approvedBy: 'phone', policy: { contactLock: true } });
    expect(signs()).toBe(before);
    await waitFor(() => contactInbox.find((m) => m.includes('now lets you lock')), 'contact told how to lock');
  });

  it('a guardian that does not report contact_lock is not offered it: nothing is signed or sent', async () => {
    // Off first (hardware), then pretend the guardian is an older one.
    await w.setContactLock(false);
    rig.guardian.features = ['limit_off'];
    try {
      await w.refreshStatus();
      expect(w.contactLockSupported).toBe(false);
      const before = signs();
      const seq = rig.guardian.engine.status().nextHardwareSequence;
      expect((await walletError(w.setContactLock(true))).code).toBe('guardian_unsupported');
      await sleep(50);
      expect(signs()).toBe(before);
      expect(rig.guardian.engine.status().nextHardwareSequence).toBe(seq);
      expect(rig.guardian.engine.status().rules!.contactLock).toBeUndefined();
      // Everything else as before: the version-1 text such a guardian rebuilds.
      const raised = await w.setDailyLimit(160_000);
      expect(raised).toMatchObject({ approvedBy: 'hardware' });
      expect(prompts().at(-1)).toMatch(/^Trikey policy v1 .* limit=160000 /);
    } finally {
      rig.guardian.features = ['limit_off', 'contact_lock'];
    }
  });
});
