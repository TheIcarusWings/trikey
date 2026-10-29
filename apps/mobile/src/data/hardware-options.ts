import type { HardwareKind, HardwareOption } from './types';

export type UiOs = 'ios' | 'android' | 'web';

const QR_DETAIL = 'Coldcard Q, Keystone, Passport, Jade, SeedSigner';

/** The hardware wallets the connect screen can list, as the designs word them. */
export function hardwareOptionTable(os: UiOs): Omit<HardwareOption, 'available'>[] {
  return [
    { kind: 'ledger', name: 'Ledger', detail: 'Nano X, Stax, Flex · Bluetooth' },
    { kind: 'trezor', name: 'Trezor', detail: os === 'android' ? 'USB-C, or Bluetooth on Safe 7' : 'Safe 7 · Bluetooth' },
    ...(os === 'android' ? [{ kind: 'bitbox02' as const, name: 'BitBox02', detail: 'USB-C' }] : []),
    { kind: 'qr', name: 'Scan a QR code', detail: QR_DETAIL },
  ];
}

export const SIMULATED_OPTION: Omit<HardwareOption, 'available'> = {
  kind: 'simulated',
  name: 'Simulated device',
  detail: 'Regtest only · keys kept in software',
};

/** "Ledger", "Trezor", "BitBox02", "your signing device" for the screens' sentences. */
export function hardwareBrandOf(kind: HardwareKind): string {
  switch (kind) {
    case 'ledger':
      return 'Ledger';
    case 'trezor':
      return 'Trezor';
    case 'bitbox02':
      return 'BitBox02';
    case 'simulated':
      return 'simulated device';
    case 'qr':
      return 'signing device';
  }
}
