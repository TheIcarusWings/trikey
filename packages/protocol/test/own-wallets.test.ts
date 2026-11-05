/**
 * Own wallets (docs/design/multi-wallet.md, section 4): the optional `walletId` on the methods that act on a wallet,
 * `wallet.add.prepare` / `wallet.add`, `guardian.status.wallets`, the `wallet_added` alert and `walletId` on alerts.
 */
import { describe, expect, it } from 'vitest';
import { Alert, GUARDIAN_FEATURES, MAX_OWN_WALLETS, methods, type MethodName } from '../src/index.js';
import { WALLET_ID, accessApproval, approval, fakePsbt, hardwareAuth, pairParams, policy, RAW_TX } from './helpers.js';

const OTHER = 'fedcba9876543210';

/** A valid request of every method that acts on a wallet, without `walletId`. */
const routed: Partial<Record<MethodName, Record<string, unknown>>> = {
  'guardian.status': {},
  sign: { psbt: fakePsbt() },
  'policy.get': {},
  'policy.update': { policy, approval },
  'recovery.start': { sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' },
  'recovery.update': { recoveryId: 'rec-12345678', sweepPsbt: fakePsbt(3) },
  'recovery.cancel': { recoveryId: 'rec-12345678' },
  'recovery.status': {},
  'phone.resume': { approval },
  'hardware.confirm': { hardwareAuth, hardwareAuthProof: pairParams.hardwareAuthProof },
  'wallet.retire': { approval },
  'wallet.sync': { historyLimit: 50 },
  'tx.get': { txid: 'ab'.repeat(32) },
  'tx.broadcast': { txHex: RAW_TX },
  // Phase 2 (`own_wallets_2`): each wallet's Savings.
  'savings.register': { descriptor: 'wsh(sortedmulti(2,A,B,C))' },
  'savings.unregister': {},
  'savings.get': {},
};

/** Methods that stay the first wallet's (or the box's): `walletId` is refused as an unknown member. */
const notRouted: Partial<Record<MethodName, Record<string, unknown>>> = {
  'guardian.unlock': { kind: 'passphrase', passphrase: 'correct horse' },
  'guardian.lock': {},
  'fees.estimate': { targets: [1] },
  'recovery.access': { approval: accessApproval },
  'sp.unregister': {},
  'relays.ack': { relays: ['wss://relay.example.com'] },
};

describe('own wallets: walletId on requests', () => {
  it('every routed method takes an optional walletId and means the first wallet without it', () => {
    for (const [m, params] of Object.entries(routed) as [MethodName, Record<string, unknown>][]) {
      const schema = methods[m].params;
      expect(schema.safeParse(params).success, `${m} without walletId`).toBe(true);
      expect(schema.safeParse({ ...params, walletId: WALLET_ID }).success, `${m} with walletId`).toBe(true);
      expect(schema.safeParse({ ...params, walletId: 'NOT-HEX' }).success, `${m} with a bad walletId`).toBe(false);
    }
  });

  it('methods that stay the first wallet\'s refuse walletId (so nothing acts on the wrong wallet)', () => {
    for (const [m, params] of Object.entries(notRouted) as [MethodName, Record<string, unknown>][]) {
      const schema = methods[m].params;
      expect(schema.safeParse(params).success, `${m} plain`).toBe(true);
      expect(schema.safeParse({ ...params, walletId: WALLET_ID }).success, `${m} with walletId`).toBe(false);
    }
  });

  it('wallet.unwatch keeps its own walletId (the watched wallet)', () => {
    expect(methods['wallet.unwatch'].params.safeParse({ walletId: WALLET_ID }).success).toBe(true);
  });

  it('a hosted recovery.start stays without walletId', () => {
    const hosted = { sweepPsbt: fakePsbt(), destinationKeys: { app: `02${'11'.repeat(32)}`, hardware: `03${'22'.repeat(32)}`, cosigner: `02${'33'.repeat(32)}` }, destinationMap: 'AbC'.repeat(10) };
    expect(methods['recovery.start'].params.safeParse(hosted).success).toBe(true);
    expect(methods['recovery.start'].params.safeParse({ ...hosted, walletId: WALLET_ID }).success).toBe(false);
  });
});

describe('own wallets: wallet.add', () => {
  const add = {
    account: 2,
    name: 'Business',
    descriptor: 'wsh(sortedmulti(2,A,B,C))',
    hardwareAuth,
    hardwareAuthProof: pairParams.hardwareAuthProof,
    rules: policy,
  };

  it('takes an even account from 2 (0 is the first wallet) up to the cap', () => {
    const p = methods['wallet.add.prepare'].params;
    for (const account of [2, 4, 2 * (MAX_OWN_WALLETS - 1)]) expect(p.safeParse({ account }).success, String(account)).toBe(true);
    for (const account of [1, 3, -2, 2 * MAX_OWN_WALLETS, 2.5]) expect(p.safeParse({ account }).success, String(account)).toBe(false);
    expect(p.safeParse({ account: 2, extra: 1 }).success).toBe(false);
  });

  it('wallet.add needs the name (1-16 characters), the proof and the rules', () => {
    const p = methods['wallet.add'].params;
    expect(p.safeParse(add).success).toBe(true);
    expect(p.safeParse({ ...add, firstName: 'Daily' }).success).toBe(true);
    expect(p.safeParse({ ...add, name: '' }).success).toBe(false);
    expect(p.safeParse({ ...add, name: 'x'.repeat(17) }).success).toBe(false);
    const { hardwareAuthProof: _, ...noProof } = add;
    expect(p.safeParse(noProof).success).toBe(false);
    expect(p.safeParse({ ...add, walletId: WALLET_ID }).success).toBe(false);
  });

  it('results', () => {
    const key = { fingerprint: 'deadbeef', path: "m/48'/1'/2'/2'", xpub: pairParams.phoneKey.xpub };
    expect(methods['wallet.add.prepare'].result.safeParse({ account: 2, guardianKey: key }).success).toBe(true);
    expect(methods['wallet.add'].result.safeParse({ walletId: OTHER, account: 2, name: 'Business', descriptor: add.descriptor, guardianKey: key }).success).toBe(true);
  });

  it('the feature name', () => {
    expect(GUARDIAN_FEATURES.ownWallets).toBe('own_wallets');
    expect(GUARDIAN_FEATURES.ownWallets2).toBe('own_wallets_2');
  });

  it('phase 2: the hardware kind and the wallet it replaces ("Replace guardian")', () => {
    const p = methods['wallet.add'].params;
    expect(p.safeParse({ ...add, hardwareKind: 'ledger' }).success).toBe(true);
    // A kind a later app knows passes; nonsense does not.
    expect(p.safeParse({ ...add, hardwareKind: 'future-device' }).success).toBe(true);
    expect(p.safeParse({ ...add, hardwareKind: 'Not A Kind!' }).success).toBe(false);
    expect(p.safeParse({ ...add, replacesWalletId: OTHER, replacesDescriptor: 'wsh(sortedmulti(2,D,E,F))' }).success).toBe(true);
    expect(p.safeParse({ ...add, replacesWalletId: OTHER }).success).toBe(true);
    // The descriptor alone names nothing.
    expect(p.safeParse({ ...add, replacesDescriptor: 'wsh(sortedmulti(2,D,E,F))' }).success).toBe(false);
  });
});

describe('own wallets: status and alerts', () => {
  const status = {
    state: 'unlocked',
    paired: true,
    nextHardwareSequence: 1,
    phoneSpending: 'enabled',
    activeRecoveryId: null,
    version: '0.1.14',
    time: 1_900_000_000,
  };

  it('guardian.status may list the wallets (and older phones drop the member)', () => {
    const r = methods['guardian.status'].result;
    const wallets = [
      { walletId: WALLET_ID, account: 0, name: 'Daily', descriptor: 'wsh(sortedmulti(2,A,B,C))', hardwareAuth },
      { walletId: OTHER, account: 2, name: 'Business', hardwareKind: 'trezor', descriptor: 'wsh(sortedmulti(2,D,E,F))', hardwareAuth, state: 'active' },
    ];
    const parsed = r.safeParse({ ...status, wallets });
    expect(parsed.success).toBe(true);
    expect(r.safeParse({ ...status, wallets: [{ ...wallets[1], account: 3 }] }).success).toBe(false);
    expect(r.safeParse(status).success).toBe(true);
  });

  it('alerts carry an optional walletId; wallet_added names the new wallet', () => {
    expect(Alert.safeParse({ type: 'recovery_cancelled', at: 1_900_000_000, recoveryId: 'abcdef0123456789w1-0123456789ab', cancelledBy: 'app', walletId: OTHER }).success).toBe(true);
    expect(Alert.safeParse({ type: 'wallet_tx', at: 1_900_000_000, txid: 'ab'.repeat(32), direction: 'in', amountSats: 5, confirmations: 0, wallet: 'main', walletId: OTHER }).success).toBe(true);
    expect(Alert.safeParse({ type: 'wallet_added', at: 1_900_000_000, walletId: OTHER, account: 2, name: 'Business' }).success).toBe(true);
    expect(Alert.safeParse({ type: 'wallet_added', at: 1_900_000_000, walletId: OTHER, account: 2 }).success).toBe(false);
  });

  it("an own wallet's recovery id fits RecoveryId", () => {
    expect(methods['recovery.cancel'].params.safeParse({ recoveryId: 'abcdef0123456789w12-0123456789ab' }).success).toBe(true);
  });
});
