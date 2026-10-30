import { describe, expect, it } from 'vitest';
import { WalletServiceError } from '../data/errors';
import { HardwareError } from '../hardware/errors';
import { hardwareFix } from './hardware-fix';

const ledger = (code: ConstructorParameters<typeof HardwareError>[0], tag?: string) =>
  new HardwareError(code, 'x', { kind: 'ledger', detail: tag ? { _tag: tag } : undefined });

describe('the next step for a hardware wallet error', () => {
  it('sends a refused Bluetooth permission to the settings', () => {
    expect(hardwareFix(new WalletServiceError('hardware', 'x', { cause: ledger('unavailable', 'BlePermissionsNotGranted') }))).toBe('permission');
  });

  it('offers to turn Bluetooth on when it is off', () => {
    expect(hardwareFix(new WalletServiceError('hardware', 'x', { cause: ledger('unavailable', 'BlePoweredOff') }))).toBe('bluetooth-off');
  });

  it('finds the device error under a wallet error', () => {
    const wallet = new Error('wallet', { cause: ledger('unavailable', 'BlePoweredOff') });
    expect(hardwareFix(new WalletServiceError('hardware', 'x', { cause: wallet }))).toBe('bluetooth-off');
  });

  it('offers nothing for what settings cannot fix', () => {
    expect(hardwareFix(ledger('unavailable', 'BleNotSupported'))).toBeNull();
    expect(hardwareFix(ledger('device-locked'))).toBeNull();
    expect(hardwareFix(new WalletServiceError('over_limit', 'x'))).toBeNull();
    expect(hardwareFix(null)).toBeNull();
  });
});
