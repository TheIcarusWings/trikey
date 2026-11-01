/**
 * Extra alert channels as the phone sees them (docs/design/notifications.md), against the real guardian in-process:
 * the owner sets them up in the guardian's web UI (here: the guardian's own entry point for it); the phone reads them,
 * masked and read-only, from `guardian.status`, and reads them again when the guardian says they changed
 * (`notifications_changed`). Nothing on the phone can change them. Regtest, throwaway keys, example.com addresses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import type { Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, waitFor } from './helpers.js';

const contactPub = getPublicKey(new Uint8Array(32).fill(44));
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
let rig: GuardianRig;
let w: TrikeyWallet;
const events: WalletEvent[] = [];

// Nothing listens there: deliveries fail at once (ECONNREFUSED) and are retried later; this test is about the phone.
const DEAD_HOOK = 'http://127.0.0.1:9/hook';

beforeAll(async () => {
  rig = await GuardianRig.start({ notifyTestServers: true });
  const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'Notifications phone' });
  w.on((e) => events.push(e));
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

describe('extra alert channels on the phone', { timeout: 60_000 }, () => {
  it('none yet: the guardian reports the feature and an empty list', async () => {
    await w.refreshStatus();
    expect(w.notificationsSupported).toBe(true);
    expect(w.notificationChannels).toEqual([]);
  });

  it('set up in the web UI: the phone hears it changed and shows them masked, without topics or URLs', async () => {
    const r = await rig.guardian.updateNotifications({
      guardianName: 'Home vault',
      smtp: null,
      destinations: [
        { audience: 'owner', kind: 'webhook', webhook: { url: `${DEAD_HOOK}/secret-path-id` } },
        { audience: 'contact', kind: 'ntfy', contact: contactPub, ntfy: { server: 'http://127.0.0.1:9', topic: 'maria-secret-topic-x7f3' } },
      ],
    });
    expect(r).toMatchObject({ ok: true, changed: true });
    await waitFor(() => events.some((e) => e.type === 'alert' && e.alert.type === 'notifications_changed'), 'notifications_changed alert');
    await waitFor(() => w.notificationChannels.length === 2, 'status read again');
    // `failing`: their announcement could not be delivered (nothing listens there); the phone may say so.
    expect(w.notificationChannels.map(({ failing: _f, ...c }) => c)).toEqual([
      { kind: 'webhook', audience: 'owner', hint: '127.0.0.1:9' },
      { kind: 'ntfy', audience: 'contact', contact: contactPub, hint: '127.0.0.1:9' },
    ]);
    expect(JSON.stringify(w.notificationChannels)).not.toMatch(/secret-path-id|maria-secret-topic/);
  });

  it('a guardian without the feature: nothing to show', async () => {
    rig.guardian.features = ['limit_off', 'contact_lock', 'savings'];
    try {
      await rig.guardian.updateNotifications({ guardianName: 'Home vault', smtp: null, destinations: [] });
      await w.refreshStatus();
      expect(w.notificationsSupported).toBe(false);
      expect(w.notificationChannels).toEqual([]);
    } finally {
      rig.guardian.features = ['limit_off', 'contact_lock', 'savings', 'notifications'];
    }
  });
});
