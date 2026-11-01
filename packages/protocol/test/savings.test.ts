/**
 * The optional Savings wallet on the wire (PROTOCOL.md, "Savings"; docs/design/savings-and-limit-off.md, option K): the
 * `savings` feature, the watch-only methods, `wallet.sync` reading it, `guardian.status.savingsWalletId` and the
 * `savings_moved` alert. None of it touches the policy: its members, its hash and every approval text are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Alert, GUARDIAN_FEATURES, approvalMessage, canonicalJson, methods, normalizePolicy, type Policy } from '../src/index.js';
import { CONTACT_A, WALLET_ID } from './helpers.js';

const status = { state: 'unlocked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.8', time: 1_900_000_000 };
const SAVINGS_ID = 'aa11bb22cc33dd44';
const TXID = 'ef'.repeat(32);

describe('savings: the feature and the methods', () => {
  it('is announced as `savings`', () => {
    expect(GUARDIAN_FEATURES.savings).toBe('savings');
  });

  it('savings.register takes a descriptor and nothing else; it answers the wallet id and since when', () => {
    const p = methods['savings.register'].params;
    expect(p.safeParse({ descriptor: 'wsh(sortedmulti(2,A,B,C))' }).success).toBe(true);
    expect(p.safeParse({}).success).toBe(false);
    expect(p.safeParse({ descriptor: 'wsh(sortedmulti(2,A,B,C))', trusted: true }).success).toBe(false);
    expect(p.safeParse({ descriptor: 'x'.repeat(2001) }).success).toBe(false);
    const r = methods['savings.register'].result;
    expect(r.safeParse({ walletId: SAVINGS_ID, since: 1_900_000_000 }).success).toBe(true);
    expect(r.safeParse({ walletId: 'nope', since: 1_900_000_000 }).success).toBe(false);
  });

  it('savings.unregister and savings.get take no params', () => {
    expect(methods['savings.unregister'].params.safeParse({}).success).toBe(true);
    expect(methods['savings.unregister'].params.safeParse({ walletId: SAVINGS_ID }).success).toBe(false);
    expect(methods['savings.unregister'].result.safeParse({ unregistered: true, walletId: SAVINGS_ID }).success).toBe(true);
    expect(methods['savings.unregister'].result.safeParse({ unregistered: false }).success).toBe(true);
    expect(methods['savings.get'].params.safeParse({}).success).toBe(true);
    const r = methods['savings.get'].result;
    expect(r.safeParse({ savings: null }).success).toBe(true);
    expect(r.safeParse({ savings: { walletId: SAVINGS_ID, descriptor: 'wsh(sortedmulti(2,A,B,C))', since: 1_900_000_000 } }).success).toBe(true);
    expect(r.safeParse({}).success).toBe(false);
  });

  it('wallet.sync reads the Savings wallet with `wallet: "savings"` (or its id)', () => {
    const p = methods['wallet.sync'].params;
    expect(p.safeParse({ wallet: 'savings' }).success).toBe(true);
    expect(p.safeParse({ wallet: SAVINGS_ID }).success).toBe(true);
    expect(p.safeParse({ wallet: 'vault' }).success).toBe(false);
  });

  it('guardian.status may name the Savings wallet; older answers without it still parse', () => {
    const r = methods['guardian.status'].result;
    expect(r.safeParse({ ...status, features: ['savings'], savingsWalletId: SAVINGS_ID }).success).toBe(true);
    expect(r.safeParse(status).success).toBe(true);
    expect(r.safeParse({ ...status, savingsWalletId: 'xyz' }).success).toBe(false);
  });
});

describe('savings: the alert', () => {
  it('savings_moved carries the wallet, the transaction and what left Savings', () => {
    const a = { type: 'savings_moved', walletId: SAVINGS_ID, txid: TXID, amountSats: 48_000_000, at: 1_900_000_000, atMs: 1_900_000_000_250, message: 'Money moved out of Savings.' };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(Alert.safeParse({ ...a, amountSats: 0 }).success).toBe(true);
    for (const missing of ['walletId', 'txid', 'amountSats'] as const) {
      const { [missing]: _omit, ...rest } = a;
      expect(Alert.safeParse(rest).success, missing).toBe(false);
    }
    // `at` and `atMs` must be the same moment, as for every alert.
    expect(Alert.safeParse({ ...a, atMs: 1_900_000_100_000 }).success).toBe(false);
  });
});

describe('savings changes nothing in the policy', () => {
  it('the same rules hash and read on the device exactly as before', () => {
    const rules: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
    // No member was added for Savings: the canonical JSON (what `policyHash` hashes) is the four members, as always.
    expect(canonicalJson(normalizePolicy(rules))).toBe(`{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`);
    const text = approvalMessage({ action: 'policy', policy: rules }, { walletId: WALLET_ID, sequence: 3, expiresAt: 1_900_000_000 });
    expect(text.startsWith('Trikey policy v1 ')).toBe(true);
    expect(text).not.toMatch(/savings/i);
  });
});
