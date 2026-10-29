import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
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

/** Signals RBF (BIP125). */
const SEQUENCE_RBF = 0xfffffffd;
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

function addWalletInput(tx: btc.Transaction, wallet: MultisigWallet, u: Utxo) {
  const d = wallet.derive(u.chain, u.index);
  tx.addInput({
    txid: u.txid,
    index: u.vout,
    sequence: SEQUENCE_RBF,
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
export function buildSpend(opts: {
  wallet: MultisigWallet;
  utxos: Utxo[];
  recipients: Recipient[];
  feeRate: number; // sat/vB
  changeIndex: number;
}): SpendPlan {
  const { wallet, recipients, feeRate } = opts;
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

  const tx = new btc.Transaction(TX_OPTS);
  for (const u of chosen) addWalletInput(tx, wallet, u);
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
export function buildSweep(opts: {
  from: MultisigWallet;
  utxos: Utxo[];
  destination: MultisigWallet;
  destinationIndex: number;
  feeRate: number;
}): SpendPlan {
  if (!opts.utxos.length) throw new Error('nothing to sweep');
  const dest = opts.destination.derive(0, opts.destinationIndex);
  const total = opts.utxos.reduce((s, u) => s + u.value, 0n);
  const fee = BigInt(Math.ceil(estimateVsize(opts.utxos.length, [dest.script]) * opts.feeRate));
  if (total - fee < DUST) throw new Error('sweep amount is below dust after fees');
  const tx = new btc.Transaction(TX_OPTS);
  for (const u of opts.utxos) addWalletInput(tx, opts.from, u);
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
  | 'outputs_exceed_inputs';

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

export interface PsbtAnalysis {
  txid: string;
  inputs: AnalyzedInput[];
  outputs: AnalyzedOutput[];
  totalIn: bigint;
  selfOut: bigint;
  externalOut: bigint;
  fee: bigint;
  /** Value leaving the key set, fee included. This is what spend limits count. */
  outflow: bigint;
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
  opts: { outputsAcct?: AccountPubkeys; requireNonWitnessUtxo?: boolean } = {},
): PsbtAnalysis {
  const tx = parsePsbt(psbt);
  const inputs: AnalyzedInput[] = [];
  const seen = new Set<string>();
  let totalIn = 0n;
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
    if (!tweaks) throw new PsbtError('missing_tweaks', `input ${i}: missing delegation tweaks`, i);
    const d = delegatedScripts(acct, tweaks, network);
    if (compareBytes(d.script, inp.witnessUtxo.script) !== 0) throw new PsbtError('foreign_input', `input ${i}: does not belong to wallet`, i);

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
  return { txid: tx.id, inputs, outputs, totalIn, selfOut, externalOut, fee, outflow: externalOut + fee };
}
