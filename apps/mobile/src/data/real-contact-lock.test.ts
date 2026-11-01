/**
 * "Alert contacts can lock the guardian" in the app's state, from the real wallet service against the real guardian
 * in-process (regtest, throwaway keys): the guardian says it can (`contactLock.supported`), the switch turns on from the
 * phone alone, a contact's `LOCK` (sent from a plain nostr client) shows up as "locked by Maria" on Home and in the
 * activity, the phone unlocks as before, and turning it off asks the hardware wallet with a text that says `lock=off`.
 * A guardian that does not report the feature is not offered it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { SimplePoolRelayPool, wrapDirectMessage } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { guardianLockedLine } from './format';
import { createRealWalletService, type RealWalletService } from './real';
import { canOfferContactLock } from './rules';
import type { DevicePrompt } from './types';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
// Maria: an alert contact with an ordinary nostr app. A fixed throwaway key.
const mariaKey = new Uint8Array(32).fill(44);
const mariaPub = getPublicKey(mariaKey);
const contactPool = new SimplePoolRelayPool();
let rig: GuardianRig;
let svc: RealWalletService;
const prompts: DevicePrompt[] = [];
const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [provider],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  svc.prompts.subscribe(() => {
    const p = svc.prompts.getSnapshot();
    if (p) prompts.push(p);
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  svc.setOnboardingContacts([{ name: 'Maria', npub: npubEncode(mariaPub) }]);
  await svc.setUpRules(100_000, 7);
  await svc.sync();
}, 60_000);

afterAll(async () => {
  contactPool.close();
  await svc?.close();
  await rig?.stop();
});

describe('contacts can lock the guardian, in the app', { timeout: 120_000 }, () => {
  it('is off after pairing, and offered because the guardian says it can', () => {
    const s = svc.getState();
    expect(s.contactLock).toEqual({ on: false, supported: true });
    expect(canOfferContactLock(s)).toBe(true);
  });

  it('turns on from the phone alone', async () => {
    const before = signs();
    await svc.setContactLock(true);
    expect(signs()).toBe(before);
    expect(svc.getState().contactLock!.on).toBe(true);
    expect(rig.guardian.engine.status().rules!.contactLock).toBe(true);
    expect(svc.getState().activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'contact-lock-on' }) }));
  });

  it("Maria sends LOCK: Home says she locked it, the activity too, and payments wait for the hardware wallet", async () => {
    await contactPool.publish(rig.relayUrls, wrapDirectMessage('LOCK', { senderSecretKey: mariaKey, recipient: rig.pubkey, now: rig.nowSec() }));
    await until(() => rig.guardian.locked, 'the guardian locks');
    await until(() => svc.getState().activity.some((a) => a.type === 'security' && a.event.kind === 'guardian-locked' && a.event.byContact === 'Maria'), 'the activity entry');
    await svc.sync();
    const s = svc.getState();
    expect(s.guardian).toMatchObject({ status: 'locked', lockedByContact: { name: 'Maria', npub: npubEncode(mariaPub) } });
    expect(guardianLockedLine(s.guardian, 'Umbrel', 'Ledger')).toMatch(/^Maria locked your guardian/);
  });

  it('the phone unlocks it as before', async () => {
    await svc.unlockGuardian(rig.passphrase);
    await svc.sync();
    expect(rig.guardian.locked).toBe(false);
    expect(svc.getState().guardian.status).toBe('online');
    expect(svc.getState().guardian.lockedByContact).toBeUndefined();
  });

  it('turning it off asks the hardware wallet, with a text that says lock=off', async () => {
    const before = signs();
    await svc.setContactLock(false);
    expect(signs()).toBe(before + 1);
    expect(prompts.some((p) => /Trikey policy v3 wallet=[0-9a-f]{16} seq=\d+ .* lock=off hash=/.test(p.detail ?? ''))).toBe(true);
    expect(svc.getState().contactLock!.on).toBe(false);
    expect(rig.guardian.engine.status().rules!.contactLock).toBeUndefined();
    expect(svc.getState().activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'contact-lock-off' }) }));
  });

  it('a guardian without the feature is not offered it, and asking anyway asks nothing of the hardware wallet', async () => {
    rig.guardian.features = ['limit_off'];
    try {
      await svc.sync();
      expect(svc.getState().contactLock).toEqual({ on: false, supported: false });
      expect(canOfferContactLock(svc.getState())).toBe(false);
      const before = signs();
      expect(await failure(svc.setContactLock(true))).toMatchObject({ kind: 'not_available', message: expect.stringMatching(/Update the guardian/) });
      expect(signs()).toBe(before);
      expect(rig.guardian.engine.status().rules!.contactLock).toBeUndefined();
    } finally {
      rig.guardian.features = ['limit_off', 'contact_lock'];
    }
  });
});
