/**
 * Picks and builds the wallet behind the screens at startup. The choice (Demo, Regtest simulator or Real) is kept in
 * the phone's key-value store; Settings > Developer changes it and restarts the wallet.
 *
 * - Demo is the default in development builds and on the web, so every design can be looked at without any setup.
 * - Real is the default in a release build on a phone.
 * - The simulator needs no hardware: a software "hardware wallet" with throwaway regtest keys, kept in the key-value
 *   store so it survives restarts, against a guardian the developer runs (docs/dev-regtest.md).
 */
import { Platform } from 'react-native';
import type { KeyValueStore } from '@trikey/wallet';
import { createHardwareProviders } from '@/hardware';
import { getPlatform, type TrikeyPlatform } from '@/platform';
import { pickBackupFile, shareBackupFile } from '@/platform/backup-files';
import { createMemoryKeyValueStore } from '@/platform/memory';
import { UI } from '@/lib/platform';
import { createMockWalletService } from './mock';
import type { WalletService } from './service';
import type { AppMode } from './types';

export const MODE_KEY = 'trikey.app.mode';
const SIM_DEVICE_KEY = 'trikey.sim.device.v1';

export type BootedWallet = WalletService & { close?(): Promise<void> };

/** The modes this phone offers. Real needs secure key storage, which a browser does not have. */
export function availableModes(platform: Pick<TrikeyPlatform, 'isSecure'>): AppMode[] {
  return platform.isSecure ? ['demo', 'simulator', 'real'] : ['demo', 'simulator'];
}

export function defaultMode(platform: Pick<TrikeyPlatform, 'isSecure'>): AppMode {
  if (!platform.isSecure || __DEV__) return 'demo';
  return 'real';
}

export async function loadMode(platform: TrikeyPlatform): Promise<AppMode> {
  try {
    const saved = await platform.kv.get(MODE_KEY);
    if ((saved === 'demo' || saved === 'simulator' || saved === 'real') && availableModes(platform).includes(saved)) return saved;
  } catch {
    /* an unreadable preference means the default */
  }
  return defaultMode(platform);
}

export async function saveMode(platform: TrikeyPlatform, mode: AppMode): Promise<void> {
  await platform.kv.set(MODE_KEY, mode);
}

/** Builds the wallet for `mode`. Rejects if the wallet's own storage cannot be read. */
export async function bootWallet(mode: AppMode, platform: TrikeyPlatform = getPlatform()): Promise<BootedWallet> {
  if (mode === 'demo') return createMockWalletService({ platform: UI });

  const { createRealWalletService } = await import('./real');
  const os = platform.os;

  if (mode === 'simulator') {
    const { SoftwareHardwareProvider, SoftwareHardwareSigner } = await import('@trikey/wallet/testing');
    const { newMnemonic } = await import('@trikey/wallet');
    // A browser keeps its "secure" keys in memory, so the whole simulated wallet lives in memory there too.
    const kv: KeyValueStore = os === 'web' ? createMemoryKeyValueStore() : platform.kv;
    let mnemonic = await kv.get(SIM_DEVICE_KEY);
    if (!mnemonic) {
      mnemonic = newMnemonic();
      await kv.set(SIM_DEVICE_KEY, mnemonic);
    }
    const device = new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind: 'ledger', model: 'Simulated device' });
    const provider = new SoftwareHardwareProvider(device);
    return createRealWalletService({
      mode: 'simulator',
      platform: { os, isSecure: platform.isSecure, secureKeys: platform.secureKeys, kv, cloudBackups: platform.cloudBackups, passkeys: platform.passkeys },
      hardware: () => [provider],
      network: 'regtest',
      shareBackupFile,
      pickBackupFile,
      info: () => [`Simulated device fingerprint ${device.info.fingerprint}`, 'Regtest only. Keys are throwaway.'],
    });
  }

  return createRealWalletService({
    mode: 'real',
    platform: { os, isSecure: platform.isSecure, secureKeys: platform.secureKeys, kv: platform.kv, cloudBackups: platform.cloudBackups, passkeys: platform.passkeys },
    hardware: (network, hooks) => createHardwareProviders({ network, ledger: { onInteraction: hooks.onLedgerInteraction } }),
    deviceName: Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Trikey phone',
    shareBackupFile,
    pickBackupFile,
  });
}
