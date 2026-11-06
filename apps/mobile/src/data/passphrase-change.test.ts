/**
 * The guardian's passphrase is changed in its web page only (DESIGN.md, "Changing the passphrase"). The app: Settings >
 * Guardian says where once the guardian lists `passphrase_change`, and a change shows in Activity as a security line
 * (`passphrase_changed`). The real service against the real guardian; regtest, throwaway keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { createMockWalletService } from './mock';
import { createRealWalletService, type RealWalletService } from './real';

describe('the demo wallet', () => {
  it("says the passphrase is changed in the guardian's web page", () => {
    expect(createMockWalletService().getState().guardian.passphraseInWebPage).toBe(true);
  });
});

describe('the real service against the real guardian', { timeout: 60_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
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
    rig = await GuardianRig.start();
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
      syncJoinMs: 0,
      yieldToUi: async () => {},
      recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    });
    await svc.connectHardware('simulated');
    await svc.pairGuardian(rig.pairingUri());
    await svc.setUpRules(100_000, 7);
  }, 60_000);

  afterAll(async () => {
    await rig?.stop();
  });

  it("Settings > Guardian says where to change it, and a change in the web page shows in Activity", async () => {
    await until(() => svc.getState().guardian.passphraseInWebPage === true, 'the passphrase_change feature');
    const r = await rig.guardian.changePassphrase({ passphrase: rig.passphrase, newPassphrase: 'a new passphrase for this box' });
    expect(r).toEqual({ ok: true });
    rig.passphrase = 'a new passphrase for this box';
    await until(() => svc.getState().activity.some((a) => a.type === 'security' && a.event.kind === 'guardian-passphrase-changed'), 'the activity line');
  });
});
