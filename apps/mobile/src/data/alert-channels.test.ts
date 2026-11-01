/**
 * The guardian's email, ntfy and webhook alerts in the app (docs/design/notifications.md): grouped and worded for
 * Settings > Alert contacts, read-only; the demo wallet shows some; and the real service against the real guardian
 * shows what the owner set up in the guardian's web page, and logs a change. Regtest, throwaway keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { ALERT_CHANNELS, alertChannelText, alertChannelsLine, groupAlertChannels } from './alert-channels';
import { createMockWalletService } from './mock';
import { createRealWalletService, type RealWalletService } from './real';

describe('grouping and words', () => {
  const mariaPub = 'aa'.repeat(32);
  it('groups yours, per contact and without nostr', () => {
    const g = groupAlertChannels([
      { kind: 'email', audience: 'owner', hint: 'y…@example.com' },
      { kind: 'webhook', audience: 'owner', hint: 'homeassistant.local:8123', failing: true },
      { kind: 'ntfy', audience: 'contact', contact: mariaPub, hint: 'ntfy.example.com' },
      { kind: 'email', audience: 'contact', contact: mariaPub, hint: 'm…@example.com' },
      { kind: 'email', audience: 'contact', hint: 'd…@example.org' },
    ]);
    expect(g.you).toEqual([
      { kind: 'email', hint: 'y…@example.com' },
      { kind: 'webhook', hint: 'homeassistant.local:8123', failing: true },
    ]);
    expect(g.byContact[mariaPub]).toHaveLength(2);
    expect(g.withoutNostr).toEqual([{ kind: 'email', hint: 'd…@example.org' }]);
  });

  it('says each in plain words, and that the phone cannot change them', () => {
    expect(alertChannelText({ kind: 'email', hint: 'y…@example.com' })).toBe('Email y…@example.com');
    expect(alertChannelText({ kind: 'webhook', hint: 'homeassistant.local:8123', failing: true })).toBe('Webhook (homeassistant.local:8123), not getting through');
    expect(alertChannelsLine([{ kind: 'email', hint: 'm…@example.com' }, { kind: 'ntfy', hint: 'ntfy.example.com' }])).toBe('Also by email m…@example.com and ntfy (ntfy.example.com)');
    expect(alertChannelsLine([])).toBe('');
    expect(ALERT_CHANNELS.safety).toMatch(/can't change them/);
    expect(ALERT_CHANNELS.limits).toMatch(/Cancelling a recovery and locking the guardian stay with nostr/);
  });

  it('the demo wallet shows some', async () => {
    const svc = createMockWalletService();
    const s = svc.getState();
    expect(s.alertChannels?.you.length).toBeGreaterThan(0);
    expect(s.alertChannels?.byContact[s.contacts[0]!.id]).toBeDefined();
  });
});

describe('the real service against the real guardian', { timeout: 60_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const mariaPub = getPublicKey(new Uint8Array(32).fill(45));
  let rig: GuardianRig;
  let svc: RealWalletService;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  beforeAll(async () => {
    rig = await GuardianRig.start({ notifyTestServers: true });
    const passkey = new MemoryPasskeyPrf();
    passkey.supported = false;
    svc = await createRealWalletService({
      mode: 'simulator',
      platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
      hardware: () => [new SoftwareHardwareProvider(device)],
      clock: rig.clock,
      rpcTimeoutMs: 5000,
      rpcRetryIntervalMs: 0,
      syncIntervalMs: 0,
      yieldToUi: async () => {},
      recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    });
    await svc.connectHardware('simulated');
    await svc.pairGuardian(rig.pairingUri());
    svc.setOnboardingContacts([{ name: 'Maria', npub: npubEncode(mariaPub) }]);
    await svc.setUpRules(100_000, 7);
  }, 60_000);

  afterAll(async () => {
    await rig?.stop();
  });

  it('shows what the owner set up in the web page, next to the contact, and logs the change', async () => {
    const r = await rig.guardian.updateNotifications({
      guardianName: 'Home vault',
      smtp: null,
      // Nothing listens on port 9: deliveries fail and are retried; this test is about the phone.
      destinations: [
        { audience: 'owner', kind: 'webhook', webhook: { url: 'http://127.0.0.1:9/hook' } },
        { audience: 'contact', kind: 'ntfy', contact: mariaPub, ntfy: { server: 'http://127.0.0.1:9', topic: 'maria-topic-for-tests' } },
      ],
    });
    expect(r.ok).toBe(true);
    await until(() => !!svc.getState().alertChannels?.byContact[mariaPub]?.length, 'channels on the phone');
    const s = svc.getState();
    expect(s.alertChannels!.you).toEqual([expect.objectContaining({ kind: 'webhook', hint: '127.0.0.1:9' })]);
    expect(s.contacts.find((c) => c.id === mariaPub)).toBeDefined();
    await until(() => svc.getState().activity.some((a) => a.type === 'security' && a.event.kind === 'alert-channels-changed'), 'activity entry');
  });
});
