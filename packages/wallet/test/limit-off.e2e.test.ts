/**
 * "No daily limit" end to end, against the real guardian service in-process (`@trikey/guardian/testing`), with a software
 * hardware wallet, regtest and throwaway keys (docs/design/savings-and-limit-off.md, section 4):
 *
 * - the phone turns the limit off with a hardware approval whose text says `limit=off` (`Trikey policy v2 ...`);
 * - the guardian tells the phone (`limit_off`) and the alert contact (a NIP-17 DM a plain nostr app can read);
 * - phone + guardian then send more than the old limit;
 * - the phone alone turns it back on, the phone is told (`limit_on`), and the limit holds again;
 * - a guardian that does not report `limit_off` is never asked: nothing is signed, nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nip17 from 'nostr-tools/nip17';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { LIMIT_OFF_SATS, SimplePoolRelayPool, approvalMessage, policyHash, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

// The alert contact: any nostr app that reads NIP-17 DMs. A fixed throwaway key.
const contactKey = new Uint8Array(32).fill(41);
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
  const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'Limit phone' });
  w.on((e) => events.push(e));
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
}, 30_000);

afterAll(async () => {
  contactPool.close();
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

const fundVault = (index: number, sats: number) => rig.fund(w.multisig().derive(0, index).script, BigInt(sats));

describe('turning the daily limit off and on again', { timeout: 90_000 }, () => {
  it('the guardian reports the feature; the limit is on to begin with and holds', async () => {
    fundVault(0, 400_000);
    fundVault(1, 400_000);
    await w.sync();
    expect(w.limitOffSupported).toBe(true);
    expect(w.limitOff).toBe(false);
    expect(w.snapshot()!.dailyLimit).toMatchObject({ limitSats: 100_000, off: false });
    expect(w.quoteSend({ address: externalAddress(), amountSats: 250_000 }).plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
  });

  it('turns it off with a hardware approval that says limit=off, and the phone and the contact are told', async () => {
    const before = signs();
    const res = await w.turnLimitOff();
    expect(res).toMatchObject({ approvedBy: 'hardware', policy: { dailyLimitSats: LIMIT_OFF_SATS } });
    expect(signs()).toBe(before + 1);
    // The device showed, and signed, the version-2 text: "limit=off" in words.
    const text = prompts().at(-1)!;
    const expiresAt = Number(new Date(text.match(/expires=(\S+)$/)![1]!).getTime() / 1000);
    expect(text).toBe(approvalMessage({ action: 'policy', policy: res.policy }, { walletId: w.multisig().fingerprint(), sequence: 1, expiresAt }));
    expect(text).toMatch(new RegExp(`^Trikey policy v2 wallet=[0-9a-f]{16} seq=1 limit=off delay=7d feecap=20000 contacts=1 hash=${policyHash(res.policy)} expires=`));
    expect(device.calls.filter((c) => c.op === 'signMessage').at(-1)).toMatchObject({ message: text });

    expect(rig.guardian.engine.status().dailyLimit).toMatchObject({ off: true, limitBeforeOff: 100_000n });
    await w.refreshStatus();
    expect(w.limitOff).toBe(true);
    expect(w.limitBeforeOff).toBe(100_000);
    expect(w.snapshot()!.dailyLimit).toMatchObject({ off: true, limitSats: LIMIT_OFF_SATS });

    // The phone gets `limit_off`; the contact a DM in plain words.
    const alert = await waitFor(() => alerts().find((a) => a.type === 'limit_off'), 'limit_off alert');
    expect(alert).toMatchObject({ type: 'limit_off', sequence: 1, limitBeforeSats: 100_000 });
    const dm = await waitFor(() => contactInbox.find((m) => m.includes('daily limit')), 'contact DM');
    expect(dm).toMatch(/was turned off/);
    expect(dm).toMatch(/can send everything/);
    // Once each: both are recorded as delivered.
    await waitFor(() => rig.guardian.engine.dueNotices().length === 0, 'notice delivered');
  });

  it('phone + guardian now send more than the old limit, Face ID only', async () => {
    const q = w.quoteSend({ address: externalAddress(), amountSats: 250_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const signsBefore = device.calls.filter((c) => c.op === 'signPsbt').length;
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signsBefore);
    expect(rig.guardian.engine.status().dailyLimit!.used).toBeGreaterThan(250_000n);
  });

  it('the phone alone turns it back on; the phone is told, and the limit holds again', async () => {
    const before = signs();
    const res = await w.setDailyLimit(100_000);
    expect(res).toMatchObject({ approvedBy: 'phone', policy: { dailyLimitSats: 100_000 } });
    expect(signs()).toBe(before);
    expect(rig.guardian.engine.status().dailyLimit).toMatchObject({ limit: 100_000n });
    expect(rig.guardian.engine.status().dailyLimit!.off).toBeUndefined();
    expect(w.limitOff).toBe(false);
    await waitFor(() => alerts().find((a) => a.type === 'limit_on'), 'limit_on alert');
    expect(alerts().find((a) => a.type === 'limit_on')).toMatchObject({ limitSats: 100_000, reason: 'phone' });

    await w.sync();
    // Over what is left today: the hardware wallet, as before.
    const q = w.quoteSend({ address: externalAddress(), amountSats: 50_000 });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    // A phone that thinks otherwise is refused by the guardian, and the hardware wallet signs instead.
    const forced = { ...q, plan: { signer: 'phone+guardian' as const } };
    expect(await w.send(forced)).toMatchObject({ ok: true, signedBy: 'phone+hardware', guardianRefusal: { kind: 'over_daily_limit' } });
  });

  it('a guardian that does not report limit_off is not offered it: nothing is signed or sent', async () => {
    rig.guardian.features = [];
    try {
      await w.refreshStatus();
      expect(w.limitOffSupported).toBe(false);
      const before = signs();
      const seq = rig.guardian.engine.status().nextHardwareSequence;
      expect((await walletError(w.turnLimitOff())).code).toBe('guardian_unsupported');
      expect((await walletError(w.setDailyLimit(LIMIT_OFF_SATS))).code).toBe('guardian_unsupported');
      expect(signs()).toBe(before);
      expect(rig.guardian.engine.status().nextHardwareSequence).toBe(seq);
      expect(rig.guardian.engine.status().dailyLimit).toMatchObject({ limit: 100_000n });
      // Other approvals go on as before (the version-1 text such a guardian rebuilds).
      const raised = await w.setDailyLimit(120_000);
      expect(raised).toMatchObject({ approvedBy: 'hardware' });
      expect(prompts().at(-1)).toMatch(/^Trikey policy v1 .* limit=120000 /);
    } finally {
      rig.guardian.features = ['limit_off'];
    }
  });
});
