/**
 * The refill chain: transactions pre-signed by phone + hardware that move a
 * fixed amount from the vault to the spending balance, at most one per period.
 *
 *   vault coins ──► refill 1 ──► refill 2 ──► refill 3 ──► …
 *                    │ out 0       │ out 0       │ out 0     to the spending balance (phone key only)
 *                    └ out 1 ──────┘ out 1 ──────┘ out 1     the rest, back to the vault
 *
 * - Refill k (k > 1) spends output 1 of refill k-1 with nSequence = `period`
 *   (BIP 68, blocks), so it cannot be mined until `period` blocks after refill
 *   k-1 confirmed. Whoever holds the signed chain, at most one refill
 *   confirms per period.
 * - The first refill of a batch spends the vault coins with no relative lock
 *   (nSequence 0xfffffffd), except an input that is an earlier refill's
 *   output 1, which gets nSequence = `period` like any other link. When the
 *   last refill to confirm is less than a period old, the first refill also
 *   carries nLockTime = lastRefillHeight + period - 1, so a new batch cannot
 *   be used to get a second refill inside the same period either.
 * - All inputs are segwit v0, so every txid is known before anything is
 *   signed or broadcast and the whole chain can be built at once.
 * - Fees are fixed at signing (`fees.ts`); output 0 lets the phone add a CPFP child.
 *
 * `verifyRefillChain` re-checks a stored chain from the raw signed
 * transactions alone: links, sequences, lock times, amounts, fees, output
 * scripts and every signature.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { CHANGE, LOCKTIME_THRESHOLD, ROLES, SEQUENCE_RBF, TX_OPTS, encodeRelativeBlocks, type MultisigWallet, type Role } from '@trikey/core';
import { equalBytes } from '@scure/btc-signer/utils.js';
import { DUST_SATS, feeForRate, refillVsize } from './fees.js';
import { ScriptError, decodeRawTx, txidOf, verifyP2wshMultisig, vsizeOf } from './script-verify.js';
import { SPENDING_INTERNAL, type SpendingAccount } from './spending.js';
import { RecoveryKeyError } from './errors.js';

export const REFILL_SPEND_VOUT = 0;
export const REFILL_CHANGE_VOUT = 1;
export const DEFAULT_REFILL_SATS = 200_000n;
export const DEFAULT_REFILL_COUNT = 8;
/** About one week. */
export const DEFAULT_PERIOD_BLOCKS = 1008;
export const MIN_REFILL_SATS = 10_000n;
export const MAX_REFILLS_PER_BATCH = 52;
/** The vault never drops below this through refills (keeps the last change output well above dust). */
export const MIN_VAULT_REMAINDER_SATS = 10_000n;

/** A vault coin, with its funding transaction (checked against `txid`), which hardware wallets need. */
export interface VaultCoin {
  txid: string;
  vout: number;
  value: bigint;
  chain: number;
  index: number;
  prevTxHex: string;
}

export interface RefillInput {
  txid: string;
  vout: number;
  valueSats: number;
  chain: number;
  index: number;
  sequence: number;
}

/** One refill as stored: the raw signed transaction plus what it is supposed to be. */
export interface StoredRefill {
  /** 1-based position in the chain. */
  position: number;
  txid: string;
  /** Fully signed raw transaction. */
  txHex: string;
  inputs: RefillInput[];
  lockTime: number;
  feeSats: number;
  /** Output 0 pays the spending balance's internal address at this index. */
  spendIndex: number;
  /** Output 1 pays the vault's change address at this index. */
  changeIndex: number;
  changeValueSats: number;
}

export interface RefillBatch {
  id: string;
  createdAt: number;
  /** Tip height when the batch was signed. */
  createdHeight: number;
  /** Positions this batch added. */
  from: number;
  to: number;
  feeRate: number;
}

/** A refill chain: one or more batches, each extending the last. */
export interface RefillChainRecord {
  id: string;
  /** The vault descriptor the chain spends from. */
  descriptor: string;
  amountSats: number;
  periodBlocks: number;
  refills: StoredRefill[];
  batches: RefillBatch[];
}

export interface RefillParams {
  amount: bigint;
  count: number;
  periodBlocks: number;
  /** sat/vB the refills are signed at. */
  feeRate: number;
  /** Refuse a refill whose fee would be higher. Default: 5% of `amount`. */
  maxFee?: bigint;
}

/** Where the first refill of a new batch starts. */
export interface ChainHead {
  inputs: VaultCoin[];
  /** nSequence for each input (SEQUENCE_RBF, or `period` for an earlier refill's output 1). */
  sequences: number[];
  lockTime: number;
}

export interface UnsignedRefill {
  position: number;
  psbt: Uint8Array;
  txid: string;
  /** The transaction without signatures: the same txid, and what the next refill's `nonWitnessUtxo` needs. */
  unsignedTxHex: string;
  inputs: RefillInput[];
  lockTime: number;
  amount: bigint;
  fee: bigint;
  vsize: number;
  spend: { index: number; address: string };
  change: { index: number; address: string; value: bigint };
}

export function checkRefillParams(p: RefillParams): void {
  if (p.amount < MIN_REFILL_SATS) throw new RecoveryKeyError('amount_too_small', `A refill must be at least ${MIN_REFILL_SATS} sats.`);
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > MAX_REFILLS_PER_BATCH) throw new RangeError(`1 to ${MAX_REFILLS_PER_BATCH} refills per batch`);
  encodeRelativeBlocks(p.periodBlocks);
}

/** How many refills of `amount` at `feeRate` a vault balance can pay for. */
export function maxRefills(total: bigint, amount: bigint, feeRate: number, firstInputs = 1): number {
  let left = total;
  let n = 0;
  while (n < MAX_REFILLS_PER_BATCH) {
    const fee = feeForRate(feeRate, refillVsize(n === 0 ? firstInputs : 1));
    if (left - amount - fee < MIN_VAULT_REMAINDER_SATS) break;
    left -= amount + fee;
    n++;
  }
  return n;
}

/**
 * Builds `params.count` unsigned refills from `head`. `spendIndices` and
 * `changeIndices` are the spending-internal and vault-change address indices
 * reserved for them, one each per refill.
 *
 * TODO: core's buildSpend and buildSweep now take `sequence` and `lockTime`
 * (packages/core/src/psbt.ts). This builder is not a drop-in swap for them: it
 * chains each refill's change into the next, sets the fee itself and takes its
 * own change indices.
 */
export function buildRefillChain(opts: {
  vault: MultisigWallet;
  spending: SpendingAccount;
  head: ChainHead;
  params: RefillParams;
  startPosition: number;
  spendIndices: number[];
  changeIndices: number[];
}): UnsignedRefill[] {
  const { vault, spending, head, params } = opts;
  checkRefillParams(params);
  if (!head.inputs.length) throw new RecoveryKeyError('insufficient_funds', 'The vault has no coins to refill from.');
  if (head.sequences.length !== head.inputs.length) throw new Error('one sequence per head input');
  if (opts.spendIndices.length !== params.count || opts.changeIndices.length !== params.count) throw new Error('one spend and one change index per refill');
  if (head.lockTime < 0 || head.lockTime >= LOCKTIME_THRESHOLD) throw new RangeError('the first refill takes a height lock time');
  const linkSeq = encodeRelativeBlocks(params.periodBlocks);
  for (const s of head.sequences) if (s !== SEQUENCE_RBF && s !== linkSeq) throw new RangeError(`unexpected head sequence ${s}`);
  const maxFee = params.maxFee ?? params.amount / 20n;

  const out: UnsignedRefill[] = [];
  let prev: { txid: string; unsignedTxHex: string; value: bigint; changeIndex: number } | undefined;
  for (let k = 0; k < params.count; k++) {
    const tx = new btc.Transaction({ ...TX_OPTS, version: 2, lockTime: k === 0 ? head.lockTime : 0 });
    const inputs: RefillInput[] = [];
    let total = 0n;
    if (k === 0) {
      head.inputs.forEach((c, i) => {
        const d = vault.derive(c.chain, c.index);
        tx.addInput({
          txid: c.txid,
          index: c.vout,
          sequence: head.sequences[i]!,
          witnessUtxo: { script: d.script, amount: c.value },
          nonWitnessUtxo: hex.decode(c.prevTxHex),
          sighashType: btc.SigHash.ALL,
          ...vault.psbtFields(d),
        });
        inputs.push({ txid: c.txid, vout: c.vout, valueSats: Number(c.value), chain: c.chain, index: c.index, sequence: head.sequences[i]! });
        total += c.value;
      });
    } else {
      const d = vault.derive(CHANGE, prev!.changeIndex);
      tx.addInput({
        txid: prev!.txid,
        index: REFILL_CHANGE_VOUT,
        sequence: linkSeq,
        witnessUtxo: { script: d.script, amount: prev!.value },
        nonWitnessUtxo: hex.decode(prev!.unsignedTxHex),
        sighashType: btc.SigHash.ALL,
        ...vault.psbtFields(d),
      });
      inputs.push({ txid: prev!.txid, vout: REFILL_CHANGE_VOUT, valueSats: Number(prev!.value), chain: CHANGE, index: prev!.changeIndex, sequence: linkSeq });
      total = prev!.value;
    }
    const vsize = refillVsize(inputs.length);
    const fee = feeForRate(params.feeRate, vsize);
    if (fee > maxFee) throw new RecoveryKeyError('fee_too_high', `A refill would pay ${fee} sats in fees, more than the ${maxFee} allowed.`);
    const changeValue = total - params.amount - fee;
    if (changeValue < MIN_VAULT_REMAINDER_SATS || changeValue < DUST_SATS)
      throw new RecoveryKeyError('insufficient_funds', `The vault can pay for ${k} refill(s) of ${params.amount} sats, not ${params.count}.`, {
        detail: { maxCount: k },
      });
    const spend = spending.derive(SPENDING_INTERNAL, opts.spendIndices[k]!);
    const change = vault.derive(CHANGE, opts.changeIndices[k]!);
    tx.addOutput({ script: spend.script, amount: params.amount });
    tx.addOutput({ script: change.script, amount: changeValue, ...vault.psbtFields(change) });
    const unsignedTxHex = hex.encode(tx.unsignedTx);
    out.push({
      position: opts.startPosition + k,
      psbt: tx.toPSBT(),
      txid: tx.id,
      unsignedTxHex,
      inputs,
      lockTime: k === 0 ? head.lockTime : 0,
      amount: params.amount,
      fee,
      vsize,
      spend: { index: spend.index, address: spend.address },
      change: { index: change.index, address: change.address, value: changeValue },
    });
    prev = { txid: tx.id, unsignedTxHex, value: changeValue, changeIndex: change.index };
  }
  return out;
}

/** What the hardware wallet should show for refill `r`, so the user can compare. */
export function refillPromptText(r: UnsignedRefill, total: number): string {
  return `Refill ${r.position} of ${total}: ${r.amount} sats to your spending balance ${r.spend.address}, ${r.change.value} sats back to the vault, fee ${r.fee} sats`;
}

/** Finalizes a refill PSBT signed by phone and hardware into the stored form. */
export function finalizeRefill(r: UnsignedRefill, signedPsbt: Uint8Array): StoredRefill {
  const tx = btc.Transaction.fromPSBT(signedPsbt, TX_OPTS);
  if (tx.id !== r.txid) throw new RecoveryKeyError('chain_invalid', `refill ${r.position}: the signed transaction is not the one built`);
  tx.finalize();
  return {
    position: r.position,
    txid: r.txid,
    txHex: hex.encode(tx.extract()),
    inputs: r.inputs,
    lockTime: r.lockTime,
    feeSats: Number(r.fee),
    spendIndex: r.spend.index,
    changeIndex: r.change.index,
    changeValueSats: Number(r.change.value),
  };
}

const bad = (position: number, reason: string): never => {
  throw new RecoveryKeyError('chain_invalid', `refill ${position}: ${reason}`, { detail: { position, reason } });
};

function roleOf(pubkeys: Record<Role, Uint8Array>, pub: Uint8Array): Role | undefined {
  return ROLES.find((r) => equalBytes(pubkeys[r], pub));
}

/**
 * Checks a stored chain end to end from the raw transactions. Throws
 * `chain_invalid` with the position and reason of the first problem.
 */
export function verifyRefillChain(chain: RefillChainRecord, ctx: { vault: MultisigWallet; spending: SpendingAccount; minRelaySatPerVb?: number }): void {
  const { vault, spending } = ctx;
  if (chain.descriptor !== vault.descriptor()) throw new RecoveryKeyError('chain_invalid', 'the refill chain belongs to another vault');
  const amount = BigInt(chain.amountSats);
  const linkSeq = encodeRelativeBlocks(chain.periodBlocks);
  const maxFee = amount / 20n;
  const minRelay = ctx.minRelaySatPerVb ?? 1;
  const seenSpend = new Set<number>();
  const seenChange = new Set<number>();
  chain.refills.forEach((r, i) => {
    const p = r.position;
    if (p !== i + 1) bad(p, 'positions are not consecutive');
    let raw;
    try {
      raw = decodeRawTx(r.txHex);
    } catch {
      return bad(p, 'not a valid transaction');
    }
    if (txidOf(raw) !== r.txid) bad(p, 'txid does not match the transaction');
    if (raw.version !== 2) bad(p, `version ${raw.version}: BIP 68 needs version 2`);
    if (raw.lockTime !== r.lockTime) bad(p, 'nLockTime differs from the record');
    if (r.lockTime >= LOCKTIME_THRESHOLD) bad(p, 'time-based nLockTime');
    if (raw.inputs.length !== r.inputs.length) bad(p, 'inputs differ from the record');
    let total = 0n;
    raw.inputs.forEach((inp, j) => {
      const want = r.inputs[j]!;
      if (hex.encode(inp.txid) !== want.txid || inp.index !== want.vout) bad(p, `input ${j} differs from the record`);
      if (inp.sequence !== want.sequence) bad(p, `input ${j} nSequence differs from the record`);
      total += BigInt(want.valueSats);
    });
    if (i === 0) {
      // The head: vault coins, no relative lock unless the coin is an earlier refill's output 1.
      for (const want of r.inputs) if (want.sequence !== SEQUENCE_RBF && want.sequence !== linkSeq) bad(p, `unexpected nSequence ${want.sequence}`);
    } else {
      // A link (the first refill of a later batch extends the chain the same way).
      const prev = chain.refills[i - 1]!;
      const want = r.inputs[0]!;
      if (r.inputs.length !== 1) bad(p, 'a link has exactly one input');
      if (want.txid !== prev.txid || want.vout !== REFILL_CHANGE_VOUT) bad(p, 'not linked to the previous refill');
      if (want.chain !== CHANGE || want.index !== prev.changeIndex || want.valueSats !== prev.changeValueSats) bad(p, "the input is not the previous refill's vault output");
      if (want.sequence !== linkSeq) bad(p, `nSequence ${want.sequence} is not the ${chain.periodBlocks}-block relative lock`);
      if (r.lockTime !== 0) bad(p, 'a link has no nLockTime');
    }
    if (raw.outputs.length !== 2) bad(p, 'a refill has exactly two outputs');
    const spend = spending.derive(SPENDING_INTERNAL, r.spendIndex);
    const change = vault.derive(CHANGE, r.changeIndex);
    const [o0, o1] = raw.outputs as [{ script: Uint8Array; amount: bigint }, { script: Uint8Array; amount: bigint }];
    if (!equalBytes(o0.script, spend.script)) bad(p, 'output 0 does not pay this phone\'s spending balance');
    if (o0.amount !== amount) bad(p, `output 0 pays ${o0.amount}, not ${amount}`);
    if (!equalBytes(o1.script, change.script)) bad(p, 'output 1 does not pay back to the vault');
    if (o1.amount !== BigInt(r.changeValueSats)) bad(p, 'output 1 amount differs from the record');
    if (seenSpend.has(r.spendIndex) || seenChange.has(r.changeIndex)) bad(p, 'an address is reused');
    seenSpend.add(r.spendIndex);
    seenChange.add(r.changeIndex);
    const fee = total - o0.amount - o1.amount;
    if (fee !== BigInt(r.feeSats)) bad(p, 'fee differs from the record');
    if (fee > maxFee) bad(p, `fee ${fee} is above 5% of the refill`);
    const vsize = vsizeOf(raw);
    if (Number(fee) < minRelay * vsize) bad(p, 'fee is below the minimum relay fee');
    // Every input: 2-of-3 signatures by the phone and the hardware wallet.
    const t = btc.Transaction.fromRaw(hex.decode(r.txHex), { ...TX_OPTS, allowUnknownOutputs: true, disableScriptCheck: true });
    raw.inputs.forEach((_, j) => {
      const want = r.inputs[j]!;
      const d = vault.derive(want.chain, want.index);
      const prog = btc.OutScript.decode(d.script);
      if (prog.type !== 'wsh') bad(p, 'vault script is not P2WSH');
      let signers: Uint8Array[] = [];
      try {
        signers = verifyP2wshMultisig(t, j, (prog as { hash: Uint8Array }).hash, BigInt(want.valueSats), raw.witnesses?.[j] ?? []);
      } catch (e) {
        bad(p, e instanceof ScriptError ? e.message : 'bad witness');
      }
      const roles = signers.map((s) => roleOf(d.pubkeys, s));
      if (!roles.includes('app') || !roles.includes('hardware')) bad(p, `input ${j} is not signed by the phone and the hardware wallet`);
    });
  });
  let next = 1;
  for (const b of chain.batches) {
    if (b.from !== next || b.to < b.from) throw new RecoveryKeyError('chain_invalid', 'batch ranges are inconsistent');
    next = b.to + 1;
  }
  if (next !== chain.refills.length + 1) throw new RecoveryKeyError('chain_invalid', 'batch ranges do not cover the chain');
}

/** The input that the next batch extends from: output 1 of the last refill. */
export function chainTail(chain: RefillChainRecord): { txid: string; vout: number; value: bigint; changeIndex: number; txHex: string } | undefined {
  const last = chain.refills[chain.refills.length - 1];
  return last && { txid: last.txid, vout: REFILL_CHANGE_VOUT, value: BigInt(last.changeValueSats), changeIndex: last.changeIndex, txHex: last.txHex };
}
