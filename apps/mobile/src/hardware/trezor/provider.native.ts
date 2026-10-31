/**
 * Trezor through Trezor Suite Lite. `@trezor/connect-mobile` does not talk to the device: every call opens a deep link
 * into Suite Lite, which does the USB/Bluetooth work and the user confirmations, then opens our callback URL with the
 * result. We forward that URL to `TrezorConnect.handleDeeplink`.
 *
 * Metro picks this file on native; the web build gets `provider.ts`.
 */
import TrezorConnect from '@trezor/connect-mobile';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { normalizeXpub } from '../common/xpub';
import { HardwareError, throwIfAborted } from '../errors';
import { TREZOR_MANIFEST_DEFAULTS, type HardwareProviderOptions } from '../options';
import { coinForNetwork } from './convert';
import { TREZOR_CANCEL_REASONS, mapTrezorError, trezorFailure } from './errors';
import { TrezorSigner } from './signer';
import type { TrezorConnectLike } from './types';

export const DEFAULT_TREZOR_CALLBACK_PATH = 'trezor-callback';

export class TrezorProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['trezor'];
  private initialised?: Promise<void>;
  private subscription?: { remove(): void };

  constructor(private readonly options: HardwareProviderOptions = {}) {}

  private callbackUrl(): string {
    return Linking.createURL(this.options.trezor?.callbackPath ?? DEFAULT_TREZOR_CALLBACK_PATH);
  }

  private ensureInit(): Promise<void> {
    this.initialised ??= (async () => {
      const callback = this.callbackUrl();
      const manifest = { ...TREZOR_MANIFEST_DEFAULTS, ...this.options.trezor?.manifest };
      this.subscription = Linking.addEventListener('url', ({ url }) => {
        // Only our callback goes to Connect; other deep links are the router's business.
        // connect-mobile throws (after failing the call in flight) on a callback whose result is not JSON; an exception
        // in this listener would take the app down.
        if (url.startsWith(callback.split('?')[0]!)) {
          try {
            TrezorConnect.handleDeeplink(url);
          } catch {
            // The call has already been failed with "Error parsing deeplink params."
          }
        }
      });
      await TrezorConnect.init({
        manifest,
        deeplinkOpen: (url: string) => {
          void Linking.openURL(url);
        },
        deeplinkCallbackUrl: callback,
      });
    })().catch((e) => {
      this.initialised = undefined;
      this.subscription?.remove();
      throw mapTrezorError(e);
    });
    return this.initialised;
  }

  /** Suite Lite's presence cannot be probed without extra manifest entries; the first call shows the store page if it is missing. */
  async isAvailable(): Promise<boolean> {
    return Platform.OS === 'ios' || Platform.OS === 'android';
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal } = {}): Promise<HardwareSigner> {
    if (opts.kind && opts.kind !== 'trezor') throw new HardwareError('invalid-request', `The Trezor provider cannot connect a ${opts.kind}.`, { kind: 'trezor' });
    throwIfAborted(opts.signal, 'trezor');
    const network = this.options.network ?? 'bitcoin';
    await this.ensureInit();
    const connect = TrezorConnect as unknown as TrezorConnectLike;
    const onAbort = () => connect.cancel?.(TREZOR_CANCEL_REASONS.aborted);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // One round trip gets both the account key and the master fingerprint (`rootFingerprint`).
      const path = `m/48'/${network === 'bitcoin' ? 0 : 1}'/0'/2'`;
      const res = await connect.getPublicKey({ path, coin: coinForNetwork(network), showOnTrezor: false });
      if (res.success !== true) throw mapTrezorError(trezorFailure(res));
      if (res.payload.rootFingerprint === undefined)
        throw new HardwareError('device-error', 'This Trezor firmware does not report its master fingerprint. Update it in Trezor Suite.', { kind: 'trezor' });
      const fingerprint = (res.payload.rootFingerprint >>> 0).toString(16).padStart(8, '0');
      // The account key we just fetched is handed over, so `getXpub` for it needs no second trip to Suite Lite.
      return new TrezorSigner({ kind: 'trezor', fingerprint }, connect, { network, knownXpubs: { [path]: normalizeXpub(res.payload.xpub) } });
    } catch (e) {
      throw mapTrezorError(e);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
