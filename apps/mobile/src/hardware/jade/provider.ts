/**
 * A Blockstream Jade or Jade Plus over Bluetooth: kind `jade-ble`. Connecting finds a Jade (its service
 * 6e400001-b5a3-f393-e0a9-e50e24dcca9e, `link.native.ts`), opens the link (the first time, Android and iOS pair it with
 * the Jade: the same six digits on both screens), unlocks it with the owner's PIN through the PIN-server relay
 * (`pin-server.ts`), and reads its master fingerprint. The PIN-server notice is shown once before the first unlock.
 *
 * Available where the phone has Bluetooth LE (iOS and Android builds; not the web build).
 */
import type { HardwareKind, HardwareProvider, HardwareSigner, KnownHardware, QrModel } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError, throwIfAborted } from '../errors';
import { memoryNoticeStore, type JadeBleBridge, type JadeNoticeStore } from './bridge';
import type { CborValue } from './cbor';
import type { JadeBleDevice } from './link';
import { unlockJade, type FetchLike, type UnlockEvent } from './pin-server';
import { JadeRpc } from './rpc';
import { JadeSigner, fingerprintOfRoot, jadeNetwork } from './signer';

const KIND: HardwareKind = 'jade-ble';
const KINDS: readonly HardwareKind[] = [KIND];
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

/** Jade firmware 0.1.47 made `sign_psbt` take the network (CHANGELOG.md); Trikey needs that and `get_extended_data` (0.1.46). */
export const MIN_JADE_VERSION = [0, 1, 47] as const;

export interface JadeBleProviderOptions {
  network?: NetworkName;
  bridge: JadeBleBridge;
  /** For the PIN-server requests. Default: the platform's `fetch`. */
  fetch?: FetchLike;
  scanTimeoutMs?: number;
  /** Seconds since 1970, for the Jade's clock. Default: now. */
  now?: () => number;
  /** Where the app remembers that the owner read the PIN-server notice. Default: in memory (shown again after a restart). */
  notices?: JadeNoticeStore;
}

/** The sentence shown once before the first unlock over Bluetooth (DESIGN.md, "Jade over Bluetooth"). */
export const PIN_SERVER_NOTICE =
  'To unlock your Jade over Bluetooth, this phone passes an encrypted PIN check between the Jade and the PIN server the Jade names (Blockstream’s, unless you set your own): that server sees this phone’s IP address and when your Jade unlocks, never your PIN or your keys. In QR mode, Trikey contacts no PIN server.';

export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts) return false;
  const v = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
}

function isMap(v: unknown): v is Record<string, CborValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

const FIND_STEPS = [
  'Turn on your Jade and keep it close to this phone.',
  'When the Jade asks how to connect, choose Bluetooth. (Bluetooth must be on in the Jade’s settings, under Device › Settings › Bluetooth.)',
];

export class JadeBleProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = KINDS;

  private readonly notices: JadeNoticeStore;

  constructor(private readonly options: JadeBleProviderOptions) {
    this.notices = options.notices ?? memoryNoticeStore();
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.options.bridge.link.isSupported();
    } catch {
      return false;
    }
  }

  /** Why the list shows the Jade as unavailable, in words for the owner; undefined when it is available. */
  async unavailableReason(): Promise<string | undefined> {
    if (await this.isAvailable()) return undefined;
    return this.options.bridge.link.unavailableReason ?? 'This phone has no Bluetooth.';
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal; qrModel?: QrModel; known?: KnownHardware } = {}): Promise<HardwareSigner> {
    if (opts.kind && opts.kind !== KIND) throw new HardwareError('invalid-request', `The Jade provider cannot connect a ${opts.kind}.`, { kind: KIND });
    throwIfAborted(opts.signal, KIND);
    const { bridge } = this.options;
    const link = bridge.link;
    const network = this.options.network ?? 'bitcoin';
    if (!(await link.isSupported())) throw new HardwareError('unavailable', link.unavailableReason ?? 'This phone has no Bluetooth.', { kind: KIND });
    const problem = await link.prepare();
    if (problem) throw new HardwareError('unavailable', problem, { kind: KIND });

    // Cancel on the sheet, or the caller's signal, stops whatever step runs.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cancel = () => ac.abort();
    let rpc: JadeRpc | undefined;
    try {
      bridge.status({ title: 'Looking for your Jade', instructions: 'Trikey talks to your Jade over Bluetooth.', steps: FIND_STEPS }, cancel);
      const device = await this.find(ac.signal);

      bridge.status(
        {
          title: `Connecting to ${device.name}`,
          instructions: 'The first time, this phone and the Jade pair.',
          notes: [
            'If both show a six-digit number, check that it is the same on the Jade and on this phone, then confirm on both.',
            'If the phone was paired with this Jade before and it does not connect, remove the Jade in this phone’s Bluetooth settings, and on the Jade use Device › Settings › Bluetooth › Reset Pairings, then try again.',
          ],
        },
        cancel,
      );
      const conn = await link.connect(device, ac.signal);
      rpc = new JadeRpc(conn);
      throwIfAborted(ac.signal, KIND);

      const info = await rpc.call('get_version_info', undefined, { signal: ac.signal });
      const version = isMap(info) && typeof info.JADE_VERSION === 'string' ? info.JADE_VERSION : '';
      if (!versionAtLeast(version, MIN_JADE_VERSION))
        throw new HardwareError('not-supported', `This Jade's firmware (${version || 'unknown version'}) is too old for Trikey. Update it to ${MIN_JADE_VERSION.join('.')} or later (with Blockstream's app), then try again.`, { kind: KIND });
      const state = isMap(info) && typeof info.JADE_STATE === 'string' ? info.JADE_STATE : '';
      const iface = isMap(info) && typeof info.JADE_INTERFACE === 'string' ? info.JADE_INTERFACE : '';
      const board = isMap(info) && typeof info.BOARD_TYPE === 'string' ? info.BOARD_TYPE : '';
      const ready = (state === 'READY' && iface === 'BLE') || (state === 'TEMP' && iface === 'BLE');

      if (!ready) {
        // Once, before the first unlock over Bluetooth: the PIN server.
        if (!(await this.notices.seen().catch(() => false))) {
          const ok = await bridge.confirm({
            title: 'Your Jade’s PIN server',
            instructions: PIN_SERVER_NOTICE,
            continueLabel: 'Continue',
            cancelLabel: 'Cancel',
          });
          if (!ok) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
          await this.notices.markSeen().catch(() => undefined);
        }
        const unlocked = await unlockJade(rpc, {
          network: jadeNetwork(network),
          fetch: this.options.fetch ?? (globalThis.fetch as unknown as FetchLike),
          signal: ac.signal,
          ...(this.options.now ? { epoch: this.options.now() } : {}),
          onEvent: (e) => this.showUnlock(e, state, cancel),
        });
        if (!unlocked)
          throw new HardwareError('device-locked', 'Wrong PIN: the Jade stayed locked. Try again carefully: after three wrong PINs in a row the Jade erases its keys, and you would restore it from its recovery phrase.', { kind: KIND });
      }

      const root = await rpc.call('get_xpub', { network: jadeNetwork(network), path: [] }, { signal: ac.signal });
      if (typeof root !== 'string') throw new HardwareError('invalid-response', 'The Jade gave a key Trikey cannot read.', { kind: KIND });
      const fingerprint = fingerprintOfRoot(root);
      bridge.hide();
      // BOARD_TYPE (main/process/ota_defines.h): JADE_V2 is the Jade Plus, JADE_V2C the Jade Core, JADE and JADE_V1.1 the first Jade.
      const model = board === 'JADE_V2' ? 'Jade Plus' : board === 'JADE_V2C' ? 'Jade Core' : 'Jade';
      const signer = new JadeSigner({ kind: KIND, model, fingerprint }, rpc, { network });
      rpc = undefined;
      return signer;
    } catch (e) {
      bridge.hide();
      if (ac.signal.aborted && !(e instanceof HardwareError && e.code !== 'cancelled')) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (rpc) await rpc.close().catch(() => undefined);
    }
  }

  private showUnlock(e: UnlockEvent, state: string, cancel: () => void): void {
    const { bridge } = this.options;
    if (e.type === 'enter-pin')
      bridge.status(
        state === 'UNINIT' || state === 'UNSAVED'
          ? { title: 'Set up your Jade', instructions: 'Follow the steps on the Jade to make or restore its wallet, then choose a PIN.', notes: [PIN_SERVER_NOTICE] }
          : { title: 'Enter your PIN on the Jade', instructions: 'Type your PIN on the Jade. Trikey never sees it.', notes: ['After three wrong PINs in a row the Jade erases its keys.'] },
        cancel,
      );
    else if (e.type === 'pin-server')
      bridge.status({ title: 'Checking your PIN', instructions: `Your Jade is checking its PIN with its PIN server (${e.host}), through this phone.` }, cancel);
    else
      bridge.status(
        {
          title: 'The PIN server could not be reached',
          instructions: 'The Jade asks whether to try again. Choose Yes on the Jade once the problem below is fixed, or No to stop.',
          hint: e.problem,
        },
        cancel,
      );
  }

  /** Scans for a Jade until one is found, the signal aborts, or the scan times out. The first Jade found is used. */
  private async find(signal: AbortSignal): Promise<JadeBleDevice> {
    const scan = new AbortController();
    const onAbort = () => scan.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      scan.abort();
    }, this.options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);
    try {
      return await this.options.bridge.link.scan((d) => /^Jade/i.test(d.name), scan.signal);
    } catch (e) {
      if (timedOut)
        throw new HardwareError('timeout', 'No Jade found. Turn it on, choose Bluetooth on it, keep it close to the phone, and try again.', { kind: KIND });
      if (signal.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
