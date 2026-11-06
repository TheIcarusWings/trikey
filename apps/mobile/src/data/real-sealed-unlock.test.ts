/**
 * Sealed unlock in the app (`WalletService.unlockGuardian`; PROTOCOL.md, "Sealed unlock"), from the real wallet service
 * against the real guardian in-process (regtest, throwaway keys): the passphrase typed in the app reaches a guardian
 * with `sealed_unlock` sealed (the relays' wraps, opened with the guardian's nostr key, do not show it), works after a
 * restart, and the new refusals read in words.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { GUARDIAN_FEATURES, openGiftWrap } from '@trikey/protocol';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { createRealWalletService, type RealWalletService } from './real';
import { refusalToError } from './real-errors';

const key1 = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Simulated device' });

class SimDevices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];
  async isAvailable() {
    return true;
  }
  async connect(): Promise<HardwareSigner> {
    return key1;
  }
}

const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
let rig: GuardianRig;
let svc: RealWalletService;

/** The guardian's wraps on the relays, opened with its nostr key (what its disk and a relay's archive would give). */
function archive(): string {
  const out: string[] = [];
  for (const relay of rig.relays)
    for (const ev of relay.events.values()) {
      try {
        out.push(JSON.stringify(openGiftWrap(ev, { recipientSecretKey: rig.guardian.identity!.secretKey, conversationKeys: null })));
      } catch {
        // not to the guardian
      }
    }
  return out.join('\n');
}

beforeAll(async () => {
  rig = await GuardianRig.start({ passphrase: 'app test passphrase 42' });
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SimDevices()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

describe('sealed unlock, in the app', { timeout: 120_000 }, () => {
  it('after a restart, the passphrase typed in the app unlocks the guardian, sealed', async () => {
    expect(rig.guardian.features).toContain(GUARDIAN_FEATURES.sealedUnlock);
    await rig.restart();
    await svc.sync();
    await svc.idle();
    expect(svc.getState().guardian.status).toBe('locked');
    await svc.unlockGuardian(rig.passphrase);
    expect(rig.guardian.locked).toBe(false);
    expect(svc.getState().guardian.status).toBe('online');
    expect(rig.guardian.service.get().activity.at(-1)).toEqual(expect.objectContaining({ type: 'unlocked', via: 'phone' }));
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');
    expect(archive()).toContain('guardian.unlock');
    expect(archive()).not.toContain(rig.passphrase);
  });

  it('a wrong passphrase is refused in words, and the right one works next (the guardian replaced its key meanwhile)', async () => {
    await svc.lockGuardian();
    await expect(svc.unlockGuardian('not it')).rejects.toThrow(/passphrase didn't work/);
    await svc.unlockGuardian(rig.passphrase);
    expect(rig.guardian.locked).toBe(false);
    expect(archive()).not.toContain('not it"');
  });

  it('says why in words for the sealed refusals', () => {
    expect(refusalToError({ kind: 'unlock_failed', reason: 'unlock_key_stale', message: 'x' }).message).toMatch(/restarted or locked again.*Try again/);
    expect(refusalToError({ kind: 'unlock_failed', reason: 'sealed_unlock_invalid', message: 'x', retryAfterSeconds: 4 }).message).toMatch(/couldn't read the unlock.*4 seconds/);
  });
});
