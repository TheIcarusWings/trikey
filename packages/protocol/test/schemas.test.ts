import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  Alert,
  ErrorCode,
  MessageSchema,
  METHOD_NAMES,
  NotificationSchema,
  PsbtBase64,
  RequestSchema,
  ResponseSchema,
  RpcError,
  canonicalJson,
  HardwareApproval,
  MAX_APPROVAL_MESSAGE_LENGTH,
  Policy,
  type Policy as PolicyType,
  Recovery,
  approvalMessage,
  methods,
  normalizePolicy,
  pairingMessage,
  policyHash,
  generateMessageId,
  recoveryAccessMessage,
  psbtOf,
  MAX_SYNC_UTXOS,
  MAX_TX_HEX_LENGTH,
  MAX_SINGLE_KEY_COINS,
  MAX_SP_MATCHES,
  SP_REORG_DEPTH,
} from '../src/index.js';
import {
  CONTACT_A,
  CONTACT_B,
  RAW_TX,
  WALLET_ID,
  accessApproval,
  approval,
  fakePsbt,
  hardwareAuth,
  keyOrigin,
  pairParams,
  policy,
  recovery,
} from './helpers.js';

const id = generateMessageId();

/** Throwaway values: a tpub-shaped key origin, a taproot script, BIP 352 keys of fixed test bytes. */
const helperKey = { ...keyOrigin, path: "m/84'/1'/1'" };
const TAPROOT_SCRIPT = `5120${'ab'.repeat(32)}`;
const spRegister = { scanPrivateKey: '11'.repeat(32), spendPublicKey: `02${'22'.repeat(32)}`, labels: [0, 1, 7], birthHeight: 800_000 };

describe('request schemas', () => {
  const samples: Record<string, unknown> = {
    'pair.prepare': { pairingSecret: 'A'.repeat(43), network: 'bitcoin' },
    pair: pairParams,
    sign: { psbt: fakePsbt() },
    'policy.get': {},
    'policy.update': { policy, approval },
    'recovery.start': { sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' },
    'recovery.update': { recoveryId: 'rec-12345678', sweepPsbt: fakePsbt(3) },
    'recovery.cancel': { recoveryId: 'rec-12345678' },
    'recovery.status': {},
    'phone.resume': { approval },
    'guardian.unlock': { kind: 'passphrase', passphrase: 'correct horse' },
    'guardian.status': {},
    'wallet.sync': { historyLimit: 50 },
    'tx.get': { txid: 'ab'.repeat(32) },
    'tx.broadcast': { txHex: RAW_TX },
    'wallet.unwatch': {},
    'fees.estimate': { targets: [1, 6] },
    'recovery.access': { approval: accessApproval },
    'guardian.lock': {},
    'wallet.retire': { approval },
    'hardware.confirm': { hardwareAuth, hardwareAuthProof: pairParams.hardwareAuthProof },
    'singlekey.register': { helper: helperKey, coins: [{ txid: 'cd'.repeat(32), vout: 1, script: TAPROOT_SCRIPT }] },
    'sp.register': spRegister,
    'sp.unregister': {},
    'sp.scan': { fromHeight: 800_000 },
    'relays.ack': { relays: ['wss://relay.example.com', 'ws://umbrel.local:4848'] },
    'savings.register': { descriptor: 'wsh(sortedmulti(2,A,B,C))' },
    'savings.unregister': {},
    'savings.get': {},
  };

  it('has a sample for every method', () => {
    expect(Object.keys(samples).sort()).toEqual([...METHOD_NAMES].sort());
  });

  for (const method of METHOD_NAMES) {
    it(`accepts a valid ${method} request`, () => {
      expect(RequestSchema.safeParse({ id, method, params: samples[method] }).success).toBe(true);
      expect(MessageSchema.safeParse({ id, method, params: samples[method] }).success).toBe(true);
    });
  }

  it('rejects unknown methods, bad ids, extra fields and bad params', () => {
    expect(RequestSchema.safeParse({ id, method: 'wallet.drain', params: {} }).success).toBe(false);
    expect(RequestSchema.safeParse({ id: 'short', method: 'guardian.status', params: {} }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'guardian.status', params: {}, extra: 1 }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'sign', params: { psbt: 'AAAA' } }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'sign', params: {} }).success).toBe(false);
  });

  it('validates guardian.unlock variants', () => {
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'hardware', secret: 'ab'.repeat(32) }).success).toBe(true);
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'hardware', secret: 'zz' }).success).toBe(false);
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'magic' }).success).toBe(false);
  });
});

describe('methods', () => {
  const ok = (m: keyof typeof methods, params: unknown) => methods[m].params.safeParse(params).success;

  it('pair carries the hardware auth key, pairing proof, phone nostr key and initial rules', () => {
    expect(ok('pair', pairParams)).toBe(true);
    for (const missing of ['hardwareAuth', 'hardwareAuthProof', 'phoneNostrPubkey', 'rules', 'descriptor'] as const) {
      const { [missing]: _omit, ...rest } = pairParams;
      expect(ok('pair', rest), missing).toBe(false);
    }
    expect(ok('pair', { ...pairParams, hardwareAuth: { ...pairParams.hardwareAuth, pubkey: 'ab'.repeat(32) } })).toBe(false); // x-only, not compressed
    expect(ok('pair', { ...pairParams, hardwareAuth: { ...pairParams.hardwareAuth, path: 'm/' } })).toBe(false);
    expect(ok('pair', { ...pairParams, hardwareAuthProof: 'AAAA' })).toBe(false);
    expect(ok('pair', { ...pairParams, phoneNostrPubkey: 'CD'.repeat(32) })).toBe(false);
    expect(ok('pair', { ...pairParams, rules: { ...policy, recoveryDelayDays: 10 } })).toBe(false);
  });

  it('rejects unknown params members instead of dropping them', () => {
    expect(ok('pair', { ...pairParams, kind: 'bip137' })).toBe(false);
    expect(ok('sign', { psbt: fakePsbt(), extra: 1 })).toBe(false);
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', force: true })).toBe(false);
  });

  it('recovery.cancel takes an optional hardware approval', () => {
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', approval })).toBe(true);
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', approval: { ...approval, kind: 'psbt' } })).toBe(false);
    expect(ok('recovery.cancel', { recoveryId: 'Not Valid' })).toBe(false);
  });

  it('phone.resume requires a hardware approval', () => {
    expect(ok('phone.resume', { approval })).toBe(true);
    expect(ok('phone.resume', {})).toBe(false);
  });

  it('policy.update approval is optional; old policy members are rejected', () => {
    expect(ok('policy.update', { policy })).toBe(true);
    expect(ok('policy.update', { policy: { ...policy, perTxLimitSats: 1000 } })).toBe(false);
    expect(ok('policy.update', { policy: { ...policy, allowlist: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'] } })).toBe(false);
  });

  it('pair may name the wallet it replaces (moving a wallet to a new guardian)', () => {
    expect(ok('pair', { ...pairParams, replacesWalletId: WALLET_ID })).toBe(true);
    expect(ok('pair', { ...pairParams, replacesWalletId: 'not-a-wallet-id' })).toBe(false);
  });

  it('pair may carry the replaced wallet\'s descriptor, which needs its id', () => {
    const replaced = 'wsh(sortedmulti(2,D,E,F))';
    expect(ok('pair', { ...pairParams, replacesWalletId: WALLET_ID, replacesDescriptor: replaced })).toBe(true);
    expect(ok('pair', { ...pairParams, replacesDescriptor: replaced })).toBe(false); // nothing to check it against
    expect(ok('pair', { ...pairParams, replacesWalletId: WALLET_ID, replacesDescriptor: 'short' })).toBe(false);
    expect(ok('pair', { ...pairParams, replacesWalletId: WALLET_ID, replacesDescriptor: 'x'.repeat(2001) })).toBe(false);
    expect(ok('pair', { ...pairParams, replacesWalletId: WALLET_ID, replacesDescriptor: 42 })).toBe(false);
    // The wire request is refused the same way, and an old phone's pair (no descriptor) is unchanged.
    expect(RequestSchema.safeParse({ id, method: 'pair', params: { ...pairParams, replacesDescriptor: replaced } }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'pair', params: { ...pairParams, replacesWalletId: WALLET_ID, replacesDescriptor: replaced } }).success).toBe(true);
    expect(RequestSchema.safeParse({ id, method: 'pair', params: { ...pairParams, replacesWalletId: WALLET_ID } }).success).toBe(true);
  });

  it('wallet.unwatch takes an optional wallet id, and says whether it dropped one', () => {
    expect(ok('wallet.unwatch', {})).toBe(true);
    expect(ok('wallet.unwatch', { walletId: WALLET_ID })).toBe(true);
    expect(ok('wallet.unwatch', { walletId: 'replaced' })).toBe(false);
    expect(ok('wallet.unwatch', { walletId: WALLET_ID.toUpperCase() })).toBe(false);
    expect(ok('wallet.unwatch', { approval })).toBe(false); // no approval: it only takes capability away
    expect(methods['wallet.unwatch'].result.safeParse({ unwatched: true, walletId: WALLET_ID }).success).toBe(true);
    expect(methods['wallet.unwatch'].result.safeParse({ unwatched: false }).success).toBe(true);
    expect(methods['wallet.unwatch'].result.safeParse({}).success).toBe(false);
  });

  it('guardian.lock takes nothing; wallet.retire requires a hardware approval; hardware.confirm a key and its proof', () => {
    expect(ok('guardian.lock', {})).toBe(true);
    expect(ok('guardian.lock', { reason: 'stolen' })).toBe(false);
    expect(methods['guardian.lock'].result.safeParse({ state: 'locked' }).success).toBe(true);
    expect(methods['guardian.lock'].result.safeParse({ state: 'unlocked' }).success).toBe(false);
    expect(ok('wallet.retire', { approval })).toBe(true);
    expect(ok('wallet.retire', {})).toBe(false);
    expect(ok('wallet.retire', { approval: { ...approval, sequence: 0 } })).toBe(false);
    expect(methods['wallet.retire'].result.safeParse({ walletId: WALLET_ID, retiredAt: 1_900_000_000 }).success).toBe(true);
    expect(ok('hardware.confirm', { hardwareAuth })).toBe(false);
    expect(ok('hardware.confirm', { hardwareAuth: { ...hardwareAuth, pubkey: 'ab'.repeat(32) }, hardwareAuthProof: pairParams.hardwareAuthProof })).toBe(false);
    expect(methods['hardware.confirm'].result.safeParse({ walletId: WALLET_ID, hardwareAuth, nextHardwareSequence: 3 }).success).toBe(true);
  });

  it('recovery.update names the running recovery and carries the new sweep (security review 2026-10, finding 8)', () => {
    expect(ok('recovery.update', { recoveryId: 'rec-12345678', sweepPsbt: fakePsbt() })).toBe(true);
    expect(ok('recovery.update', { sweepPsbt: fakePsbt() })).toBe(false);
    expect(ok('recovery.update', { recoveryId: 'rec-12345678' })).toBe(false);
    expect(ok('recovery.update', { recoveryId: 'rec-12345678', sweepPsbt: fakePsbt(), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' })).toBe(false); // same destination only
    expect(methods['recovery.update'].result.safeParse({ recovery }).success).toBe(true);
    // It carries a PSBT, so its envelope has the psbt tag.
    const msg = { id, method: 'recovery.update', params: { recoveryId: 'rec-12345678', sweepPsbt: fakePsbt(4) } };
    expect(RequestSchema.safeParse(msg).success).toBe(true);
    expect(psbtOf(msg as never)).toBe(fakePsbt(4));
  });

  it('a recovery the guardian closed at a rotation is cancelled by "superseded"; policy warnings are an enum', () => {
    expect(Recovery.safeParse({ ...recovery, state: 'cancelled', cancelledBy: 'superseded', cancelledAt: recovery.startedAt + 5 }).success).toBe(true);
    expect(methods['policy.get'].result.safeParse({ policy, nextHardwareSequence: 1, policyHash: 'ab'.repeat(32), warnings: ['no_alert_contacts'] }).success).toBe(true);
    expect(methods['policy.get'].result.safeParse({ policy, nextHardwareSequence: 1, policyHash: 'ab'.repeat(32), warnings: ['whatever'] }).success).toBe(false);
  });

  it('results carry the engine-shaped recovery and the contested flag', () => {
    const cancelled = { ...recovery, state: 'cancelled', cancelledBy: 'hardware', cancelledAt: recovery.startedAt + 5 };
    expect(methods['recovery.cancel'].result.safeParse({ recovery: cancelled, contested: true }).success).toBe(true);
    expect(methods['recovery.cancel'].result.safeParse({ recovery }).success).toBe(false);
    expect(Recovery.safeParse({ ...recovery, cancelledBy: 'guardian' }).success).toBe(false);
    expect(Recovery.safeParse({ ...recovery, survivingRole: 'cosigner' }).success).toBe(false);
    expect(methods['phone.resume'].result.safeParse({ phoneSpending: 'enabled' }).success).toBe(true);
  });
});

describe('chain methods', () => {
  const ok = (m: keyof typeof methods, params: unknown) => methods[m].params.safeParse(params).success;
  const res = (m: keyof typeof methods, result: unknown) => methods[m].result.safeParse(result).success;
  const utxo = { txid: 'ab'.repeat(32), vout: 1, valueSats: 50_000, height: 120, confirmations: 3, chain: 0, index: 4 };
  const sync = {
    tipHeight: 122,
    tipHash: 'cd'.repeat(32),
    utxos: [utxo, { ...utxo, vout: 2, height: 0, confirmations: 0, chain: 1, index: 0 }],
    utxosTruncated: false,
    balance: { confirmedSats: 50_000, unconfirmedSats: 50_000 },
    history: [
      { txid: 'ef'.repeat(32), height: 0, confirmations: 0, netSats: -12_345, feeSats: 345 },
      { txid: 'ab'.repeat(32), height: 120, confirmations: 3, time: 1_800_000_000, netSats: 100_000 },
    ],
    historyTruncated: false,
    nextReceiveIndex: 5,
    nextChangeIndex: 1,
    gapLimit: 20,
  };

  it('wallet.sync takes an optional history limit and returns coins, history and next indexes', () => {
    expect(ok('wallet.sync', {})).toBe(true);
    expect(ok('wallet.sync', { historyLimit: 0 })).toBe(false);
    expect(ok('wallet.sync', { historyLimit: 501 })).toBe(false);
    expect(ok('wallet.sync', { gapLimit: 5 })).toBe(false); // the guardian's gap limit, not the phone's
    expect(res('wallet.sync', sync)).toBe(true);
    expect(res('wallet.sync', { ...sync, utxos: [{ ...utxo, chain: 2 }] })).toBe(false);
    expect(res('wallet.sync', { ...sync, utxos: [{ ...utxo, valueSats: -1 }] })).toBe(false);
    expect(res('wallet.sync', { ...sync, utxos: Array(MAX_SYNC_UTXOS + 1).fill(utxo) })).toBe(false);
    expect(res('wallet.sync', { ...sync, history: [{ ...sync.history[0], time: Date.now() }] })).toBe(false); // ms, not seconds
    const { nextChangeIndex: _omit, ...missing } = sync;
    expect(res('wallet.sync', missing)).toBe(false);
  });

  it('wallet.sync may name the replaced (watched) wallet, and says which wallet it read', () => {
    expect(ok('wallet.sync', { wallet: 'replaced' })).toBe(true);
    expect(ok('wallet.sync', { wallet: WALLET_ID, historyLimit: 10 })).toBe(true);
    expect(ok('wallet.sync', { wallet: 'old' })).toBe(false);
    expect(ok('wallet.sync', { wallet: 'REPLACED' })).toBe(false);
    expect(ok('wallet.sync', { wallet: WALLET_ID.slice(2) })).toBe(false);
    expect(ok('wallet.sync', { wallet: undefined })).toBe(true);
    expect(res('wallet.sync', { ...sync, walletId: WALLET_ID })).toBe(true);
    expect(res('wallet.sync', { ...sync, walletId: 'replaced' })).toBe(false);
    expect(res('wallet.sync', sync)).toBe(true); // a guardian without watched wallets omits it
  });

  it('tx.get and tx.broadcast carry lowercase raw transaction hex of bounded size', () => {
    expect(ok('tx.get', { txid: 'AB'.repeat(32) })).toBe(false);
    expect(ok('tx.get', { txid: 'ab'.repeat(32), witness: false })).toBe(true);
    expect(res('tx.get', { txHex: RAW_TX })).toBe(true);
    expect(ok('tx.broadcast', { txHex: RAW_TX.toUpperCase() })).toBe(false);
    expect(ok('tx.broadcast', { txHex: RAW_TX.slice(1) })).toBe(false); // odd length
    expect(ok('tx.broadcast', { txHex: 'ab'.repeat(MAX_TX_HEX_LENGTH / 2 + 1) })).toBe(false);
    expect(ok('tx.broadcast', { txHex: 'abcd' })).toBe(false);
    expect(res('tx.broadcast', { txid: 'ab'.repeat(32) })).toBe(true);
  });

  it('fees.estimate returns sat/vB per target, null when the node has none', () => {
    expect(ok('fees.estimate', {})).toBe(true);
    expect(ok('fees.estimate', { targets: [] })).toBe(false);
    expect(ok('fees.estimate', { targets: [0] })).toBe(false);
    expect(res('fees.estimate', { estimates: [{ target: 1, satPerVb: 12.5 }, { target: 144, satPerVb: null }], minRelaySatPerVb: 1 })).toBe(true);
    expect(res('fees.estimate', { estimates: [{ target: 1, satPerVb: 0 }], minRelaySatPerVb: 1 })).toBe(false);
  });

  it('recovery.access takes an access approval without a sequence', () => {
    expect(ok('recovery.access', { approval: { ...accessApproval, sequence: 1 } })).toBe(false);
    expect(ok('recovery.access', { approval })).toBe(false);
    expect(ok('recovery.access', {})).toBe(false);
    expect(
      res('recovery.access', {
        descriptor: 'wsh(sortedmulti(2,A,B,C))',
        walletId: WALLET_ID,
        network: 'regtest',
        guardianKey: keyOrigin,
        hardwareAuth,
        policy,
        nextHardwareSequence: 1,
        phoneSpending: 'enabled',
        activeRecoveryId: null,
        accessExpiresAt: 1_900_000_000,
      }),
    ).toBe(true);
  });

  it('guardian.status may carry the daily limit', () => {
    const status = { state: 'locked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.0', time: 1_800_000_000 };
    expect(res('guardian.status', status)).toBe(true);
    expect(res('guardian.status', { ...status, dailyLimit: { limitSats: 100, usedSats: 40, availableSats: 60 } })).toBe(true);
    expect(res('guardian.status', { ...status, watchedWalletId: WALLET_ID })).toBe(true);
    expect(res('guardian.status', { ...status, watchedWalletId: 'replaced' })).toBe(false);
    const parsed = methods['guardian.status'].result.parse({ ...status, dailyLimit: { limitSats: 100, usedSats: 40, availableSats: 60 } });
    expect(parsed.dailyLimit?.usedSats).toBe(40);
  });
});

describe('silent payments', () => {
  it('singlekey.register takes the helper account key and/or single-key coins, at least one', () => {
    const P = methods['singlekey.register'].params;
    expect(P.safeParse({ helper: helperKey }).success).toBe(true);
    expect(P.safeParse({ coins: [] }).success).toBe(true);
    expect(P.safeParse({ coins: [{ txid: 'cd'.repeat(32), vout: 0, script: `0014${'ab'.repeat(20)}` }] }).success).toBe(true);
    expect(P.safeParse({}).success).toBe(false);
    // Only single-key P2TR or P2WPKH scripts, lowercase; no multisig (P2WSH) script.
    expect(P.safeParse({ coins: [{ txid: 'cd'.repeat(32), vout: 0, script: `0020${'ab'.repeat(32)}` }] }).success).toBe(false);
    expect(P.safeParse({ coins: [{ txid: 'cd'.repeat(32), vout: 0, script: TAPROOT_SCRIPT.toUpperCase() }] }).success).toBe(false);
    expect(P.safeParse({ coins: Array.from({ length: MAX_SINGLE_KEY_COINS + 1 }, (_, i) => ({ txid: 'cd'.repeat(32), vout: i, script: TAPROOT_SCRIPT })) }).success).toBe(false);
    expect(P.safeParse({ helper: helperKey, extra: 1 }).success).toBe(false);
    expect(methods['singlekey.register'].result.safeParse({ helper: true, coins: 1 }).success).toBe(true);
  });

  it('sp.register carries the scan private key, B_spend, labels with 0, and the birth height', () => {
    const P = methods['sp.register'].params;
    expect(P.safeParse(spRegister).success).toBe(true);
    expect(P.safeParse({ ...spRegister, labels: [1, 2] }).success).toBe(false); // no change label
    expect(P.safeParse({ ...spRegister, labels: [0, 1, 1] }).success).toBe(false);
    expect(P.safeParse({ ...spRegister, labels: [0, 2 ** 32] }).success).toBe(false);
    expect(P.safeParse({ ...spRegister, spendPublicKey: `04${'ab'.repeat(32)}` }).success).toBe(false);
    expect(P.safeParse({ ...spRegister, scanPrivateKey: 'AB'.repeat(32) }).success).toBe(false);
    // A spend private key has no place here: the schema is strict.
    expect(P.safeParse({ ...spRegister, spendPrivateKey: 'ab'.repeat(32) }).success).toBe(false);
    expect(methods['sp.register'].result.safeParse({ registered: true, birthHeight: 100, scannedHeight: 99, tipHeight: 120 }).success).toBe(true);
    expect(methods['sp.unregister'].result.safeParse({ unregistered: false }).success).toBe(true);
  });

  it('sp.scan returns the scanned tip and matches with their tweaks', () => {
    expect(methods['sp.scan'].params.safeParse({}).success).toBe(true);
    const match = { txid: 'ab'.repeat(32), vout: 0, valueSats: 30_000, outputKey: 'cd'.repeat(32), tweak: 'ef'.repeat(32), height: 120 };
    const R = methods['sp.scan'].result;
    expect(R.safeParse({ tipHeight: 125, birthHeight: 100, scanning: false, matches: [match, { ...match, vout: 1, label: 1 }], matchesTruncated: false }).success).toBe(true);
    expect(R.safeParse({ tipHeight: 125, birthHeight: 100, scanning: false, matches: [{ ...match, tweak: 'zz' }], matchesTruncated: false }).success).toBe(false);
    expect(SP_REORG_DEPTH).toBe(6);
    expect(MAX_SP_MATCHES).toBeGreaterThan(0);
  });

  it('wallet.sync may read the helper, with single-key coins by script; vault results still parse without them', () => {
    expect(methods['wallet.sync'].params.safeParse({ wallet: 'helper' }).success).toBe(true);
    expect(methods['wallet.sync'].params.safeParse({ wallet: 'single' }).success).toBe(false);
    const base = { tipHeight: 120, tipHash: 'ab'.repeat(32), utxos: [], utxosTruncated: false, balance: { confirmedSats: 0, unconfirmedSats: 0 }, history: [], historyTruncated: false, nextReceiveIndex: 0, nextChangeIndex: 0, gapLimit: 20 };
    expect(methods['wallet.sync'].result.safeParse(base).success).toBe(true);
    const coin = { script: TAPROOT_SCRIPT, txid: 'ab'.repeat(32), vout: 2, valueSats: 1000, height: 0, confirmations: 0 };
    expect(methods['wallet.sync'].result.safeParse({ ...base, coins: [coin] }).success).toBe(true);
    expect(methods['wallet.sync'].result.safeParse({ ...base, coins: [{ ...coin, script: '51' }] }).success).toBe(false);
  });

  it('the sp_received alert names the coin, not its tweak', () => {
    const at = 1_800_000_000;
    const a = { type: 'sp_received', txid: 'ab'.repeat(32), vout: 0, valueSats: 30_000, height: 120, at, atMs: at * 1000 + 5 };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(Alert.safeParse({ ...a, label: 3 }).success).toBe(true);
    expect(Alert.safeParse({ ...a, valueSats: -1 }).success).toBe(false);
    expect(NotificationSchema.safeParse({ id, method: 'alert', params: a }).success).toBe(true);
  });
});

describe('guardian.status atMs', () => {
  const res = (result: unknown) => methods['guardian.status'].result.safeParse(result).success;
  const status = { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.0', time: 1_800_000_000 };

  it('is optional, in milliseconds, and the same moment as time', () => {
    expect(res(status)).toBe(true); // an older guardian
    expect(res({ ...status, atMs: 1_800_000_000_123 })).toBe(true);
    expect(res({ ...status, atMs: 1_800_000_000_000 })).toBe(true);
    expect(res({ ...status, atMs: 1_800_000_000 })).toBe(false); // seconds by mistake: the year 1970
    expect(res({ ...status, atMs: 1_800_000_000_123.5 })).toBe(false);
    expect(res({ ...status, atMs: -1 })).toBe(false);
    expect(res({ ...status, atMs: 4_102_444_800_001 })).toBe(false);
    expect(res({ ...status, atMs: 1_800_000_030_000 })).toBe(false); // 30 s away from time
    expect(res({ ...status, atMs: 1_800_000_001_000 })).toBe(true); // a rounding implementation is within a second
  });
});

describe('Policy', () => {
  it('has exactly the rules the engine enforces (the opt-in contactLock among them)', () => {
    expect(Object.keys(Policy.shape).sort()).toEqual(['alertContacts', 'contactLock', 'dailyLimitSats', 'recoveryDelayDays', 'sweepFeeCapSats']);
    expect(Policy.safeParse(policy).success).toBe(true);
  });

  it('rejects unknown members rather than preserving them', () => {
    expect(Policy.safeParse({ ...policy, futureField: { a: 1 } }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, perTxLimitSats: 1 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, allowlist: [] }).success).toBe(false);
  });

  it('restricts the recovery delay to 7, 14 or 30 days', () => {
    for (const d of [7, 14, 30]) expect(Policy.safeParse({ ...policy, recoveryDelayDays: d }).success).toBe(true);
    for (const d of [0, 1, 8, 15, 31, 90, 7.5]) expect(Policy.safeParse({ ...policy, recoveryDelayDays: d }).success, String(d)).toBe(false);
  });

  it('requires a positive fee cap and a sane daily limit', () => {
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: 0 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: 1.5 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: undefined }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: 0 }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: -1 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: 2_100_000_000_000_001 }).success).toBe(false);
  });

  it('accepts up to 20 lowercase 32-byte hex alert contacts', () => {
    const contacts = (n: number) => Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    expect(Policy.safeParse({ ...policy, alertContacts: [] }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, alertContacts: contacts(20) }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, alertContacts: contacts(21) }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['AB'.repeat(32)] }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['ab'.repeat(31)] }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['npub1xyz'] }).success).toBe(false);
  });
});

describe('HardwareApproval', () => {
  it('is { kind, sequence, expiresAt, signature } and nothing else', () => {
    expect(Object.keys(HardwareApproval.shape).sort()).toEqual(['expiresAt', 'kind', 'sequence', 'signature']);
    expect(HardwareApproval.safeParse(approval).success).toBe(true);
    expect(HardwareApproval.safeParse({ ...approval, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, kind: 'psbt' }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, sequence: 0 }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, expiresAt: 1_900_000_000_000 }).success).toBe(false); // milliseconds by mistake
  });
});

describe('PSBT and signature strings', () => {
  it('requires the psbt magic', () => {
    expect(PsbtBase64.safeParse(fakePsbt()).success).toBe(true);
    expect(PsbtBase64.safeParse(Buffer.alloc(40, 1).toString('base64')).success).toBe(false);
    expect(PsbtBase64.safeParse('not base64 !!!!!!!!!').success).toBe(false);
  });

  it('rejects a BIP137 signature with the wrong length or header', () => {
    const sig = HardwareApproval.shape.signature;
    expect(sig.safeParse(Buffer.alloc(64, 31).toString('base64')).success).toBe(false);
    expect(sig.safeParse(Buffer.from([50, ...new Uint8Array(64)]).toString('base64')).success).toBe(false);
  });
});

describe('responses and alerts', () => {
  it('accepts a success or an error response, not both or neither', () => {
    expect(ResponseSchema.safeParse({ id, result: { ok: true } }).success).toBe(true);
    expect(ResponseSchema.safeParse({ id, error: { code: 1100, message: 'locked' } }).success).toBe(true);
    expect(ResponseSchema.safeParse({ id, result: {}, error: { code: 1, message: 'x' } }).success).toBe(false);
    expect(ResponseSchema.safeParse({ id }).success).toBe(false);
  });

  it('accepts every alert type', () => {
    const at = 1_800_000_000;
    const info = { recoveryId: 'rec-1', readyAt: at + 604800, survivingRole: 'app', amountSats: 100_000 };
    const alerts = [
      { type: 'recovery_started', ...info, at },
      { type: 'recovery_reminder', ...info, daysLeft: 6, at },
      { type: 'recovery_ready', ...info, at },
      { type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy: 'hardware', contested: true, at },
      { type: 'recovery_completed', recoveryId: 'rec-1', txid: 'ab'.repeat(32), at },
      { type: 'guardian_locked', reason: 'restart', at },
      { type: 'guardian_locked', reason: 'remote', at },
      { type: 'wallet_adopted', walletId: WALLET_ID, previousWalletId: 'fedcba9876543210', recoveryId: 'rec-1', hardwareConfirmRequired: true, at },
      { type: 'wallet_retired', walletId: WALLET_ID, reason: 'recovered', successorWalletId: 'fedcba9876543210', at },
      { type: 'wallet_retired', walletId: WALLET_ID, reason: 'reset', at },
      { type: 'relays_changed', relays: ['wss://relay.example.com'], at },
    ];
    for (const a of alerts) {
      expect(Alert.safeParse(a).success, a.type).toBe(true);
      expect(NotificationSchema.safeParse({ id, method: 'alert', params: a }).success).toBe(true);
    }
    expect(Alert.safeParse({ type: 'something_else', at }).success).toBe(false);
    expect(Alert.safeParse({ type: 'guardian_locked', reason: 'bored', at }).success).toBe(false);
    expect(Alert.safeParse({ type: 'wallet_retired', walletId: WALLET_ID, reason: 'stolen', at }).success).toBe(false);
    expect(Alert.safeParse({ type: 'daily_reminder', ...info, daysLeft: 6, at }).success).toBe(false); // renamed to recovery_reminder
  });

  it('every alert may carry atMs, the same moment as at in milliseconds', () => {
    const at = 1_800_000_000;
    const info = { recoveryId: 'rec-1', readyAt: at + 604800, survivingRole: 'app', amountSats: 100_000 };
    const alerts = [
      { type: 'recovery_started', ...info },
      { type: 'recovery_reminder', ...info, daysLeft: 6 },
      { type: 'recovery_ready', ...info },
      { type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy: 'app' },
      { type: 'recovery_completed', recoveryId: 'rec-1' },
      { type: 'guardian_locked', reason: 'manual' },
      { type: 'wallet_adopted', walletId: WALLET_ID, previousWalletId: 'fedcba9876543210', recoveryId: 'rec-1', hardwareConfirmRequired: false },
      { type: 'wallet_retired', walletId: WALLET_ID, reason: 'retired' },
    ];
    for (const a of alerts) {
      expect(Alert.safeParse({ ...a, at }).success, `${a.type} without atMs (older guardian)`).toBe(true);
      expect(Alert.safeParse({ ...a, at, atMs: at * 1000 + 250 }).success, `${a.type} with atMs`).toBe(true);
      expect(NotificationSchema.safeParse({ id, method: 'alert', params: { ...a, at, atMs: at * 1000 + 999 } }).success, a.type).toBe(true);
      expect(Alert.safeParse({ ...a, at, atMs: at }).success, `${a.type}: atMs in seconds`).toBe(false);
      expect(Alert.safeParse({ ...a, at, atMs: (at + 60) * 1000 }).success, `${a.type}: atMs a minute off`).toBe(false);
      expect(Alert.safeParse({ ...a, at, atMs: 1.5 }).success, `${a.type}: atMs fractional`).toBe(false);
    }
    const parsed = Alert.parse({ type: 'guardian_locked', at, atMs: at * 1000 + 7 });
    expect(parsed.atMs).toBe(at * 1000 + 7);
  });

  it('cancelledBy is app, contact or hardware', () => {
    const at = 1_800_000_000;
    for (const cancelledBy of ['app', 'contact', 'hardware']) {
      expect(Alert.safeParse({ type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy, at }).success).toBe(true);
    }
    for (const cancelledBy of ['phone', 'guardian', 'cosigner']) {
      expect(Alert.safeParse({ type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy, at }).success, cancelledBy).toBe(false);
    }
  });

  it('timestamps are unix seconds: a millisecond value is rejected', () => {
    expect(Alert.safeParse({ type: 'guardian_locked', at: Date.now() }).success).toBe(false);
    expect(Alert.safeParse({ type: 'guardian_locked', at: Math.floor(Date.now() / 1000) }).success).toBe(true);
  });
});

describe('error codes', () => {
  it('are unique and keep their published values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
    expect(ErrorCode.MethodNotFound).toBe(-32601);
    expect(ErrorCode.GuardianLocked).toBe(1100);
    expect(ErrorCode.ApprovalRequired).toBe(1201);
    expect(ErrorCode.TxNotFound).toBe(1600);
    expect(ErrorCode.BroadcastRejected).toBe(1601);
    expect(ErrorCode.ForeignTransaction).toBe(1602);
    expect(ErrorCode.TxTooLarge).toBe(1603);
    expect(ErrorCode.WalletRetired).toBe(1004);
    expect(ErrorCode.WalletNotWatched).toBe(1005);
    expect(ErrorCode.HardwareAuthUnconfirmed).toBe(1209);
    expect(ErrorCode.NodeRpcRequired).toBe(1700);
    expect(ErrorCode.SilentPaymentsNotRegistered).toBe(1701);
    expect(new RpcError(ErrorCode.NodeRpcRequired).message).toMatch(/BITCOIN_RPC_HOST/);
  });

  it('RpcError serialises to a wire error object', () => {
    expect(new RpcError(ErrorCode.GuardianLocked).toJSON()).toEqual({ code: 1100, message: 'Guardian is locked' });
    expect(new RpcError(1200, 'over limit', { limit: 5 }).toJSON()).toEqual({
      code: 1200,
      message: 'over limit',
      data: { limit: 5 },
    });
  });
});

describe('policy hashing', () => {
  it('canonical JSON sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it('hash ignores key order and contact order/case, and changes with content', () => {
    const reordered: Policy = {
      sweepFeeCapSats: policy.sweepFeeCapSats,
      recoveryDelayDays: policy.recoveryDelayDays,
      alertContacts: [CONTACT_A.toUpperCase(), CONTACT_B, CONTACT_A],
      dailyLimitSats: policy.dailyLimitSats,
    };
    expect(policyHash(reordered)).toBe(policyHash(policy));
    expect(policyHash(policy)).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHash({ ...policy, dailyLimitSats: 6 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, recoveryDelayDays: 14 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, sweepFeeCapSats: 1 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, alertContacts: [CONTACT_A] })).not.toBe(policyHash(policy));
  });

  it('normalizePolicy sorts and dedupes contacts and refuses anything the guardian would not enforce', () => {
    expect(normalizePolicy({ ...policy, alertContacts: [CONTACT_A, CONTACT_B, CONTACT_A] }).alertContacts).toEqual([CONTACT_A, CONTACT_B].sort());
    expect(() => normalizePolicy({ ...policy, perTxLimitSats: 5 } as unknown as PolicyType)).toThrow();
    expect(() => normalizePolicy({ ...policy, recoveryDelayDays: 10 } as unknown as PolicyType)).toThrow();
    expect(() => policyHash({ dailyLimitSats: 5, recoveryDelayDays: 7 } as unknown as PolicyType)).toThrow();
  });

  it('hashes the documented canonical JSON', () => {
    const p: PolicyType = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
    const json = `{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`;
    expect(canonicalJson(normalizePolicy(p))).toBe(json);
    expect(policyHash(p)).toBe(bytesToHex(sha256(utf8ToBytes(json))));
  });
});

describe('approval messages', () => {
  const ctx = { walletId: WALLET_ID, sequence: 4, expiresAt: 1_900_000_000 };

  it('formats the policy, cancel-recovery and resume-phone texts', () => {
    const hash = policyHash(policy);
    expect(approvalMessage({ action: 'policy', policy }, ctx)).toBe(
      `Trikey policy v1 wallet=${WALLET_ID} seq=4 limit=500000 delay=7d feecap=50000 contacts=2 hash=${hash} expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'cancel-recovery', recoveryId: '12-abcdefabcdef' }, ctx)).toBe(
      `Trikey cancel-recovery v1 wallet=${WALLET_ID} seq=4 recovery=12-abcdefabcdef expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'resume-phone' }, ctx)).toBe(`Trikey resume-phone v1 wallet=${WALLET_ID} seq=4 expires=2030-03-17T17:46:40Z`);
    expect(approvalMessage({ action: 'retire-wallet' }, ctx)).toBe(`Trikey retire-wallet v1 wallet=${WALLET_ID} seq=4 expires=2030-03-17T17:46:40Z`);
  });

  it('formats the recovery access text, bound to both nostr keys', () => {
    const msg = recoveryAccessMessage({ guardianPubkey: 'aa'.repeat(32), phonePubkey: 'bb'.repeat(32), expiresAt: 1_900_000_000 });
    expect(msg).toBe(`Trikey recovery-access v1 guardian=${'aa'.repeat(32)} phone=${'bb'.repeat(32)} expires=2030-03-17T17:46:40Z`);
    expect(msg.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
    expect(() => recoveryAccessMessage({ guardianPubkey: 'AA'.repeat(32), phonePubkey: 'bb'.repeat(32), expiresAt: 1 })).toThrow();
    expect(() => recoveryAccessMessage({ guardianPubkey: 'aa'.repeat(32), phonePubkey: 'bb'.repeat(32), expiresAt: -1 })).toThrow();
  });

  it('formats the pairing text', () => {
    expect(pairingMessage(WALLET_ID, '02' + 'cd'.repeat(32))).toBe(`Trikey pair v1 wallet=${WALLET_ID} guardian=02${'cd'.repeat(32)}`);
  });

  it('counts contacts after deduplication and stays within the length limit', () => {
    const msg = approvalMessage({ action: 'policy', policy: { ...policy, alertContacts: [CONTACT_A, CONTACT_A.toUpperCase()] } }, ctx);
    expect(msg).toContain(' contacts=1 ');
    const biggest: PolicyType = {
      dailyLimitSats: 2_100_000_000_000_000,
      recoveryDelayDays: 30,
      sweepFeeCapSats: 2_100_000_000_000_000,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
    };
    const long = approvalMessage({ action: 'policy', policy: biggest }, { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 });
    expect(long.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
  });

  it('refuses inputs that cannot form a signable message', () => {
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, sequence: 0 })).toThrow();
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, walletId: 'XYZ' })).toThrow();
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, expiresAt: -1 })).toThrow();
    expect(() => approvalMessage({ action: 'cancel-recovery', recoveryId: 'has space' }, ctx)).toThrow();
    expect(() => approvalMessage({ action: 'policy', policy: { ...policy, recoveryDelayDays: 3 } as unknown as PolicyType }, ctx)).toThrow();
  });
});
