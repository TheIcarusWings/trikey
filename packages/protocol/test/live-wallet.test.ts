/**
 * The live wallet on the wire (PROTOCOL.md, "Live wallet"): the `wallet_tx` alert and the `live_wallet` feature.
 * Older phones drop the alert (an unknown `type`, see integration.test.ts); older guardians send none.
 */
import { describe, expect, it } from 'vitest';
import { Alert, GUARDIAN_FEATURES, NotificationSchema, methods } from '../src/index.js';

const base = { type: 'wallet_tx', txid: 'ab'.repeat(32), direction: 'in', amountSats: 2_000, confirmations: 0, wallet: 'main', at: 1_900_000_000, atMs: 1_900_000_000_250 } as const;

describe('wallet_tx', () => {
  it('carries the txid, the direction, the amounts, the confirmations and which wallet', () => {
    expect(Alert.safeParse(base).success).toBe(true);
    expect(Alert.safeParse({ ...base, direction: 'out', amountSats: 3_500, feeSats: 500, confirmations: 1, message: 'Payment of 3,500 sats confirmed.' }).success).toBe(true);
    expect(Alert.safeParse({ ...base, direction: 'self', amountSats: 0, feeSats: 300, wallet: 'savings' }).success).toBe(true);
    expect(NotificationSchema.safeParse({ id: 'm'.repeat(16), method: 'alert', params: base }).success).toBe(true);
  });

  it('refuses what it cannot be', () => {
    for (const bad of [
      { ...base, direction: 'sideways' },
      { ...base, wallet: 'helper' },
      { ...base, amountSats: -1 },
      { ...base, feeSats: 1.5 },
      { ...base, confirmations: -1 },
      { ...base, txid: 'xyz' },
      { ...base, atMs: 1_900_000_100_000 }, // not the same moment as `at`
      { ...base, txid: undefined },
    ])
      expect(Alert.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('live_wallet is a feature a guardian lists', () => {
    expect(GUARDIAN_FEATURES.liveWallet).toBe('live_wallet');
    const status = { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.12', time: 1_900_000_000 };
    expect(methods['guardian.status'].result.safeParse({ ...status, features: ['live_wallet', 'savings'] }).success).toBe(true);
  });
});
