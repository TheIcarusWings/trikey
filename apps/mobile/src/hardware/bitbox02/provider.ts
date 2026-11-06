/**
 * A BitBox02 or BitBox02 Nova: kind `bitbox02`. Connecting finds one (plugged into the phone's USB-C port on Android, or a
 * Nova over Bluetooth on Android and iOS: `link.native.ts`), reads its version, unlocks it (the owner types the password
 * on the BitBox02), opens the encrypted channel (the first time, the pairing code on both screens, confirmed on the
 * BitBox02: session.ts), and reads its master fingerprint.
 *
 * Firmware 9.27.1 or later is required: earlier ones refuse to sign a text with Trikey's key under `m/48'`.
 */
import { BITBOX02_MIN_FIRMWARE, type HardwareKind, type HardwareProvider, type HardwareSigner, type KnownHardware, type QrModel } from '@trikey/wallet';
import type { NetworkName } from '@trikey/core';
import { HardwareError, throwIfAborted } from '../errors';
import type { BitBoxBridge } from './bridge';
import { BitBoxHww, versionAtLeast, type HwwOptions } from './hww';
import type { BitBoxDevice, BitBoxLink } from './link';
import { Requests } from './proto';
import { memoryPairingStore, openSession, type BitBoxPairingStore } from './session';
import { BitBoxSigner } from './signer';

const KIND: HardwareKind = 'bitbox02';
const KINDS: readonly HardwareKind[] = [KIND];
const DEFAULT_SCAN_TIMEOUT_MS = 60_000;

export interface BitBox02ProviderOptions {
  network?: NetworkName;
  bridge: BitBoxBridge;
  /** Where the phone keeps its pairing with BitBox02s (its Noise key and theirs). Default: in memory. */
  pairing?: BitBoxPairingStore;
  scanTimeoutMs?: number;
  /** For tests: no waiting between polls. */
  hww?: HwwOptions;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class BitBox02Provider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = KINDS;
  private readonly pairing: BitBoxPairingStore;

  constructor(private readonly options: BitBox02ProviderOptions) {
    this.pairing = options.pairing ?? memoryPairingStore();
  }

  private async usableLinks(): Promise<BitBoxLink[]> {
    const out: BitBoxLink[] = [];
    for (const link of this.options.bridge.links) if (await link.isSupported().catch(() => false)) out.push(link);
    return out;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.usableLinks()).length > 0;
  }

  /** Why the list shows the BitBox02 as unavailable, in words for the owner; undefined when it is available. */
  async unavailableReason(): Promise<string | undefined> {
    if (await this.isAvailable()) return undefined;
    return this.options.bridge.links.find((l) => l.unavailableReason)?.unavailableReason ?? 'A BitBox02 needs the Trikey phone app.';
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal; qrModel?: QrModel; known?: KnownHardware } = {}): Promise<HardwareSigner> {
    if (opts.kind && opts.kind !== KIND) throw new HardwareError('invalid-request', `The BitBox02 provider cannot connect a ${opts.kind}.`, { kind: KIND });
    throwIfAborted(opts.signal, KIND);
    const { bridge } = this.options;
    const network = this.options.network ?? 'bitcoin';
    const supported = await this.usableLinks();
    if (supported.length === 0) throw new HardwareError('unavailable', (await this.unavailableReason()) ?? 'A BitBox02 needs the Trikey phone app.', { kind: KIND });
    // Each transport asks for what it needs (Bluetooth: "Nearby devices"); one that cannot go on is skipped, not fatal.
    const links: BitBoxLink[] = [];
    const problems: string[] = [];
    for (const link of supported) {
      const problem = await link.prepare().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (problem) problems.push(problem);
      else links.push(link);
    }
    if (links.length === 0) throw new HardwareError('unavailable', problems[0] ?? 'This phone cannot reach a BitBox02.', { kind: KIND });

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cancel = () => ac.abort();
    let hww: BitBoxHww | undefined;
    try {
      const usb = links.some((l) => l.transport === 'usb');
      const ble = links.some((l) => l.transport === 'ble');
      bridge.status(
        {
          title: 'Looking for your BitBox02',
          instructions: 'Trikey talks to your BitBox02 directly.',
          steps: [
            ...(usb ? ['Plug the BitBox02 into this phone’s USB-C port (a BitBox02 Nova too). If Android asks whether Trikey may use it, allow it.'] : []),
            ...(ble ? ['A BitBox02 Nova can connect over Bluetooth: turn it on and keep it close to this phone.'] : []),
          ],
          ...(problems.length ? { notes: problems } : {}),
        },
        cancel,
      );
      const { link, device } = await this.find(links, ac.signal);

      bridge.status(
        {
          title: `Connecting to ${device.name}`,
          instructions: device.transport === 'ble' ? 'The first time, this phone and the BitBox02 Nova pair over Bluetooth.' : 'Keep the BitBox02 plugged in.',
          ...(device.transport === 'ble'
            ? { notes: ['If both show a six-digit code, check that it is the same on the BitBox02 and on this phone, then confirm on both.'] }
            : {}),
        },
        cancel,
      );
      const conn = await link.connect(device, ac.signal);
      hww = new BitBoxHww(conn, this.options.hww);
      throwIfAborted(ac.signal, KIND);

      const info = await hww.info(ac.signal);
      if (!versionAtLeast(info.version, BITBOX02_MIN_FIRMWARE))
        throw new HardwareError(
          'not-supported',
          `This BitBox02's firmware (${info.version}) is too old for Trikey: it cannot sign Trikey's texts. Update it to ${BITBOX02_MIN_FIRMWARE.join('.')} or later with the BitBoxApp, then try again.`,
          { kind: KIND },
        );
      if (info.initialized === false)
        throw new HardwareError('not-supported', 'This BitBox02 has no wallet yet. Set it up with the BitBoxApp first (create or restore its wallet and back it up), then connect it again.', { kind: KIND });
      if (versionAtLeast(info.version, [9, 28, 0])) await hww.resetSession(ac.signal);
      const model = info.platform === 'bitbox02-nova' ? 'BitBox02 Nova' : 'BitBox02';

      const session = await openSession(hww, this.pairing, {
        signal: ac.signal,
        onUnlock: () => {
          if (!info.unlocked)
            bridge.status({ title: `Unlock your ${model}`, instructions: `Enter your password on the ${model}. Trikey never sees it.` }, cancel);
        },
        onPairingCode: (code) =>
          bridge.status(
            {
              title: 'Check the pairing code',
              instructions: `Your ${model} shows a pairing code. If it is exactly this one, confirm it on the ${model}.`,
              code,
              notes: [`If the codes are different, reject it on the ${model}: something between this phone and the ${model} is changing the connection.`, 'This is asked once for this phone and this BitBox02.'],
            },
            cancel,
          ),
      });
      const r = await session.query(Requests.fingerprint(), ac.signal);
      if (r.type !== 'fingerprint' || r.fingerprint.length !== 4) throw new HardwareError('invalid-response', 'The BitBox02 did not give its fingerprint.', { kind: KIND });
      bridge.hide();
      const signer = new BitBoxSigner({ kind: KIND, model, fingerprint: hex(r.fingerprint) }, session, { network });
      hww = undefined;
      return signer;
    } catch (e) {
      bridge.hide();
      if (ac.signal.aborted && !(e instanceof HardwareError && e.code !== 'cancelled')) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (hww) await hww.close().catch(() => undefined);
    }
  }

  /** Looks on every transport at once; the first BitBox02 found is used. */
  private async find(links: BitBoxLink[], signal: AbortSignal): Promise<{ link: BitBoxLink; device: BitBoxDevice }> {
    const scan = new AbortController();
    const onAbort = () => scan.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      scan.abort();
    }, this.options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);
    try {
      return await new Promise((resolve, reject) => {
        let failed = 0;
        let lastError: unknown;
        for (const link of links) {
          link.scan(() => true, scan.signal).then(
            (device) => {
              scan.abort();
              resolve({ link, device });
            },
            (e: unknown) => {
              lastError = e;
              if (++failed === links.length) reject(lastError);
            },
          );
        }
      });
    } catch (e) {
      if (timedOut) throw new HardwareError('timeout', 'No BitBox02 found. Plug it into the phone (or, for a Nova, turn it on next to the phone) and try again.', { kind: KIND });
      if (signal.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
