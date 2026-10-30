/**
 * Picks and builds the wallet behind the screens at startup. The choice (Demo, Regtest simulator or Real) is kept in
 * the phone's key-value store; Settings > Developer changes it and restarts the wallet.
 *
 * - Demo is the default in development builds and on the web, so every design can be looked at without any setup.
 * - Real is the default in a release build on a phone.
 * - The simulator needs no hardware: a software "hardware wallet" with throwaway regtest keys, kept in the key-value
 *   store so it survives restarts. Guardian mode runs against a guardian the developer runs (docs/dev-regtest.md),
 *   Recovery Key mode against the simulated chain (`npm run rk-sim -w @trikey/mobile`).
 *
 * In the simulator and real modes both kinds of wallet are built and `routed.ts` hands the screens the one the phone
 * runs: a phone has one wallet of one kind per mode and network.
 */
import { Platform } from 'react-native';
import type { HardwareKind, HardwareProvider, KeyValueStore } from '@trikey/wallet';
import { createHardwareProviders } from '@/hardware';
import { getPlatform, type TrikeyPlatform } from '@/platform';
import { pickBackupFile, shareBackupFile } from '@/platform/backup-files';
import { runStartupRandomCheck } from '@/platform/rng-startup';
import { createMemoryKeyValueStore } from '@/platform/memory';
import { UI } from '@/lib/platform';
import { createMockWalletService } from './mock';
import type { WalletService } from './service';
import type { AppMode, NetworkName } from './types';

export const MODE_KEY = 'trikey.app.mode';
const SIM_DEVICE_KEY = 'trikey.sim.device.v1';
const SIM_DEVICE2_KEY = 'trikey.sim.device2.v1';

/** Where `npm run rk-sim -w @trikey/mobile` listens. An Android emulator reaches the computer at 10.0.2.2 instead: change it in Settings. */
export const RK_SIM_URL = process.env.EXPO_PUBLIC_RK_SIM_URL || 'http://127.0.0.1:3002';

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

/** The control endpoints `npm run rk-sim` serves next to the chain (see scripts/rk-sim.mts). */
function simControl() {
  const post = async (url: string) => {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.text();
    if (!res.ok) throw new Error(body || `The simulated chain answered ${res.status}.`);
    return body;
  };
  return {
    async mine(blocks: number, serverUrl: string) {
      const body = await post(`${serverUrl}/dev/mine?n=${Math.max(1, Math.floor(blocks))}`);
      return (JSON.parse(body) as { height: number }).height;
    },
    async fund(address: string, sats: number, serverUrl: string) {
      await post(`${serverUrl}/dev/fund?address=${encodeURIComponent(address)}&sats=${Math.floor(sats)}`);
    },
  };
}

/**
 * One set of hardware providers per network for both kinds of wallet: a phone has one Bluetooth stack, one camera and one
 * Trezor link, and only the kind in use ever asks them for anything. The Ledger's "what the device wants now" hints go to
 * both kinds' prompt sheets (the one that is not waiting ignores them).
 */
function sharedHardware() {
  const cache = new Map<NetworkName, HardwareProvider[]>();
  const hints = new Set<(interaction: string) => void>();
  return (network: NetworkName, hooks: { onLedgerInteraction: (interaction: string) => void }): HardwareProvider[] => {
    hints.add(hooks.onLedgerInteraction);
    let providers = cache.get(network);
    if (!providers) {
      providers = createHardwareProviders({ network, ledger: { onInteraction: (i) => hints.forEach((h) => h(i)) } });
      cache.set(network, providers);
    }
    return providers;
  };
}

/** Builds the wallet for `mode`. Rejects if the wallet's own storage cannot be read. */
export async function bootWallet(mode: AppMode, platform: TrikeyPlatform = getPlatform()): Promise<BootedWallet> {
  if (mode === 'demo') return createMockWalletService({ platform: UI });

  // The real and the simulated wallet make keys: test the random source and the crypto first. A failure is latched,
  // so no key is made and the screens show the error of the first attempt (platform/rng-startup.ts).
  runStartupRandomCheck();

  const [{ createRealWalletService }, { createRkWalletService }, { createRoutedWalletService, pickInitialKind }] = await Promise.all([
    import('./real'),
    import('./rk-service'),
    import('./routed'),
  ]);
  const os = platform.os;

  if (mode === 'simulator') {
    const { SoftwareHardwareProvider, SoftwareHardwareSigner } = await import('@trikey/wallet/testing');
    const { newMnemonic } = await import('@trikey/wallet');
    // A browser keeps its "secure" keys in memory, so the whole simulated wallet lives in memory there too.
    const kv: KeyValueStore = os === 'web' ? createMemoryKeyValueStore() : platform.kv;
    const device = async (key: string, model: string, kind: HardwareKind) => {
      let mnemonic = await kv.get(key);
      if (!mnemonic) {
        mnemonic = newMnemonic();
        await kv.set(key, mnemonic);
      }
      return new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind, model });
    };
    let main = await device(SIM_DEVICE_KEY, 'Simulated device', 'ledger');
    // The second simulated device is what Recovery Key mode reads when the Recovery Key is "a second hardware wallet".
    const second = await device(SIM_DEVICE2_KEY, 'Second simulated device', 'coldcard');
    class SimProvider extends SoftwareHardwareProvider {
      async connect(opts?: { kind?: HardwareKind }) {
        if (opts?.kind === 'coldcard') {
          this.connects++;
          return second;
        }
        return super.connect();
      }
    }
    const provider = new SimProvider(main);
    const simPlatform = { os, isSecure: platform.isSecure, secureKeys: platform.secureKeys, kv };
    const devTools = {
      // "Lost my hardware wallet" needs a second device: the next one the app connects is a new one.
      useNewSimulatedDevice() {
        const next = newMnemonic();
        void kv.set(SIM_DEVICE_KEY, next);
        main = new SoftwareHardwareSigner({ mnemonic: next, network: 'regtest', kind: 'ledger', model: 'Simulated device' });
        provider.device = main;
        return main.info.fingerprint;
      },
    };
    const info = () => [`Simulated device fingerprint ${main.info.fingerprint}`, 'Regtest only. Keys are throwaway.'];
    const guardian = await createRealWalletService({
      mode: 'simulator',
      platform: { ...simPlatform, cloudBackups: platform.cloudBackups, passkeys: platform.passkeys },
      hardware: () => [provider],
      network: 'regtest',
      shareBackupFile,
      pickBackupFile,
      info,
      devTools,
    });
    const recoveryKey = await createRkWalletService({
      mode: 'simulator',
      platform: simPlatform,
      hardware: () => [provider],
      network: 'regtest',
      defaultServer: () => RK_SIM_URL,
      secondDeviceKind: 'coldcard',
      sim: simControl(),
      info,
      devTools,
    });
    const initial = await pickInitialKind({ mode, kv, guardian, recoveryKey });
    return createRoutedWalletService({ mode, kv, guardian, recoveryKey, initial });
  }

  const hardware = sharedHardware();
  const deviceName = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Trikey phone';
  const guardian = await createRealWalletService({
    mode: 'real',
    platform: { os, isSecure: platform.isSecure, secureKeys: platform.secureKeys, kv: platform.kv, cloudBackups: platform.cloudBackups, passkeys: platform.passkeys },
    hardware,
    deviceName,
    shareBackupFile,
    pickBackupFile,
  });
  const recoveryKey = await createRkWalletService({
    mode: 'real',
    platform: { os, isSecure: platform.isSecure, secureKeys: platform.secureKeys, kv: platform.kv },
    hardware,
    // The refill scheduler also runs from a background task once a wallet exists (see ./rk-background).
    onWalletChange: (has) => void import('./rk-background').then((m) => m.syncBackgroundTask(has)).catch(() => undefined),
  });
  const initial = await pickInitialKind({ mode, kv: platform.kv, guardian, recoveryKey });
  return createRoutedWalletService({ mode, kv: platform.kv, guardian, recoveryKey, initial });
}
