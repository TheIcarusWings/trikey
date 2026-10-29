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
import { Refusal } from './types.js';

/**
 * Highest address index accepted as "our own" change. Outputs at higher
 * indexes count as leaving the wallet: the app's gap-limit scan would not
 * find them, so a thief could otherwise park funds out of sight for free.
 */
export const MAX_SELF_INDEX = 100_000;

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

/** Does output `o` pay exactly `wallet.derive(chain, index)` for the chain/index its BIP32 metadata claims? */
function paysDerivedAddress(wallet: MultisigWallet, o: ReturnType<btc.Transaction['getOutput']>): boolean {
  if (!o.script) return false;
  for (const [, { path }] of o.bip32Derivation ?? []) {
    if (path.length < 2) continue;
    const chain = path[path.length - 2];
    const index = path[path.length - 1];
    if ((chain !== 0 && chain !== 1) || index < 0 || index > MAX_SELF_INDEX) continue;
    if (compareBytes(wallet.derive(chain, index).script, o.script) === 0) return true;
  }
  return false;
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
  const toTarget = analysis.outputs.map((_, i) => paysDerivedAddress(target, tx.getOutput(i)));
  const targetOut = analysis.outputs.reduce((s, o, i) => (toTarget[i] ? s + o.amount : s), 0n);
  const vaultIn = analysis.vaultIn ?? analysis.totalIn;
  return { ok: true, inspection: { analysis, toTarget, targetOut, outflow: vaultIn > targetOut ? vaultIn - targetOut : 0n } };
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
