/**
 * The demo's second wallet (docs/design/multi-wallet.md): "Business" on a Trezor next to "Main" on the Ledger, so the
 * switcher, Settings > Wallets (rename, move the money, remove) and "Replace guardian" with several wallets can be
 * tried without a guardian. The wallet shown fills the screens' fields as before; the others are kept here, parked,
 * and swapped in when shown.
 */
import { LIMIT_OFF_SATS } from './rules';
import { emptySavings } from './savings-mock';
import type { ActivityItem, Contact, HardwareWallet, WalletListItem, WalletState, WalletsView } from './types';

/** What one wallet of the demo owns among the screens' fields; the rest (guardian, backup, phone) is shared. */
export type DemoWalletSlice = Pick<WalletState, 'hardware' | 'balanceSats' | 'activity' | 'dailyLimit' | 'savings' | 'receiveAddress' | 'contacts'>;

export interface DemoWallet {
  account: number;
  name: string;
  /** Undefined while it is the wallet shown (its fields are the state's then). */
  slice?: DemoWalletSlice;
}

const TREZOR: HardwareWallet = { kind: 'trezor', brand: 'Trezor', model: 'Trezor Safe 3' };

/** "Business": its own Trezor, a lower daily limit, one payment received, one alert contact. */
export function demoBusinessWallet(contact: Contact): DemoWallet {
  const activity: ActivityItem[] = [
    {
      type: 'payment',
      at: '2026-10-21T09:12:00',
      tx: {
        id: 'biz-tx-1',
        kind: 'received',
        amountSats: 850_000,
        status: 'confirmed',
        at: '2026-10-21T09:12:00',
        txid: 'b1'.repeat(32),
      },
    },
  ];
  return {
    account: 2,
    name: 'Business',
    slice: {
      hardware: TREZOR,
      balanceSats: 850_000,
      activity,
      dailyLimit: { limitSats: 50_000, usedSats: 0, cosignedCount: 0, canTurnOff: true },
      savings: emptySavings('available'),
      receiveAddress: 'tb1qbz5r8m2kd5vq3jw6hf9ztc0p7lsx0ahq4w3e2r1t9y8u7i6o5p4a3s2d',
      contacts: [contact],
    },
  };
}

export function sliceOf(s: WalletState): DemoWalletSlice {
  return { hardware: s.hardware, balanceSats: s.balanceSats, activity: s.activity, dailyLimit: s.dailyLimit, savings: s.savings, receiveAddress: s.receiveAddress, contacts: s.contacts };
}

function itemOf(w: DemoWallet, s: DemoWalletSlice, current: boolean): WalletListItem {
  const limit = s.dailyLimit.limitSats;
  return {
    account: w.account,
    name: w.name,
    device: s.hardware.model,
    current,
    balanceSats: s.balanceSats,
    ...(s.savings.status === 'active' ? { savingsSats: s.savings.balanceSats } : {}),
    dailyLimitSats: limit >= LIMIT_OFF_SATS ? 0 : limit,
    ...(limit >= LIMIT_OFF_SATS ? { limitOff: true as const } : {}),
  };
}

/** `state.wallets` from the demo's wallets and the state of the one shown. */
export function demoWalletsView(wallets: DemoWallet[], shown: number, state: WalletState): WalletsView {
  const list = wallets.map((w) => itemOf(w, w.account === shown ? sliceOf(state) : w.slice!, w.account === shown));
  let sats = 0;
  let off = false;
  for (const w of list) {
    if (w.limitOff) off = true;
    else sats += w.dailyLimitSats;
  }
  return {
    list,
    current: list.find((w) => w.current) ?? list[0]!,
    canAdd: wallets.length < 8,
    guardianUpdateNeeded: false,
    ...(list.length > 1 ? { total: { sats, off } } : {}),
  };
}
