/**
 * Unit tests: backup format, recovery codes, BIP 137, fee and limit
 * estimates, coin selection, refusal mapping, the software hardware wallet,
 * and the 1501 path where the guardian had not applied the change.
 */
import { describe, expect, it } from 'vitest';
import { base64, hex, utf8 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, buildSpend, cosignerKeyExpression, estimateVsize, keyExpressionFromMaster } from '@trikey/core';
import { ErrorCode, PublishError, RpcError, RpcTimeoutError, policyHash, type Policy } from '@trikey/protocol';
import {
  TrikeyWallet,
  WalletError,
  authKeyPath,
  deriveKey2,
  childPubkey,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openBackup,
  parseBackup,
  phoneMayApply,
  pickFeeRate,
  isWalletNotWatched,
  refusalFromError,
  sealBackup,
  sweepBroadcastError,
  selectAllCoins,
  selectCoins,
  spentTodayEstimate,
  verifyBip137Message,
  type BackupPayload,
  type GuardianRpc,
} from '../src/index.js';
import { signMessage } from '../src/bip137.js';
import { MemoryKeyValueStore, MemorySecureKeyStore, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, network } from './helpers.js';

const CHEAP = { m: 64, t: 1, p: 1 };
const PAYLOAD: BackupPayload = { v: 1, network: 'regtest', createdAt: 1_800_000_000, mnemonic: MNEMONICS.hardware2, deviceName: 'Unit phone' };

async function walletError(p: Promise<unknown> | (() => unknown)): Promise<WalletError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

describe('backup format', () => {
  const prf = new Uint8Array(32).fill(4);
  const prfSalt = new Uint8Array(32).fill(5);
  const seal = (code: string) =>
    sealBackup(PAYLOAD, [{ type: 'passkey-prf', credentialId: 'cred-1', prfSalt, prfOutput: prf }, { type: 'recovery-code', code, kdf: CHEAP }], { now: 1_800_000_000_000 });

  it('opens with the passkey PRF output or the recovery code, and holds nothing in the clear', async () => {
    const code = generateRecoveryCode();
    const sealed = await seal(code);
    expect(sealed.name).toMatch(/^trikey-backup-[0-9a-f]{32}\.tkb$/);
    expect(utf8.encode(sealed.bytes.slice(0, 4))).toBe('TKBK');
    expect(Buffer.from(sealed.bytes).toString('latin1')).not.toContain('legal');
    let asked: { credentialId: string; salt: Uint8Array } | undefined;
    const viaPasskey = await openBackup(sealed.bytes, {
      passkey: async (slot) => {
        asked = slot;
        return prf.slice();
      },
    });
    expect(viaPasskey.payload).toEqual(PAYLOAD);
    expect(asked?.credentialId).toBe('cred-1');
    expect(hex.encode(asked!.salt)).toBe(hex.encode(prfSalt));
    expect((await openBackup(sealed.bytes, { recoveryCode: code })).payload).toEqual(PAYLOAD);
  });

  it('refuses a wrong PRF output, a wrong code, and a missing slot', async () => {
    const code = generateRecoveryCode();
    const sealed = await seal(code);
    expect((await walletError(openBackup(sealed.bytes, { passkey: async () => new Uint8Array(32).fill(9) }))).code).toBe('backup_wrong_secret');
    expect((await walletError(openBackup(sealed.bytes, { recoveryCode: generateRecoveryCode() }))).code).toBe('backup_wrong_secret');
    const onlyCode = await sealBackup(PAYLOAD, [{ type: 'recovery-code', code, kdf: CHEAP }], { now: 0 });
    expect((await walletError(openBackup(onlyCode.bytes, { passkey: async () => prf }))).code).toBe('backup_wrong_secret');
  });

  it('authenticates the header: no field can be changed, and slots cannot be moved between backups', async () => {
    const code = generateRecoveryCode();
    const a = await seal(code);
    const b = await seal(code);
    const pa = parseBackup(a.bytes);
    const pb = parseBackup(b.bytes);
    // b's header (same code, so its slot opens) on a's ciphertext.
    const spliced = new Uint8Array([...pb.aad, ...pa.ciphertext]);
    expect((await walletError(openBackup(spliced, { recoveryCode: code }))).code).toBe('backup_invalid');
    // a's slots inside b's header: the slot unwraps nothing (bound to a's id).
    const headerB = JSON.parse(utf8.encode(pb.aad.slice(9)));
    headerB.slots = JSON.parse(utf8.encode(pa.aad.slice(9))).slots;
    const hb = new TextEncoder().encode(JSON.stringify(headerB));
    const moved = new Uint8Array([...pb.aad.slice(0, 5), 0, 0, (hb.length >> 8) & 0xff, hb.length & 0xff, ...hb, ...pb.ciphertext]);
    expect((await walletError(openBackup(moved, { recoveryCode: code }))).code).toBe('backup_wrong_secret');
    // Dropping the passkey slot changes the header, so the payload no longer authenticates.
    const headerA = JSON.parse(utf8.encode(pa.aad.slice(9)));
    headerA.slots = headerA.slots.filter((s: { type: string }) => s.type === 'recovery-code');
    const ha = new TextEncoder().encode(JSON.stringify(headerA));
    const dropped = new Uint8Array([...pa.aad.slice(0, 5), 0, 0, (ha.length >> 8) & 0xff, ha.length & 0xff, ...ha, ...pa.ciphertext]);
    expect((await walletError(openBackup(dropped, { recoveryCode: code }))).code).toBe('backup_invalid');
  });

  it('refuses unknown versions, garbage and absurd KDF costs before any work', async () => {
    const code = generateRecoveryCode();
    const a = await seal(code);
    const v9 = a.bytes.slice();
    v9[4] = 9;
    expect(() => parseBackup(v9)).toThrow(/unsupported version/);
    expect(() => parseBackup(new Uint8Array(40))).toThrow(/magic/);
    const p = parseBackup(a.bytes);
    const h = JSON.parse(utf8.encode(p.aad.slice(9)));
    h.slots[1].kdf.m = 4 * 1024 * 1024; // 4 GiB
    const hb = new TextEncoder().encode(JSON.stringify(h));
    const heavy = new Uint8Array([...p.aad.slice(0, 5), 0, 0, (hb.length >> 8) & 0xff, hb.length & 0xff, ...hb, ...p.ciphertext]);
    expect(() => parseBackup(heavy)).toThrow(WalletError);
  });
});

describe('recovery codes', () => {
  it('are 25 Crockford base32 characters in groups of five, with a check character', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(generateRecoveryCode()).not.toBe(code);
    const data = normalizeRecoveryCode(code);
    expect(data).toHaveLength(24);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(data);
    const withO = code.replace(/0/g, 'O');
    expect(normalizeRecoveryCode(withO)).toBe(data);
  });

  it('catch typos before running the KDF', () => {
    const code = generateRecoveryCode();
    expect(() => normalizeRecoveryCode(code.slice(0, -1))).toThrow(/25/);
    expect(() => normalizeRecoveryCode(code.replace(/.$/, 'U'))).toThrow();
  });

  it('catch every single-character typo and nearly every swap of neighbours', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let round = 0; round < 20; round++) {
      const chars = generateRecoveryCode().replace(/-/g, '');
      for (let i = 0; i < chars.length; i++) {
        for (const c of alphabet) {
          if (c === chars[i]) continue;
          const typo = chars.slice(0, i) + c + chars.slice(i + 1);
          expect(() => normalizeRecoveryCode(typo), `${chars} position ${i} as ${c}`).toThrow(/typo/);
        }
      }
      for (let i = 0; i < chars.length - 1; i++) {
        const a = chars[i]!;
        const b = chars[i + 1]!;
        if (a === b || (a === '0' && b === 'Z') || (a === 'Z' && b === '0')) continue;
        const swapped = chars.slice(0, i) + b + a + chars.slice(i + 2);
        expect(() => normalizeRecoveryCode(swapped), `${chars} swap at ${i}`).toThrow(/typo/);
      }
    }
  });
});

describe('BIP 137', () => {
  it('verifies against the compressed key, and nothing else', () => {
    const priv = new Uint8Array(32).fill(3);
    const pub = secp256k1.getPublicKey(priv, true);
    const sig = signMessage('Trikey resume-phone v1 wallet=0123456789abcdef seq=1 expires=2030-01-01T00:00:00Z', priv);
    expect(verifyBip137Message('Trikey resume-phone v1 wallet=0123456789abcdef seq=1 expires=2030-01-01T00:00:00Z', pub, sig)).toBe(true);
    expect(verifyBip137Message('Trikey resume-phone v1 wallet=0123456789abcdef seq=2 expires=2030-01-01T00:00:00Z', pub, sig)).toBe(false);
    expect(verifyBip137Message('x', secp256k1.getPublicKey(new Uint8Array(32).fill(4), true), signMessage('x', priv))).toBe(false);
    for (const header of ['p2wpkh', 'p2sh-p2wpkh'] as const) expect(verifyBip137Message('x', pub, signMessage('x', priv, header))).toBe(true);
    const raw = base64.decode(sig);
    raw[0] = 27; // uncompressed-key header
    expect(verifyBip137Message('x', pub, base64.encode(raw))).toBe(false);
    expect(verifyBip137Message('x', pub, 'not base64')).toBe(false);
  });
});

describe('keys and paths', () => {
  it('the authorization key is the hardware key at <account>/0/0, derived from the account xpub', () => {
    expect(authKeyPath(network)).toBe("m/48'/1'/0'/2'/0/0");
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONICS.hardware), network.bip32);
    const xpub = master.derive("m/48'/1'/0'/2'").publicExtendedKey;
    expect(hex.encode(childPubkey(xpub, "m/48'/1'/0'/2'", authKeyPath(network), network))).toBe(hex.encode(master.derive("m/48'/1'/0'/2'/0/0").publicKey!));
    expect(() => childPubkey(xpub, "m/48'/1'/0'/2'", "m/84'/1'/0'/0/0", network)).toThrow(/not below/);
    expect(() => childPubkey(xpub, "m/48'/1'/0'/2'", "m/48'/1'/0'/2'/0'/0", network)).toThrow(/hardened/);
  });
});

describe('fees, limit estimate and coin selection', () => {
  it('picks the target estimate, else a slower one, else the relay floor', () => {
    const fees = { estimates: [{ target: 1, satPerVb: 30 }, { target: 3, satPerVb: null }, { target: 6, satPerVb: 8.25 }], minRelaySatPerVb: 1 };
    expect(pickFeeRate(fees, 'fast')).toBe(30);
    expect(pickFeeRate(fees, 'normal')).toBe(8.25);
    expect(pickFeeRate({ estimates: [{ target: 1, satPerVb: null }], minRelaySatPerVb: 1.5 }, 'fast')).toBe(1.5);
    expect(pickFeeRate({ estimates: [{ target: 6, satPerVb: 0.5 }], minRelaySatPerVb: 1 }, 'slow')).toBe(1);
    expect(pickFeeRate(undefined)).toBe(1);
  });

  it('estimates spending from the guardian count plus what it co-signed since', () => {
    const now = 1_800_000_000_000;
    const spends = [
      { txid: 'a', at: now - 25 * 3_600_000, outflowSats: 1000 },
      { txid: 'b', at: now - 3_600_000, outflowSats: 2000 },
      { txid: 'c', at: now - 60_000, outflowSats: 300 },
    ];
    expect(spentTodayEstimate({ spends }, now)).toBe(2300);
    const gs = { checkedAt: now - 30 * 60_000, state: 'unlocked' as const, paired: true, phoneSpending: 'enabled' as const, activeRecoveryId: null, nextHardwareSequence: 1, dailyLimit: { limitSats: 10_000, usedSats: 5000, availableSats: 5000 } };
    expect(spentTodayEstimate({ spends, guardianStatus: gs }, now)).toBe(5300);
    expect(spentTodayEstimate({ spends, guardianStatus: { ...gs, checkedAt: now - 2 * 86_400_000 } }, now)).toBe(2300);
  });

  it('selects confirmed coins first and refuses dust, bad addresses and too little money', async () => {
    const master = (m: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(m), network.bip32);
    const wallet = new MultisigWallet(network, {
      app: keyExpressionFromMaster(master(MNEMONICS.hardware2), "m/48'/1'/0'/2'"),
      hardware: keyExpressionFromMaster(master(MNEMONICS.hardware), "m/48'/1'/0'/2'"),
      cosigner: cosignerKeyExpression(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), new Uint8Array(32).fill(1), network),
    });
    const u = (value: number, confirmations: number, vout: number) => ({ txid: 'ab'.repeat(32), vout, valueSats: value, height: confirmations ? 100 : 0, confirmations, chain: 0 as const, index: vout });
    const utxos = [u(50_000, 0, 0), u(30_000, 3, 1), u(40_000, 1, 2)];
    const base = { wallet, utxos, address: externalAddress(), feeRate: 2, changeIndex: 0 };
    const sel = selectCoins({ ...base, amountSats: 60_000 });
    expect(sel.inputs.map((i) => i.vout).sort()).toEqual([1, 2]); // the unconfirmed 50k is left alone
    expect(selectCoins({ ...base, amountSats: 100_000 }).inputs).toHaveLength(3);
    expect((await walletError(() => selectCoins({ ...base, amountSats: 130_000 }))).code).toBe('insufficient_funds');
    expect((await walletError(() => selectCoins({ ...base, amountSats: 100 }))).code).toBe('amount_too_small');
    expect((await walletError(() => selectCoins({ ...base, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amountSats: 10_000 }))).code).toBe('invalid_address');
    void buildSpend;
  });

  it('send max takes every confirmed coin, charges the fee buildSpend would and leaves the rest as the amount', async () => {
    const u = (value: number, confirmations: number, vout: number) => ({ txid: 'ab'.repeat(32), vout, valueSats: value, height: confirmations ? 100 : 0, confirmations, chain: 0 as const, index: vout });
    const outputScript = btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress()));
    const utxos = [u(50_000, 0, 0), u(30_000, 3, 1), u(40_000, 1, 2)];
    const sel = selectAllCoins({ utxos, outputScript, feeRate: 2 });
    // The unconfirmed coin is left alone, as `selectCoins` leaves it.
    expect(sel.inputs.map((i) => i.vout).sort()).toEqual([1, 2]);
    expect(sel.feeSats).toBe(Math.ceil(estimateVsize(2, [outputScript]) * 2));
    expect(sel.amountSats).toBe(70_000 - sel.feeSats);
    // Only when the confirmed ones cannot make a payment above dust do the unconfirmed ones join, as in `selectCoins`.
    expect(selectAllCoins({ utxos: [u(50_000, 0, 0), u(700, 2, 1)], outputScript, feeRate: 2 }).inputs).toHaveLength(2);
    // The fee follows the rate and the number of coins, and the amount plus the fee is always everything spent.
    for (const rate of [1, 7.5, 40]) {
      const r = selectAllCoins({ utxos: [u(90_000, 5, 0), u(10_000, 5, 1), u(546, 5, 2)], outputScript, feeRate: rate });
      expect(r.inputs).toHaveLength(3);
      expect(r.amountSats + r.feeSats).toBe(100_546);
    }
    expect((await walletError(() => selectAllCoins({ utxos: [], outputScript, feeRate: 2 }))).code).toBe('nothing_to_send');
    // Dust: 1,000 sats at 2 sat/vB cost 2 * (11 + 105 + 31) = 294 in fees, leaving 706 (fine); at 5 sat/vB 735 leaves 265 (below dust).
    expect(selectAllCoins({ utxos: [u(1000, 1, 0)], outputScript, feeRate: 2 }).amountSats).toBe(706);
    const tooSmall = await walletError(() => selectAllCoins({ utxos: [u(1000, 1, 0)], outputScript, feeRate: 5 }));
    expect(tooSmall.code).toBe('send_max_too_small');
    expect(tooSmall.feeSats).toBe(735);
    // A balance the fee eats whole is the same refusal, not a negative amount.
    expect((await walletError(() => selectAllCoins({ utxos: [u(600, 1, 0)], outputScript, feeRate: 10 }))).code).toBe('send_max_too_small');
  });

  it('lets the phone alone only tighten', () => {
    const p: Policy = { dailyLimitSats: 100, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 10 };
    expect(phoneMayApply(p, { ...p, dailyLimitSats: 50 })).toBe(true);
    expect(phoneMayApply(p, { ...p, recoveryDelayDays: 30, dailyLimitSats: 0 })).toBe(true);
    expect(phoneMayApply(p, { ...p, dailyLimitSats: 101 })).toBe(false);
    expect(phoneMayApply({ ...p, recoveryDelayDays: 14 }, p)).toBe(false);
    expect(phoneMayApply(p, { ...p, sweepFeeCapSats: 5 })).toBe(false);
    expect(phoneMayApply(p, { ...p, alertContacts: ['ab'.repeat(32)] })).toBe(false);
  });
});

describe('guardian refusals', () => {
  it('map to typed results', () => {
    expect(refusalFromError(new RpcError(ErrorCode.PolicyViolation, 'over', { reason: 'over_daily_limit', limit: 100, used: 90, outflow: 20, wouldUse: 110 }))).toMatchObject({
      kind: 'over_daily_limit',
      limitSats: 100,
      usedSats: 90,
      neededSats: 20,
    });
    expect(refusalFromError(new RpcError(ErrorCode.PolicyViolation, 'cap', { reason: 'sweep_fee_exceeds_cap' }))).toMatchObject({ kind: 'policy_violation', reason: 'sweep_fee_exceeds_cap' });
    expect(refusalFromError(new RpcError(ErrorCode.GuardianLocked))).toMatchObject({ kind: 'guardian_locked' });
    expect(refusalFromError(new RpcError(ErrorCode.RecoveryAlreadyActive, 'r', { recoveryId: '1-abc' }))).toMatchObject({ kind: 'recovery_in_progress', recoveryId: '1-abc' });
    expect(refusalFromError(new RpcError(ErrorCode.PhoneSpendingPaused, 'p', { cause: 'wallet_retired' }))).toMatchObject({ kind: 'phone_spending_paused', cause: 'wallet_retired' });
    expect(refusalFromError(new RpcError(ErrorCode.UnlockFailed, 'u', { retryAfterSeconds: 4 }))).toMatchObject({ kind: 'unlock_failed', retryAfterSeconds: 4 });
    expect(refusalFromError(new RpcError(ErrorCode.ForeignTransaction))).toMatchObject({ kind: 'foreign_transaction' });
    expect(refusalFromError(new RpcError(1999, 'new'))).toMatchObject({ kind: 'other', code: 1999 });
    expect(refusalFromError(new RpcTimeoutError('sign', 10))).toMatchObject({ kind: 'unreachable' });
    expect(refusalFromError(new PublishError([]))).toMatchObject({ kind: 'unreachable' });
    expect(refusalFromError(new Error('boom'))).toBeUndefined();
  });

  it('keep the details of a sweep refusal: the fee and cap, the rule that failed, the wait', () => {
    expect(refusalFromError(new RpcError(ErrorCode.PolicyViolation, 'cap', { reason: 'sweep_fee_exceeds_cap', fee: 41_000, cap: 20_000 }))).toMatchObject({
      kind: 'policy_violation',
      reason: 'sweep_fee_exceeds_cap',
      feeSats: 41_000,
      capSats: 20_000,
    });
    expect(refusalFromError(new RpcError(ErrorCode.ForeignTransaction, 'f', { reason: 'output_not_to_wallet' }))).toMatchObject({ kind: 'foreign_transaction', reason: 'output_not_to_wallet' });
    expect(refusalFromError(new RpcError(ErrorCode.RateLimited, 'r', { retryAfterSeconds: 30 }))).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('1005 reads as "nothing watched"', () => {
    expect(isWalletNotWatched(new RpcError(ErrorCode.WalletNotWatched))).toBe(true);
    expect(isWalletNotWatched(new WalletError('guardian_refused', 'x', { refusal: { kind: 'other', code: ErrorCode.WalletNotWatched, message: 'x' } }))).toBe(true);
    expect(isWalletNotWatched(new RpcError(ErrorCode.TxNotFound))).toBe(false);
    expect(isWalletNotWatched(new Error('boom'))).toBe(false);
  });

  it('a sweep broadcast refusal becomes a typed wallet error only when it is final', () => {
    const cap = sweepBroadcastError(new RpcError(ErrorCode.PolicyViolation, 'cap', { reason: 'sweep_fee_exceeds_cap', fee: 41_000, cap: 20_000 }))!;
    expect(cap).toMatchObject({ code: 'sweep_fee_exceeds_cap', feeSats: 41_000, capSats: 20_000 });
    expect(cap.message).toMatch(/41,000 sats in fees, over the 20,000 sats cap/);
    expect(cap.message).toMatch(/hardware wallet/);
    expect(sweepBroadcastError(new RpcError(ErrorCode.PolicyViolation, 'cap', { reason: 'sweep_fee_exceeds_cap' }))).toMatchObject({ code: 'sweep_fee_exceeds_cap' });
    for (const reason of ['too_many_inputs', 'too_many_outputs', 'input_not_from_replaced_wallet', 'output_not_to_wallet', 'outputs_exceed_inputs', 'a_new_rule']) {
      const e = sweepBroadcastError(new RpcError(ErrorCode.ForeignTransaction, 'f', { reason }))!;
      expect(e).toMatchObject({ code: 'sweep_refused', reason });
      expect(e.message).toMatch(/Nothing was sent/);
    }
    expect(sweepBroadcastError(new RpcError(ErrorCode.RateLimited, 'r', { retryAfterSeconds: 31.2 }))).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 31.2 });
    expect(sweepBroadcastError(new RpcError(ErrorCode.RateLimited, 'r'))!.message).toMatch(/Wait a moment/);
    // Not final: the guardian does not watch the wallet (older guardians say 1602 with no reason), the node is down, the node refused it.
    expect(sweepBroadcastError(new RpcError(ErrorCode.ForeignTransaction))).toBeUndefined();
    expect(sweepBroadcastError(new RpcError(ErrorCode.ForeignTransaction, 'f', { reason: 'spends_no_wallet_coin' }))).toBeUndefined();
    expect(sweepBroadcastError(new RpcError(ErrorCode.Unavailable))).toBeUndefined();
    expect(sweepBroadcastError(new RpcTimeoutError('tx.broadcast', 10))).toBeUndefined();
    expect(sweepBroadcastError(new RpcError(ErrorCode.BroadcastRejected, 'no', { reason: 'min relay fee not met' }))).toBeUndefined();
    expect(sweepBroadcastError(new Error('boom'))).toBeUndefined();
    // A refusal already wrapped by the chain source is read the same way.
    const wrapped = new WalletError('guardian_refused', 'tx.broadcast: no', { refusal: { kind: 'foreign_transaction', reason: 'output_not_to_wallet', message: 'no' } });
    expect(sweepBroadcastError(wrapped)).toMatchObject({ code: 'sweep_refused', reason: 'output_not_to_wallet' });
  });
});

describe('software hardware wallet', () => {
  it('refuses mainnet, other coin types, and signing for a wallet it has not registered', async () => {
    expect(() => new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'bitcoin' })).toThrow();
    const dev = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
    await expect(dev.getXpub("m/48'/0'/0'/2'")).rejects.toThrow(/coin type/);
    await expect(dev.signMessage("m/84'/0'/0'/0/0", 'x')).rejects.toThrow(/coin type/);
    const master = (m: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(m), network.bip32);
    const wallet = new MultisigWallet(network, {
      app: keyExpressionFromMaster(master(MNEMONICS.hardware2), "m/48'/1'/0'/2'"),
      hardware: keyExpressionFromMaster(master(MNEMONICS.hardware), "m/48'/1'/0'/2'"),
      cosigner: cosignerKeyExpression(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), new Uint8Array(32).fill(1), network),
    });
    const policy = { name: 'Trikey test', descriptor: wallet.descriptor() };
    await expect(dev.displayAddress(policy, 0, 0)).rejects.toThrow(/not registered/);
    const { hmac } = await dev.registerWallet(policy);
    expect(await dev.displayAddress({ ...policy, registration: { hmac: hmac! } }, 0, 3)).toBe(wallet.derive(0, 3).address);
    await expect(dev.registerWallet({ name: 'x'.repeat(17), descriptor: wallet.descriptor() })).rejects.toThrow(/16/);
  });
});

describe('chain data from the guardian is checked', () => {
  it('refuses to sign when a coin is reported at another derivation index than its previous transaction pays', async () => {
    const m = 'vessel ladder alter error federal sibling chat ability sun glass valve picture'; // published BIP 39 test vector
    const app = deriveKey2(m, network).account;
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONICS.hardware), network.bip32);
    const wallet = new MultisigWallet(network, {
      app,
      hardware: keyExpressionFromMaster(master, "m/48'/1'/0'/2'"),
      cosigner: cosignerKeyExpression(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), new Uint8Array(32).fill(1), network),
    });
    // A funding transaction paying index 0, which the "guardian" claims is at index 1.
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: new Uint8Array(32).fill(1), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
      outputs: [{ script: wallet.derive(0, 0).script, amount: 100_000n }],
      lockTime: 0,
    });
    const txHex = hex.encode(raw);
    const txid = btc.Transaction.fromRaw(raw, { allowUnknownInputs: true }).id;
    const signLoads: string[] = [];
    const fake: GuardianRpc = {
      publicKey: 'ab'.repeat(32),
      start: async () => {},
      close: () => {},
      onAlert: () => () => {},
      call: (async (method: string) => {
        if (method === 'guardian.status')
          return { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: 't', time: 1 };
        if (method === 'fees.estimate') return { estimates: [{ target: 3, satPerVb: 2 }], minRelaySatPerVb: 1 };
        if (method === 'tx.get') return { txHex };
        if (method === 'wallet.sync')
          return {
            tipHeight: 10,
            tipHash: 'cd'.repeat(32),
            utxos: [{ txid, vout: 0, valueSats: 100_000, height: 9, confirmations: 2, chain: 0, index: 1 }],
            utxosTruncated: false,
            balance: { confirmedSats: 100_000, unconfirmedSats: 0 },
            history: [],
            historyTruncated: false,
            nextReceiveIndex: 2,
            nextChangeIndex: 0,
            gapLimit: 20,
          };
        throw new Error(`unexpected ${method}`);
      }) as GuardianRpc['call'],
    };
    const secure = new MemorySecureKeyStore();
    const deps = { network: 'regtest' as const, secureStore: secure, store: new MemoryKeyValueStore(), relayPool: () => ({}) as any, createRpc: () => fake };
    const w = await TrikeyWallet.create(deps, { mnemonic: m });
    await (w as any).update((s: any) => {
      s.stage = 'paired';
      s.guardian = { pubkey: 'cd'.repeat(32), relays: ['ws://127.0.0.1:1'], key: { fingerprint: 'deadbeef', path: "m/48'/1'/0'/2'", xpub: wallet.keys.cosigner.xpub } };
      s.wallet = { descriptor: wallet.descriptor(), walletId: wallet.fingerprint(), pairedAt: 0 };
      s.rules = { policy: { dailyLimitSats: 1_000_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 }, policyHash: 'ab'.repeat(32), nextHardwareSequence: 1, fetchedAt: 0 };
    });
    await w.start();
    await w.sync();
    const e = await walletError(w.send({ address: externalAddress(), amountSats: 10_000 }));
    expect(e.code).toBe('guardian_mismatch');
    expect(e.message).toMatch(/does not match/);
    // Key 2 was never unlocked.
    expect(secure.loads.filter((l) => l.biometric)).toHaveLength(0);
    void signLoads;
  });
});

describe('restart safety', () => {
  it('on 1501, re-reads the guardian and sends a NEW request if the change is not there', async () => {
    const calls: { method: string; id?: string }[] = [];
    let policy: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
    const fake: GuardianRpc = {
      publicKey: 'ab'.repeat(32),
      start: async () => {},
      close: () => {},
      onAlert: () => () => {},
      call: (async (method: string, params: any, opts?: { id?: string }) => {
        calls.push({ method, id: opts?.id });
        if (method === 'policy.get') return { policy, policyHash: policyHash(policy), nextHardwareSequence: 1 };
        if (method === 'guardian.status')
          return { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: 't', time: 1 };
        if (method === 'policy.update') {
          if (calls.filter((c) => c.method === 'policy.update').length === 1) throw new RpcError(ErrorCode.Unavailable);
          policy = params.policy;
          return { policy, policyHash: policyHash(policy), nextHardwareSequence: 1 };
        }
        throw new Error(`unexpected ${method}`);
      }) as GuardianRpc['call'],
    };
    const secure = new MemorySecureKeyStore();
    const kv = new MemoryKeyValueStore();
    const deps = { network: 'regtest' as const, secureStore: secure, store: kv, relayPool: () => ({}) as any, createRpc: () => fake };
    const w = await TrikeyWallet.create(deps);
    await (w as any).update((s: any) => {
      s.stage = 'paired';
      s.guardian = { pubkey: 'cd'.repeat(32), relays: ['ws://127.0.0.1:1'], key: s.key2 };
      s.wallet = { descriptor: 'unused', walletId: '0123456789abcdef', pairedAt: 0 };
    });
    const r = await w.setDailyLimit(50_000);
    expect(r).toMatchObject({ approvedBy: 'phone', policy: { dailyLimitSats: 50_000 } });
    const updates = calls.filter((c) => c.method === 'policy.update');
    expect(updates).toHaveLength(2);
    expect(updates[0]!.id).not.toBe(updates[1]!.id);
    expect(w.state.pending).toBeUndefined();
  });
});
