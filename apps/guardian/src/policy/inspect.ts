import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  MultisigWallet,
  PsbtAnalysis,
  PsbtError,
  analyzePsbt,
  type HelperInputCandidate,
  compareBytes,
  parsePsbt,
  sighashAll,
} from '@trikey/core';
import { CosignerSigner } from './signer.js';
import { HighWater, Refusal } from './types.js';

/**
 * Highest address index accepted as "our own" change, and the highest any high-water mark is kept at. Outputs at
 * higher indexes count as leaving the wallet: the app's gap-limit scan would not find them, so a thief could otherwise
 * park funds out of sight for free. Kept well below the address scan's own limit (chain.ts, `MAX_SCAN_INDEX`, 100,000)
 * minus a window and a gap, so a scan that must reach a mark never runs into that limit (a test checks).
 */
export const MAX_SELF_INDEX = 99_000;

/**
 * How far past a chain's on-chain high-water mark (the highest index a scan found used) an output may still count as
 * change. Equal to the address scan's gap limit (chain.ts, `DEFAULT_GAP_LIMIT`), so anything co-signed as change is
 * within the range a gap-limit scan from that used address covers. Co-signatures do not move the marks (a co-signed
 * transaction may never be broadcast): only what scans find used does, so the window cannot be walked.
 */
export const CHANGE_WINDOW = 20;

/**
 * The lowest fee rate key 3 co-signs at: 100 sat/kvB (0.1 sat/vB), the default minimum relay fee of Bitcoin Core 29.1
 * and later (older nodes: 1 sat/vB). A transaction paying less never relays with default settings, so it is no real
 * payment; refusing it makes every co-signature cost something against the daily limit (DESIGN.md, rule 3).
 */
export const MIN_COSIGN_FEE_SAT_PER_KVB = 100;
/** Witness vbytes of a 2-of-3 P2WSH input, a lower bound (two 71-byte signatures, the 105-byte script, counts). */
const VB_MULTISIG_WITNESS_MIN = 62;
/** Witness vbytes of a P2WPKH input (a helper coin), a lower bound. */
const VB_P2WPKH_WITNESS_MIN = 26;

/**
 * A lower bound of the transaction's vsize once signed: its unsigned (witness-free) size plus the smallest witness each
 * input can have. A lower bound, so a payment that really pays the minimum rate is never refused.
 */
export function vsizeLowerBound(tx: btc.Transaction, analysis: PsbtAnalysis): number {
  return tx.unsignedTx.length + analysis.inputs.length * VB_MULTISIG_WITNESS_MIN + (analysis.helper ? VB_P2WPKH_WITNESS_MIN : 0);
}

/** A refusal when the fee is under `MIN_COSIGN_FEE_SAT_PER_KVB` of `vsize` (`Inspection.vsizeMin`), else undefined. */
export function feeRateRefusal(fee: bigint, vsize: number): Refusal | undefined {
  if (fee * 1000n >= BigInt(MIN_COSIGN_FEE_SAT_PER_KVB) * BigInt(vsize)) return undefined;
  return { reason: 'fee_rate_too_low', fee, vsize, minSatPerKvb: MIN_COSIGN_FEE_SAT_PER_KVB };
}

export const NO_HIGH_WATER: HighWater = { receive: -1, change: -1 };

export const maxHighWater = (a: HighWater, b: HighWater): HighWater => ({ receive: Math.max(a.receive, b.receive), change: Math.max(a.change, b.change) });

/** Does the PSBT pay a taproot (P2TR) output? Every silent payment does. */
export function hasTaprootOutput(tx: btc.Transaction): boolean {
  for (let i = 0; i < tx.outputsLength; i++) {
    const s = tx.getOutput(i).script;
    if (s && s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return true;
  }
  return false;
}

export interface InspectOptions {
  /**
   * Accept one helper input (core's `helperInput`): a finalized P2WPKH spend whose script this
   * function accepts. Only offered for PSBTs with a taproot output (`hasTaprootOutput`).
   */
  helper?: (candidate: HelperInputCandidate) => boolean;
  /**
   * Highest index per chain an output may have and still count as paying the target (change): the
   * on-chain high-water marks plus `CHANGE_WINDOW`. Outputs past it count as leaving the wallet. Default:
   * `MAX_SELF_INDEX` (a recovery's destination, which has no history here).
   */
  selfLimit?: HighWater;
}

export interface Inspection {
  analysis: PsbtAnalysis;
  /** Per output: does it pay a descriptor-derived address of the target wallet? */
  toTarget: boolean[];
  /** Σ outputs paying the target wallet. */
  targetOut: bigint;
  /**
   * Σ the wallet's inputs − targetOut: value leaving the wallet, fee included. A helper input's value is
   * not the wallet's and is not counted (core's `vaultIn`); outputs count only when they pay a derived
   * address of the target wallet, so a helper output is never change. Never negative.
   */
  outflow: bigint;
  /** Per chain, the highest index of an output counted as paying the target (-1 for none). */
  selfIndexes: HighWater;
  /** A lower bound of the signed transaction's vsize (`vsizeLowerBound`). */
  vsizeMin: number;
}

function mapPsbtError(e: unknown): Refusal {
  if (!(e instanceof PsbtError)) return { reason: 'invalid_psbt', detail: e instanceof Error ? e.message : String(e) };
  const input = e.input ?? -1;
  switch (e.code) {
    case 'helper_not_finalized':
    case 'helper_invalid_witness':
    case 'helper_invalid_signature':
    case 'too_many_helper_inputs':
      return { reason: 'invalid_helper_input', input: e.input, code: e.code, detail: e.message };
    case 'missing_non_witness_utxo':
      return { reason: 'missing_non_witness_utxo', input };
    case 'non_witness_utxo_mismatch':
      return { reason: 'non_witness_utxo_mismatch', input };
    case 'missing_tweaks':
    case 'foreign_input':
      return { reason: 'foreign_input', input: e.input, detail: e.message };
    case 'unknown_signer':
    case 'invalid_signature':
      return { reason: 'invalid_signature', input: e.input, detail: e.message };
    default:
      return { reason: 'invalid_psbt', detail: e.message };
  }
}

/**
 * The chain and index of `wallet.derive(chain, index)` that output `o` pays exactly, for a chain/index
 * its BIP32 metadata claims within `limit`, else undefined.
 */
function paysDerivedAddress(wallet: MultisigWallet, o: ReturnType<btc.Transaction['getOutput']>, limit?: HighWater): { chain: 0 | 1; index: number } | undefined {
  if (!o.script) return undefined;
  for (const [, { path }] of o.bip32Derivation ?? []) {
    if (path.length < 2) continue;
    const chain = path[path.length - 2];
    const index = path[path.length - 1];
    if ((chain !== 0 && chain !== 1) || index < 0 || index > MAX_SELF_INDEX) continue;
    if (limit && index > (chain === 0 ? limit.receive : limit.change)) continue;
    if (compareBytes(wallet.derive(chain, index).script, o.script) === 0) return { chain, index };
  }
  return undefined;
}

/**
 * Checks every input belongs to `wallet` (nonWitnessUtxo required, signatures
 * verified) and classifies outputs against `target` (default: `wallet`).
 */
export function inspectPsbt(
  psbt: Uint8Array,
  wallet: MultisigWallet,
  target: MultisigWallet = wallet,
  opts: InspectOptions = {},
): { ok: true; inspection: Inspection } | { ok: false; refusal: Refusal } {
  let analysis: PsbtAnalysis;
  let tx: btc.Transaction;
  try {
    tx = parsePsbt(psbt);
    analysis = analyzePsbt(psbt, wallet.accountPubkeys(), wallet.network, {
      requireNonWitnessUtxo: true,
      outputsAcct: target.accountPubkeys(),
      ...(opts.helper && hasTaprootOutput(tx) ? { helperInput: opts.helper } : {}),
    });
  } catch (e) {
    return { ok: false, refusal: mapPsbtError(e) };
  }
  if (!analysis.inputs.length) return { ok: false, refusal: { reason: 'invalid_psbt', detail: 'no inputs' } };
  if (!analysis.outputs.length) return { ok: false, refusal: { reason: 'invalid_psbt', detail: 'no outputs' } };
  const paid = analysis.outputs.map((_, i) => paysDerivedAddress(target, tx.getOutput(i), opts.selfLimit));
  const toTarget = paid.map((p) => !!p);
  const targetOut = analysis.outputs.reduce((s, o, i) => (toTarget[i] ? s + o.amount : s), 0n);
  const vaultIn = analysis.vaultIn ?? analysis.totalIn;
  const selfIndexes = { ...NO_HIGH_WATER };
  for (const p of paid) if (p) selfIndexes[p.chain === 0 ? 'receive' : 'change'] = Math.max(selfIndexes[p.chain === 0 ? 'receive' : 'change'], p.index);
  return {
    ok: true,
    inspection: { analysis, toTarget, targetOut, outflow: vaultIn > targetOut ? vaultIn - targetOut : 0n, selfIndexes, vsizeMin: vsizeLowerBound(tx, analysis) },
  };
}

/** Adds key 3's SIGHASH_ALL signature to every input and returns the new PSBT. */
export async function addCosignerSignatures(psbt: Uint8Array, analysis: PsbtAnalysis, signer: CosignerSigner): Promise<Uint8Array> {
  const tx = parsePsbt(psbt);
  for (const inp of analysis.inputs) {
    const msg = sighashAll(tx, inp.index, inp.witnessScript, inp.amount);
    const der = await signer.sign(msg, inp.tweaks.cosigner);
    const pub = inp.pubkeys.cosigner;
    if (!secp256k1.verify(der, msg, pub, { prehash: false, format: 'der', lowS: true }))
      throw new Error(`cosigner produced an invalid signature for input ${inp.index}`);
    const sig = new Uint8Array(der.length + 1);
    sig.set(der);
    sig[der.length] = btc.SigHash.ALL;
    tx.updateInput(inp.index, { partialSig: [[pub, sig]] }, true);
  }
  return tx.toPSBT();
}
