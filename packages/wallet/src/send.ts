/**
 * Payment planning, without I/O: fee rate choice, the local "spent today"
 * estimate, coin selection and which keys sign.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { SEQUENCE_RBF, TX_OPTS, buildSpend, estimateVsize, type MultisigWallet, type Utxo } from '@trikey/core';
import type { WalletUtxo } from '@trikey/protocol';
import type { FeeEstimates } from './chain.js';
import { WalletError } from './errors.js';
import type { GuardianStatusCache, WalletState } from './state.js';

export type FeeSpeed = 'slow' | 'normal' | 'fast';
/** Confirmation targets (blocks) per speed. */
export const SPEED_TARGETS: Record<FeeSpeed, number> = { fast: 1, normal: 3, slow: 6 };
export const FEE_TARGETS = [1, 3, 6, 144];
/** Smallest payment the wallet sends (the P2PKH dust limit, the strictest output type). */
export const MIN_PAYMENT_SATS = 546;
export const LIMIT_WINDOW_MS = 24 * 3_600_000;
/**
 * Estimates above this (sat/vB) are treated as missing, so a confused or lying
 * fee source cannot make the wallet burn money; pass `feeRate` to go higher.
 */
export const MAX_ESTIMATE_SAT_PER_VB = 2000;

/**
 * The fee rate (sat/vB) for `speed`: the node's estimate for that target, else
 * the next slower target that has one, else the minimum relay fee. Never below
 * the minimum relay fee.
 */
export function pickFeeRate(fees: FeeEstimates | undefined, speed: FeeSpeed = 'normal'): number {
  const floor = Math.min(fees?.minRelaySatPerVb ?? 1, MAX_ESTIMATE_SAT_PER_VB);
  const target = SPEED_TARGETS[speed];
  const usable = (fees?.estimates ?? [])
    .filter((e) => e.satPerVb !== null && e.satPerVb <= MAX_ESTIMATE_SAT_PER_VB && e.target >= target)
    .sort((a, b) => a.target - b.target);
  const rate = usable[0]?.satPerVb ?? floor;
  return Math.max(floor, Math.ceil(rate * 1000) / 1000);
}

/**
 * What the phone believes it has spent through the guardian in the last 24 h.
 * The guardian's own count (from `guardian.status`) is the base; payments the
 * guardian co-signed since then are added on top. Only a hint for choosing the
 * signing path: the guardian's answer to `sign` decides.
 */
export function spentTodayEstimate(state: Pick<WalletState, 'spends' | 'guardianStatus'>, now: number): number {
  const recent = state.spends.filter((s) => s.at > now - LIMIT_WINDOW_MS);
  const local = recent.reduce((s, x) => s + x.outflowSats, 0);
  const gs = state.guardianStatus;
  if (!gs?.dailyLimit || gs.checkedAt <= now - LIMIT_WINDOW_MS) return local;
  const since = recent.filter((s) => s.at > gs.checkedAt).reduce((s, x) => s + x.outflowSats, 0);
  return Math.max(local, gs.dailyLimit.usedSats + since);
}

/** Why a payment goes to the hardware wallet instead of phone + guardian. */
export type HardwareReason =
  | 'over-limit'
  | 'guardian-locked'
  | 'guardian-offline'
  | 'recovery-pending'
  | 'phone-spending-paused'
  /** The caller asked for the hardware wallet. */
  | 'requested';

export type SigningPath = { signer: 'phone+guardian' } | { signer: 'phone+hardware'; reason: HardwareReason };

/** The guardian's state as last seen, or undefined if never (then the phone tries the guardian). */
export function guardianBlocker(gs: GuardianStatusCache | undefined): HardwareReason | undefined {
  if (!gs) return undefined;
  if (gs.activeRecoveryId || gs.phoneSpending === 'paused_recovery') return 'recovery-pending';
  if (gs.phoneSpending !== 'enabled' || gs.paused) return 'phone-spending-paused';
  if (gs.state === 'locked') return 'guardian-locked';
  return undefined;
}

export interface SendRequest {
  address: string;
  amountSats: number;
  /** Default `normal`. Ignored when `feeRate` is set. */
  speed?: FeeSpeed;
  /** sat/vB. */
  feeRate?: number;
  /** `hardware` skips the guardian. Default `auto`. */
  signer?: 'auto' | 'hardware';
  /** Free text for the guardian's log. */
  memo?: string;
  /** The person's own note for this payment, kept on the phone (the send log) and in the backup. */
  label?: string;
}

export interface QuoteInput {
  txid: string;
  vout: number;
  valueSats: number;
  chain: 0 | 1;
  index: number;
}

export interface SendQuote {
  request: SendRequest;
  /** sat/vB */
  feeRate: number;
  /** Where the fee rate came from: the node's estimate, the minimum relay fee (no estimate: may confirm slowly), or the caller. */
  feeRateSource: 'estimate' | 'relay-minimum' | 'caller';
  feeSats: number;
  /** What leaves the wallet: amount + fee. This is what the daily limit counts. */
  totalSats: number;
  changeSats: number;
  changeIndex: number;
  inputs: QuoteInput[];
  plan: SigningPath;
  /** Daily limit left after this payment, by the phone's estimate (0 if it does not fit). */
  remainingAfterSats: number;
  dailyLimitSats?: number;
  /**
   * Set for a payment to a silent payment address (`request.address` is the `sp1…`/`tsp1…` string). Then
   * `feeSats` is the whole transaction's fee, `totalSats` what leaves the vault (amount + the vault's share of the
   * fee: what a daily limit would count), and the helper coin pays the rest of the fee for its own input and change.
   */
  silentPayment?: SilentPaymentQuote;
  /**
   * Set by `quoteSendMax`: `request.amountSats` is everything the vault can send (the coins' sum minus the fee), `inputs`
   * is every coin it spends, and there is no change. `send` builds it as a send-max transaction and refuses it
   * (`quote_stale`) if the coins it would spend now are not these.
   */
  sendMax?: true;
}

export interface SilentPaymentQuote {
  /** The recipient as the person entered it, for display. */
  address: string;
  /** The taproot output key this payment creates (x-only hex). */
  outputKey: string;
  /** The same output as a plain taproot address: what a hardware wallet shows, as it cannot show `sp1…`. */
  outputAddress: string;
  /** The helper coin this payment spends, and its change (to a fresh helper address). */
  helper: { txid: string; vout: number; valueSats: number; chain: 0 | 1; index: number; feeSats: number; changeSats: number; changeIndex: number };
}

export function toCoreUtxo(u: QuoteInput, prevTxHex?: string): Utxo {
  return { txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex };
}

/** Throws `invalid_address` unless `address` is valid on the wallet's network. */
export function checkAddress(address: string, wallet: MultisigWallet): void {
  try {
    btc.Address(wallet.network.btc).decode(address);
  } catch {
    throw new WalletError('invalid_address', `Not a valid ${wallet.network.name} address.`);
  }
}

/** Largest-first selection over confirmed coins, then over all coins if those are not enough. */
export function selectCoins(opts: {
  wallet: MultisigWallet;
  utxos: WalletUtxo[];
  address: string;
  amountSats: number;
  feeRate: number;
  changeIndex: number;
}): { inputs: QuoteInput[]; feeSats: number; changeSats: number } {
  const { wallet, address, amountSats, feeRate, changeIndex } = opts;
  if (!Number.isSafeInteger(amountSats) || amountSats < MIN_PAYMENT_SATS)
    throw new WalletError('amount_too_small', `The smallest payment is ${MIN_PAYMENT_SATS} sats.`);
  checkAddress(address, wallet);
  const asInput = (u: WalletUtxo): QuoteInput => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index });
  const confirmed = opts.utxos.filter((u) => u.confirmations > 0).map(asInput);
  const all = opts.utxos.map(asInput);
  for (const set of confirmed.length < all.length ? [confirmed, all] : [all]) {
    if (!set.length) continue;
    try {
      const plan = buildSpend({ wallet, utxos: set.map((u) => toCoreUtxo(u)), recipients: [{ address, amount: BigInt(amountSats) }], feeRate, changeIndex });
      const inputs = plan.inputs.map((u) => set.find((x) => x.txid === u.txid && x.vout === u.vout)!);
      return { inputs, feeSats: Number(plan.fee), changeSats: Number(plan.change?.amount ?? 0n) };
    } catch (e) {
      if (!(e instanceof Error) || !/insufficient funds/.test(e.message)) throw e;
    }
  }
  const have = all.reduce((s, u) => s + u.valueSats, 0);
  throw new WalletError('insufficient_funds', `Not enough funds: ${have} sats available.`);
}

/**
 * "Send max": every coin the vault may spend, one output, no change. The fee is the one `buildSpend` would charge for that
 * transaction (same size estimate, same rounding), and the amount is what is left. Coins are chosen as `selectCoins`
 * does: the confirmed ones, and only when they cannot make a payment above dust, all of them (unconfirmed included).
 *
 * `outputScript` is the recipient's script (for a silent payment, a placeholder of the same size). Throws
 * `nothing_to_send` with no coins, and `send_max_too_small` when the amount would be below dust.
 */
export function selectAllCoins(opts: { utxos: WalletUtxo[]; outputScript: Uint8Array; feeRate: number }): { inputs: QuoteInput[]; amountSats: number; feeSats: number } {
  const asInput = (u: WalletUtxo): QuoteInput => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index });
  const confirmed = opts.utxos.filter((u) => u.confirmations > 0).map(asInput);
  const all = opts.utxos.map(asInput);
  if (!all.length) throw new WalletError('nothing_to_send', 'The wallet has no coins to send.');
  const fit = (set: QuoteInput[]) => {
    const total = set.reduce((s, u) => s + u.valueSats, 0);
    const feeSats = Math.ceil(estimateVsize(set.length, [opts.outputScript]) * opts.feeRate);
    return { inputs: set, total, feeSats, amountSats: total - feeSats };
  };
  let last = fit(all);
  for (const set of confirmed.length < all.length ? [confirmed, all] : [all]) {
    if (!set.length) continue;
    last = fit(set);
    if (Number.isSafeInteger(last.amountSats) && last.amountSats >= MIN_PAYMENT_SATS) return { inputs: last.inputs, amountSats: last.amountSats, feeSats: last.feeSats };
  }
  throw new WalletError(
    'send_max_too_small',
    `After the ${last.feeSats} sats network fee, the ${last.total} sats in the wallet leave ${Math.max(0, last.amountSats)} sats: less than the smallest payment (${MIN_PAYMENT_SATS} sats).`,
    { feeSats: last.feeSats },
  );
}

/** The PSBT of a send-max quote: every input, then the one output. `prevTxHexes[i]` is the previous transaction of `inputs[i]`. */
export function buildSendMaxPsbt(opts: { wallet: MultisigWallet; inputs: QuoteInput[]; prevTxHexes: string[]; outputScript: Uint8Array; amountSats: number }): Uint8Array {
  const tx = new btc.Transaction(TX_OPTS);
  opts.inputs.forEach((u, i) => {
    const d = opts.wallet.derive(u.chain, u.index);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: SEQUENCE_RBF,
      witnessUtxo: { script: d.script, amount: BigInt(u.valueSats) },
      nonWitnessUtxo: hex.decode(opts.prevTxHexes[i]!),
      sighashType: btc.SigHash.ALL,
      ...opts.wallet.psbtFields(d),
    });
  });
  tx.addOutput({ script: opts.outputScript, amount: BigInt(opts.amountSats) });
  return tx.toPSBT();
}

/** The output script of `address`; throws `invalid_address` unless it is valid on the wallet's network. */
export function outputScriptOf(address: string, wallet: MultisigWallet): Uint8Array {
  try {
    return btc.OutScript.encode(btc.Address(wallet.network.btc).decode(address));
  } catch {
    throw new WalletError('invalid_address', `Not a valid ${wallet.network.name} address.`);
  }
}

// ---------------------------------------------------------------------------
// Fee bump (RBF) of an unconfirmed payment the wallet made

/** One output of a transaction being replaced: what it pays, and whether it is the change back to the wallet. */
export interface BumpOutput {
  /** Output script, hex. */
  script: string;
  amountSats: number;
  /** The change back to the wallet (its change chain), the one output a fee bump lowers. */
  change?: { index: number };
}

/** A fee bump (BIP 125 replacement) of an unconfirmed payment: the same inputs and payments, a smaller change, a higher fee. */
export interface BumpPlan {
  /** The inputs of the transaction it replaces, in its order, each with its place in the wallet. */
  inputs: QuoteInput[];
  /** The replacement's outputs, in the original's order: payments unchanged, the change lowered (or gone, when below dust). */
  outputs: BumpOutput[];
  oldFeeSats: number;
  /** sat/vB of the original, by the wallet's size estimate (what it was signed at). */
  oldFeeRate: number;
  feeSats: number;
  /** sat/vB of the replacement, by the same estimate. */
  feeRate: number;
  /** The size estimate (vbytes) of the replacement. */
  vsize: number;
  /** The change before and after; absent after when the bump spends it all (it was below dust). */
  change: { index: number; beforeSats: number; afterSats?: number };
  /** What the payments send (every output but the change). Never changes. */
  paymentSats: number;
}

/**
 * Plans a fee bump of `txHex`, an unconfirmed transaction that spends only the wallet's coins (`prevTxHexes[i]` is input
 * `i`'s previous transaction, `pathOf` places an output script in the wallet, or says it is not the wallet's). BIP 125 as
 * Bitcoin Core applies it: the replacement spends the same inputs, pays the same outputs to everyone else, and pays a
 * higher fee and fee rate, at least the original's fee plus `incrementalSatPerVb` for its own size. The fee comes out
 * of the change back to the wallet; when what is left of it would be dust, the change goes to the fee entirely (still
 * within the rules). The payments are never touched, so a payment with no change cannot be bumped this way.
 *
 * The fee is `feeRate` (sat/vB, the target) for the wallet's size estimate, raised to the BIP 125 minimum. Throws
 * `cannot_speed_up` with the reason in words.
 */
export function planFeeBump(opts: {
  txHex: string;
  prevTxHexes: string[];
  pathOf: (script: Uint8Array) => { chain: 0 | 1; index: number } | undefined;
  feeRate: number;
  incrementalSatPerVb: number;
}): BumpPlan {
  const tx = btc.Transaction.fromRaw(hex.decode(opts.txHex), { ...TX_OPTS, allowUnknownOutputs: true });
  if (opts.prevTxHexes.length !== tx.inputsLength) throw new WalletError('internal', 'One previous transaction per input is needed.');
  const inputs: QuoteInput[] = [];
  let totalIn = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = hex.encode(inp.txid!);
    const vout = inp.index!;
    if ((inp.sequence ?? 0xffffffff) >= 0xfffffffe) throw new WalletError('cannot_speed_up', 'This payment did not signal that it can be replaced, so a higher fee cannot be added.');
    const prev = btc.Transaction.fromRaw(hex.decode(opts.prevTxHexes[i]!), { ...TX_OPTS, allowUnknownOutputs: true });
    if (prev.id !== txid) throw new WalletError('internal', `The previous transaction of input ${i} is not ${txid}.`);
    const out = prev.getOutput(vout);
    const place = out.script ? opts.pathOf(out.script) : undefined;
    if (!out.script || out.amount === undefined || !place) throw new WalletError('cannot_speed_up', 'This payment spends coins that are not this wallet\'s, so it cannot be sped up from here.');
    inputs.push({ txid, vout, valueSats: Number(out.amount), chain: place.chain, index: place.index });
    totalIn += Number(out.amount);
  }
  const outputs: BumpOutput[] = [];
  let totalOut = 0;
  let changeAt = -1;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new WalletError('cannot_speed_up', 'This payment has an output Trikey cannot read.');
    const amountSats = Number(o.amount);
    const place = opts.pathOf(o.script);
    outputs.push({ script: hex.encode(o.script), amountSats, ...(place?.chain === 1 ? { change: { index: place.index } } : {}) });
    // The change: the largest output back to the wallet's change chain (a payment to one of its receive addresses stays a payment).
    if (place?.chain === 1 && (changeAt < 0 || amountSats > outputs[changeAt]!.amountSats)) changeAt = i;
    totalOut += amountSats;
  }
  // Only one output is the change; any other on the change chain is left as it is.
  outputs.forEach((o, i) => {
    if (i !== changeAt) delete o.change;
  });
  const oldFeeSats = totalIn - totalOut;
  if (oldFeeSats <= 0) throw new WalletError('internal', 'The payment pays no fee.');
  if (changeAt < 0) throw new WalletError('cannot_speed_up', 'This payment sends everything, with no change back: there is nothing to pay a higher fee from without lowering what it pays.');
  const change = outputs[changeAt]!;
  const scripts = (list: BumpOutput[]) => list.map((o) => hex.decode(o.script));
  const vsizeWith = estimateVsize(inputs.length, scripts(outputs));
  const paymentSats = totalOut - change.amountSats;
  const oldFeeRate = oldFeeSats / vsizeWith;
  const rate = Math.max(opts.feeRate, 0);
  const incremental = Math.max(opts.incrementalSatPerVb, 0);
  // At the target rate, and at least what BIP 125 asks: the old fee plus the incremental relay fee for the new size.
  const feeFor = (vsize: number) => Math.max(Math.ceil(rate * vsize), oldFeeSats + Math.ceil(incremental * vsize), oldFeeSats + 1);
  const withChange = feeFor(vsizeWith);
  const left = change.amountSats - (withChange - oldFeeSats);
  if (left >= MIN_PAYMENT_SATS) {
    const out = outputs.map((o, i) => (i === changeAt ? { ...o, amountSats: left } : o));
    return { inputs, outputs: out, oldFeeSats, oldFeeRate, feeSats: withChange, feeRate: withChange / vsizeWith, vsize: vsizeWith, change: { index: change.change!.index, beforeSats: change.amountSats, afterSats: left }, paymentSats };
  }
  // What is left of the change would be dust: it all goes to the fee, if that is enough without the change output.
  const without = outputs.filter((_, i) => i !== changeAt);
  const vsizeWithout = estimateVsize(inputs.length, scripts(without));
  const feeAll = oldFeeSats + change.amountSats;
  if (feeAll < feeFor(vsizeWithout))
    throw new WalletError(
      'cannot_speed_up',
      `The change in this payment (${change.amountSats} sats) is too small to pay a higher fee (${feeFor(vsizeWithout) - oldFeeSats} sats more are needed) without lowering what it pays.`,
    );
  return { inputs, outputs: without, oldFeeSats, oldFeeRate, feeSats: feeAll, feeRate: feeAll / vsizeWithout, vsize: vsizeWithout, change: { index: change.change!.index, beforeSats: change.amountSats }, paymentSats };
}

/** The PSBT of a fee bump: the plan's inputs (signalling RBF again) and outputs, the change with its derivation for the devices. */
export function buildBumpPsbt(opts: { wallet: MultisigWallet; plan: Pick<BumpPlan, 'inputs' | 'outputs'>; prevTxHexes: string[] }): Uint8Array {
  const tx = new btc.Transaction(TX_OPTS);
  opts.plan.inputs.forEach((u, i) => {
    const d = opts.wallet.derive(u.chain, u.index);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: SEQUENCE_RBF,
      witnessUtxo: { script: d.script, amount: BigInt(u.valueSats) },
      nonWitnessUtxo: hex.decode(opts.prevTxHexes[i]!),
      sighashType: btc.SigHash.ALL,
      ...opts.wallet.psbtFields(d),
    });
  });
  for (const o of opts.plan.outputs) {
    if (o.change) {
      const d = opts.wallet.derive(1, o.change.index);
      if (hex.encode(d.script) !== o.script) throw new WalletError('internal', 'The change output is not at the change address it names.');
      tx.addOutput({ script: d.script, amount: BigInt(o.amountSats), ...opts.wallet.psbtFields(d) });
    } else tx.addOutput({ script: hex.decode(o.script), amount: BigInt(o.amountSats) });
  }
  return tx.toPSBT();
}
