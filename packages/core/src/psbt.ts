import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { Network } from './network.js';
import {
  AccountPubkeys,
  CHANGE,
  MultisigWallet,
  ROLES,
  Role,
  TX_OPTS,
  Tweaks,
  compareBytes,
  delegatedScripts,
} from './wallet.js';
import { findTweak } from './tweak.js';
import { SEQUENCE_RBF } from './timelock.js';

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  chain: number;
  index: number;
  /** Full previous transaction. Hardware wallets require it for segwit v0 inputs. */
  prevTxHex?: string;
}

export interface Recipient {
  address: string;
  amount: bigint;
}

const DUST = 546n;

// vbytes: 2-of-3 P2WSH input ≈ 41 non-witness + 254/4 witness.
const VB_TX_OVERHEAD = 11;
const VB_P2WSH_MULTISIG_INPUT = 105;

function outputVbytes(script: Uint8Array): number {
  return 9 + script.length;
}

export function estimateVsize(inputs: number, outputScripts: Uint8Array[]): number {
  return VB_TX_OVERHEAD + inputs * VB_P2WSH_MULTISIG_INPUT + outputScripts.reduce((s, o) => s + outputVbytes(o), 0);
}

/** A coin listed twice would be counted twice and make a transaction with duplicate inputs. */
function assertDistinctUtxos(utxos: Utxo[]) {
  const seen = new Set<string>();
  for (const u of utxos) {
    const outpoint = `${u.txid}:${u.vout}`;
    if (seen.has(outpoint)) throw new Error(`duplicate utxo: ${outpoint}`);
    seen.add(outpoint);
  }
}

/** Optional nSequence and nLockTime. The defaults (SEQUENCE_RBF, 0) are what the builders always used. */
export interface TimelockOpts {
  /**
   * nSequence: one value for every input, or one per entry of `utxos` in the same order.
   * For buildSpend, entries for coins that are not selected are ignored.
   */
  sequence?: number | number[];
  /** nLockTime: a block height below 500,000,000, else a Unix time. */
  lockTime?: number;
}

function u32(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${name} must be an unsigned 32-bit integer, got ${v}`);
  return v;
}

/** One nSequence per entry of `utxos`. */
function sequencesFor(utxos: Utxo[], sequence: number | number[] | undefined): number[] {
  if (Array.isArray(sequence)) {
    if (sequence.length !== utxos.length) throw new Error(`sequence: expected one value per utxo (${utxos.length}), got ${sequence.length}`);
    return sequence.map((s) => u32('sequence', s));
  }
  return utxos.map(() => u32('sequence', sequence ?? SEQUENCE_RBF));
}

function addWalletInput(tx: btc.Transaction, wallet: MultisigWallet, u: Utxo, sequence: number) {
  const d = wallet.derive(u.chain, u.index);
  tx.addInput({
    txid: u.txid,
    index: u.vout,
    sequence,
    witnessUtxo: { script: d.script, amount: u.value },
    ...(u.prevTxHex ? { nonWitnessUtxo: hex.decode(u.prevTxHex) } : {}),
    sighashType: btc.SigHash.ALL,
    ...wallet.psbtFields(d),
  });
}

export interface SpendPlan {
  psbt: Uint8Array;
  fee: bigint;
  change?: { index: number; amount: bigint };
  inputs: Utxo[];
}

/** Largest-first coin selection with an optional change output back to the wallet. */
export function buildSpend(
  opts: {
    wallet: MultisigWallet;
    utxos: Utxo[];
    recipients: Recipient[];
    feeRate: number; // sat/vB
    changeIndex: number;
  } & TimelockOpts,
): SpendPlan {
  const { wallet, recipients, feeRate } = opts;
  assertDistinctUtxos(opts.utxos);
  const sequences = sequencesFor(opts.utxos, opts.sequence);
  const lockTime = u32('lockTime', opts.lockTime ?? 0);
  for (const r of recipients) if (r.amount <= 0n) throw new Error(`recipient amount must be positive, got ${r.amount}`);
  const net = wallet.network.btc;
  const recipientScripts = recipients.map((r) => btc.OutScript.encode(btc.Address(net).decode(r.address)));
  const target = recipients.reduce((s, r) => s + r.amount, 0n);
  const changeAddr = wallet.derive(CHANGE, opts.changeIndex);

  const sorted = [...opts.utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const chosen: Utxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    chosen.push(u);
    total += u.value;
    const feeWithChange = BigInt(Math.ceil(estimateVsize(chosen.length, [...recipientScripts, changeAddr.script]) * feeRate));
    if (total >= target + feeWithChange) break;
  }
  const feeNoChange = BigInt(Math.ceil(estimateVsize(chosen.length, recipientScripts) * feeRate));
  if (total < target + feeNoChange) throw new Error(`insufficient funds: have ${total}, need ${target + feeNoChange}`);

  const feeWithChange = BigInt(Math.ceil(estimateVsize(chosen.length, [...recipientScripts, changeAddr.script]) * feeRate));
  const changeAmount = total - target - feeWithChange;
  const withChange = changeAmount >= DUST;

  const tx = new btc.Transaction({ ...TX_OPTS, lockTime });
  for (const u of chosen) addWalletInput(tx, wallet, u, sequences[opts.utxos.indexOf(u)]!);
  recipients.forEach((r, i) => tx.addOutput({ script: recipientScripts[i], amount: r.amount }));
  if (withChange) tx.addOutput({ script: changeAddr.script, amount: changeAmount, ...wallet.psbtFields(changeAddr) });

  return {
    psbt: tx.toPSBT(),
    fee: withChange ? feeWithChange : total - target,
    change: withChange ? { index: opts.changeIndex, amount: changeAmount } : undefined,
    inputs: chosen,
  };
}

/** Sends every given UTXO to one address of `destination` (used by recovery). */
export function buildSweep(
  opts: {
    from: MultisigWallet;
    utxos: Utxo[];
    destination: MultisigWallet;
    destinationIndex: number;
    feeRate: number;
  } & TimelockOpts,
): SpendPlan {
  if (!opts.utxos.length) throw new Error('nothing to sweep');
  assertDistinctUtxos(opts.utxos);
  const sequences = sequencesFor(opts.utxos, opts.sequence);
  const lockTime = u32('lockTime', opts.lockTime ?? 0);
  const dest = opts.destination.derive(0, opts.destinationIndex);
  const total = opts.utxos.reduce((s, u) => s + u.value, 0n);
  const fee = BigInt(Math.ceil(estimateVsize(opts.utxos.length, [dest.script]) * opts.feeRate));
  if (total - fee < DUST) throw new Error('sweep amount is below dust after fees');
  const tx = new btc.Transaction({ ...TX_OPTS, lockTime });
  opts.utxos.forEach((u, i) => addWalletInput(tx, opts.from, u, sequences[i]!));
  tx.addOutput({ script: dest.script, amount: total - fee, ...opts.destination.psbtFields(dest) });
  return { psbt: tx.toPSBT(), fee, inputs: opts.utxos };
}

export const parsePsbt = (psbt: Uint8Array) => btc.Transaction.fromPSBT(psbt, TX_OPTS);

export function combinePsbts(psbts: Uint8Array[]): Uint8Array {
  return btc.PSBTCombine(psbts, TX_OPTS);
}

/** Finalizes a fully signed PSBT and returns the raw transaction. */
export function finalizePsbt(psbt: Uint8Array): { txHex: string; txid: string } {
  const tx = parsePsbt(psbt);
  tx.finalize();
  return { txHex: hex.encode(tx.extract()), txid: tx.id };
}

// ---------------------------------------------------------------------------
// Analysis: what the cosigner (or a careful app) sees in a PSBT.

export type PsbtErrorCode =
  | 'missing_outpoint'
  | 'duplicate_outpoint'
  | 'missing_witness_utxo'
  | 'bad_sighash_type'
  | 'non_witness_utxo_mismatch'
  | 'missing_non_witness_utxo'
  | 'missing_tweaks'
  | 'foreign_input'
  | 'unknown_signer'
  | 'invalid_signature'
  | 'incomplete_output'
  | 'outputs_exceed_inputs'
  /** With `helperInput`: a single-key input that is not finalized (no `finalScriptWitness`). */
  | 'helper_not_finalized'
  /** With `helperInput`: its final witness is not `<signature> <compressed pubkey of the script>`, or it has a scriptSig. */
  | 'helper_invalid_witness'
  /** With `helperInput`: its signature does not verify, or is not SIGHASH_ALL. */
  | 'helper_invalid_signature'
  /** With `helperInput`: more than one single-key input. */
  | 'too_many_helper_inputs';

/** Thrown by `analyzePsbt` so callers (the guardian) can map failures to typed reasons. */
export class PsbtError extends Error {
  constructor(
    readonly code: PsbtErrorCode,
    message: string,
    /** Index of the offending input, when the failure is about one input. */
    readonly input?: number,
  ) {
    super(message);
    this.name = 'PsbtError';
  }
}

export interface AnalyzedInput {
  index: number;
  outpoint: string;
  amount: bigint;
  witnessScript: Uint8Array;
  pubkeys: Record<Role, Uint8Array>;
  tweaks: Tweaks;
  /** Roles with a valid SIGHASH_ALL signature on this input. */
  signedBy: Role[];
}

export interface AnalyzedOutput {
  index: number;
  amount: bigint;
  script: Uint8Array;
  /** True if the output carries tweaks proving it pays back to the analyzed key set. */
  isSelf: boolean;
}

/**
 * The one extra input `analyzePsbt` accepts with `helperInput`: a P2WPKH spend that is already
 * finalized, with a valid SIGHASH_ALL signature by the key its script commits to, and a
 * `nonWitnessUtxo` that matches its txid (so its amount is the real one). In Trikey it is the phone's
 * helper coin, the only input of a silent payment that BIP 352 counts.
 */
export interface AnalyzedHelperInput {
  index: number;
  outpoint: string;
  amount: bigint;
  /** The P2WPKH scriptPubKey it spends. */
  script: Uint8Array;
  /** The compressed public key from its witness. */
  pubkey: Uint8Array;
}

/** What `helperInput` as a function gets to decide on (before the input's signature is checked). */
export interface HelperInputCandidate {
  index: number;
  outpoint: string;
  amount: bigint;
  script: Uint8Array;
}

export interface PsbtAnalysis {
  txid: string;
  /** The inputs of the analyzed key set (the vault). A helper input is never among them. */
  inputs: AnalyzedInput[];
  outputs: AnalyzedOutput[];
  totalIn: bigint;
  selfOut: bigint;
  externalOut: bigint;
  fee: bigint;
  /**
   * Value leaving the key set, fee included: Σ the key set's inputs − Σ outputs proven to pay it back
   * (`selfOut`). This is what spend limits count. With a helper input it is NOT `externalOut + fee`:
   * the helper's own value is not the key set's, so it adds nothing (and a helper output is never
   * change). It is never negative (a helper paying into the vault leaves nothing).
   */
  outflow: bigint;
  /** With `helperInput`, when the PSBT has one: the helper input, kept out of `inputs`. */
  helper?: AnalyzedHelperInput;
  /** With a helper input: Σ the key set's inputs (`totalIn` counts the helper too, for the fee). */
  vaultIn?: bigint;
}

function readTweaks(proprietary: [Uint8Array, Uint8Array][] | undefined, acct: AccountPubkeys): Tweaks | undefined {
  const t = {} as Tweaks;
  for (const r of ROLES) {
    const v = findTweak(proprietary, acct[r]);
    if (v === undefined) return undefined;
    t[r] = v;
  }
  return t;
}

export function sighashAll(tx: btc.Transaction, idx: number, witnessScript: Uint8Array, amount: bigint): Uint8Array {
  return tx.preimageWitnessV0(idx, witnessScript, btc.SigHash.ALL, amount);
}

function verifyEcdsa(sigWithType: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
  if (sigWithType[sigWithType.length - 1] !== btc.SigHash.ALL) return false;
  try {
    return secp256k1.verify(sigWithType.slice(0, -1), msg, pubkey, { prehash: false, format: 'der', lowS: true });
  } catch {
    return false;
  }
}

/**
 * Checks every input against raw account pubkeys + delegated tweaks and
 * classifies outputs. Throws if any input does not belong to `acct`.
 * `outputsAcct` lets a sweep's outputs be checked against a different key set.
 */
export function analyzePsbt(
  psbt: Uint8Array,
  acct: AccountPubkeys,
  network: Network,
  opts: {
    outputsAcct?: AccountPubkeys;
    requireNonWitnessUtxo?: boolean;
    /**
     * Accept AT MOST ONE input that is not the key set's: a finalized P2WPKH spend (see
     * `AnalyzedHelperInput`). Off by default, which refuses it like any foreign input. A function
     * narrows which such inputs are acceptable (e.g. only scripts of a registered account); an input
     * it refuses is a `foreign_input`. The helper input is left out of `inputs`, so callers that count
     * or add signatures per input never see it, and is reported as `helper`.
     */
    helperInput?: boolean | ((candidate: HelperInputCandidate) => boolean);
  } = {},
): PsbtAnalysis {
  const tx = parsePsbt(psbt);
  const inputs: AnalyzedInput[] = [];
  const seen = new Set<string>();
  let totalIn = 0n;
  let helper: AnalyzedHelperInput | undefined;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.txid || inp.index === undefined) throw new PsbtError('missing_outpoint', `input ${i}: missing outpoint`, i);
    const outpoint = `${hex.encode(inp.txid)}:${inp.index}`;
    if (seen.has(outpoint)) throw new PsbtError('duplicate_outpoint', `input ${i}: duplicate outpoint`, i);
    seen.add(outpoint);
    if (!inp.witnessUtxo) throw new PsbtError('missing_witness_utxo', `input ${i}: missing witnessUtxo`, i);
    if (inp.sighashType !== undefined && inp.sighashType !== btc.SigHash.ALL)
      throw new PsbtError('bad_sighash_type', `input ${i}: only SIGHASH_ALL is allowed`, i);
    if (inp.nonWitnessUtxo) {
      // Pin the claimed amount to the real previous output (defeats the segwit v0 fee attack).
      const prev = inp.nonWitnessUtxo;
      const raw = btc.RawTx.encode({ ...prev, segwitFlag: false, witnesses: undefined });
      const prevTxid = hex.encode(sha256(sha256(raw)).reverse());
      if (prevTxid !== hex.encode(inp.txid)) throw new PsbtError('non_witness_utxo_mismatch', `input ${i}: nonWitnessUtxo does not match txid`, i);
      const out = prev.outputs[inp.index];
      if (!out || out.amount !== inp.witnessUtxo.amount || compareBytes(out.script, inp.witnessUtxo.script) !== 0)
        throw new PsbtError('non_witness_utxo_mismatch', `input ${i}: witnessUtxo does not match nonWitnessUtxo`, i);
    } else if (opts.requireNonWitnessUtxo) {
      throw new PsbtError('missing_non_witness_utxo', `input ${i}: missing nonWitnessUtxo`, i);
    }
    const tweaks = readTweaks(inp.proprietary, acct);
    const d = tweaks && delegatedScripts(acct, tweaks, network);
    if (!tweaks || !d || compareBytes(d.script, inp.witnessUtxo.script) !== 0) {
      const notOurs = tweaks
        ? new PsbtError('foreign_input', `input ${i}: does not belong to wallet`, i)
        : new PsbtError('missing_tweaks', `input ${i}: missing delegation tweaks`, i);
      if (!opts.helperInput || !isP2wpkh(inp.witnessUtxo.script)) throw notOurs;
      const candidate: HelperInputCandidate = { index: i, outpoint, amount: inp.witnessUtxo.amount, script: inp.witnessUtxo.script };
      if (typeof opts.helperInput === 'function' && !opts.helperInput(candidate)) throw notOurs;
      if (!inp.nonWitnessUtxo) throw new PsbtError('missing_non_witness_utxo', `input ${i}: a helper input needs its nonWitnessUtxo`, i);
      const h = checkHelperInput(tx, i, inp, candidate);
      if (helper) throw new PsbtError('too_many_helper_inputs', `input ${i}: at most one helper input (input ${helper.index} is one)`, i);
      helper = h;
      totalIn += h.amount;
      continue;
    }

    const msg = sighashAll(tx, i, d.witnessScript, inp.witnessUtxo.amount);
    const signedBy: Role[] = [];
    for (const [pub, sig] of inp.partialSig ?? []) {
      const role = ROLES.find((r) => compareBytes(d.pubkeys[r], pub) === 0);
      if (!role) throw new PsbtError('unknown_signer', `input ${i}: signature from unknown key`, i);
      if (!verifyEcdsa(sig, msg, pub)) throw new PsbtError('invalid_signature', `input ${i}: invalid ${role} signature`, i);
      signedBy.push(role);
    }
    totalIn += inp.witnessUtxo.amount;
    inputs.push({ index: i, outpoint, amount: inp.witnessUtxo.amount, witnessScript: d.witnessScript, pubkeys: d.pubkeys, tweaks, signedBy });
  }

  const outAcct = opts.outputsAcct ?? acct;
  const outputs: AnalyzedOutput[] = [];
  let selfOut = 0n;
  let externalOut = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new PsbtError('incomplete_output', `output ${i}: incomplete`);
    const tweaks = readTweaks(o.proprietary, outAcct);
    const isSelf = !!tweaks && compareBytes(delegatedScripts(outAcct, tweaks, network).script, o.script) === 0;
    if (isSelf) selfOut += o.amount;
    else externalOut += o.amount;
    outputs.push({ index: i, amount: o.amount, script: o.script, isSelf });
  }
  const fee = totalIn - selfOut - externalOut;
  if (fee < 0n) throw new PsbtError('outputs_exceed_inputs', 'outputs exceed inputs');
  if (!helper) return { txid: tx.id, inputs, outputs, totalIn, selfOut, externalOut, fee, outflow: externalOut + fee };
  // Σ vault inputs − Σ vault outputs: the helper's value is the phone's, not the key set's, either way.
  const vaultIn = totalIn - helper.amount;
  const outflow = vaultIn > selfOut ? vaultIn - selfOut : 0n;
  return { txid: tx.id, inputs, outputs, totalIn, selfOut, externalOut, fee, outflow, helper, vaultIn };
}

const isP2wpkh = (s: Uint8Array) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

/**
 * A finalized P2WPKH input: no scriptSig, the witness `<sig> <pubkey>` with a compressed pubkey whose
 * HASH160 is the script's program, and the signature a valid low-S DER signature under SIGHASH_ALL
 * over the BIP 143 digest of THIS transaction (so the helper's owner committed to every input and
 * output, and nothing can change after the guardian signs).
 */
function checkHelperInput(
  tx: btc.Transaction,
  i: number,
  inp: ReturnType<btc.Transaction['getInput']>,
  c: HelperInputCandidate,
): AnalyzedHelperInput {
  const witness = inp.finalScriptWitness;
  if (!witness?.length) throw new PsbtError('helper_not_finalized', `input ${i}: the helper input must be signed and finalized`, i);
  if (inp.finalScriptSig?.length) throw new PsbtError('helper_invalid_witness', `input ${i}: a P2WPKH spend has an empty scriptSig`, i);
  const [sig, pubkey] = witness;
  if (witness.length !== 2 || !sig || !pubkey || pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3))
    throw new PsbtError('helper_invalid_witness', `input ${i}: the helper witness must be <signature> <compressed pubkey>`, i);
  const program = c.script.slice(2);
  if (compareBytes(hash160(pubkey), program) !== 0) throw new PsbtError('helper_invalid_witness', `input ${i}: the helper witness key is not the script's key`, i);
  const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: program });
  const msg = tx.preimageWitnessV0(i, scriptCode, btc.SigHash.ALL, c.amount);
  if (!verifyEcdsa(sig, msg, pubkey)) throw new PsbtError('helper_invalid_signature', `input ${i}: the helper signature is invalid or not SIGHASH_ALL`, i);
  return { index: i, outpoint: c.outpoint, amount: c.amount, script: c.script, pubkey };
}
