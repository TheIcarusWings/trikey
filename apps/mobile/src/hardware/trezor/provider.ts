/**
 * Web build: the Trezor deep-link flow needs the phone app, so the provider is never available.
 * The native version is `provider.native.ts`.
 */
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { HardwareError } from '../errors';
import type { HardwareProviderOptions } from '../options';

export const DEFAULT_TREZOR_CALLBACK_PATH = 'trezor-callback';

export class TrezorProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['trezor'];

  constructor(_options: HardwareProviderOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async connect(): Promise<HardwareSigner> {
    throw new HardwareError('unavailable', 'Trezor needs the Trikey phone app and Trezor Suite Lite; it is not available in the browser.', { kind: 'trezor' });
  }
}
