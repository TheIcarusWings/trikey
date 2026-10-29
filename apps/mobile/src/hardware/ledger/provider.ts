/**
 * Web build: no Bluetooth Low Energy transport, so the Ledger provider is never available.
 * The native version, which carries the Device Management Kit imports, is `provider.native.ts`.
 */
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { HardwareError } from '../errors';
import type { HardwareProviderOptions } from '../options';

export class LedgerBleProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];

  constructor(_options: HardwareProviderOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async connect(): Promise<HardwareSigner> {
    throw new HardwareError('unavailable', 'Ledger over Bluetooth needs the Trikey phone app; it is not available in the browser.', { kind: 'ledger' });
  }
}
