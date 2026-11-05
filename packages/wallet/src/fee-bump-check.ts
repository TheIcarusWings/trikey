/**
 * The check every "Speed up" replacement passes before the phone signs it, or hands it to a hardware wallet (DESIGN.md,
 * "Speed up"). A replacement is built from the wallet's own record of the original payment (`planFeeBump`), read from
 * the phone's cache or through the guardian; this checks, on the phone and against the wallet's descriptor alone, that
 * the record is what this wallet really signed and that the replacement only adds fee:
 *
 * - the original's bytes hash to the txid the wallet recorded;
 * - every input of the original is one of this wallet's coins: its previous transaction is here and hashes to the
 *   prevout's txid, and the output it spends pays a script the wallet's descriptor derives;
 * - the original was signed by this wallet: each input's witness is `<> <sig> <sig> <witness script>`, with the 2-of-3
 *   witness script of that coin's keys, two signatures with the default sighash (SIGHASH_ALL), valid for two of them;
 * - the replacement spends every input of the original, each once, and nothing else;
 * - it pays every output of the original exactly (amount and script), except the wallet's own change (an output to the
 *   wallet's change chain), which alone may shrink or go to the fee; it adds no output.
 *
 * Pure: no I/O, no clock. A failure throws `FeeBumpCheckError` with a reason code (no transaction data in it), which the
 * wallet turns into a refusal in words (`cannot_speed_up`) and logs by its code. The same idea as Bitkey's
 * FeeBumpVerifier, done with what a Trikey phone holds: the descriptor, and previous transactions checked by their txids.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { compareBytes, ROLES, TX_OPTS, type MultisigWallet } from '@trikey/core';
import { txidOfRaw } from './chain.js';

/** Why a replacement was refused. Logged as is: a code, never transaction data. */
export type FeeBumpCheckReason =
  /** The original transaction is not here (not on the phone, and the guardian did not have it). */
  | 'original_missing'
  /** The original transaction could not be read. */
  | 'original_unreadable'
  /** The original's bytes do not hash to the txid the wallet recorded. */
  | 'original_txid_mismatch'
  /** The original came without its witness data, so who signed it cannot be checked. */
  | 'original_unsigned'
  /** The previous transaction of one of the original's inputs is not here. */
  | 'parent_missing'
  /** A previous transaction does not hash to the txid the input names (or has no such output). */
  | 'parent_txid_mismatch'
  /** An input of the original spends a coin that is not this wallet's. */
  | 'foreign_input'
  /** An input's witness does not carry this wallet's 2-of-3 witness script for that coin. */
  | 'witness_script_mismatch'
  /** A signature of the original is not SIGHASH_ALL. */
  | 'bad_sighash'
  /** A signature of the original does not verify against the wallet's keys for that coin (or is missing). */
  | 'bad_signature'
  /** The replacement could not be read. */
  | 'replacement_unreadable'
  /** The replacement spends an input twice. */
  | 'input_duplicated'
  /** The replacement leaves out an input of the original. */
  | 'input_dropped'
  /** The replacement spends an input the original did not. */
  | 'input_added'
  /** An input of the replacement names a previous output other than the original's coin (amount or script). */
  | 'replacement_prevout_mismatch'
  /** A payment of the original (any output but the wallet's change) is missing or changed in the replacement. */
  | 'output_changed'
  /** The replacement pays an output the original did not. */
  | 'output_added'
  /** The wallet's change grew, or more than one change output changed. */
  | 'change_invalid';

/** Reasons that mean something needed for the check could not be had (try again), not that something is wrong. */
export const FEE_BUMP_DATA_REASONS: readonly FeeBumpCheckReason[] = ['original_missing', 'original_unsigned', 'parent_missing'];

export class FeeBumpCheckError extends Error {
  constructor(
    readonly reason: FeeBumpCheckReason,
    message: string,
  ) {
    super(message);
    this.name = 'FeeBumpCheckError';
  }
}

export interface FeeBumpCheckInput {
  /** The wallet (Spending or Savings) whose descriptor the original must belong to. */
  wallet: MultisigWallet;
  /** Where an output script sits in the wallet (receive 0 or change 1, and index), or undefined. Re-derived here. */
  pathOf: (script: Uint8Array) => { chain: 0 | 1; index: number } | undefined;
  /** The txid the wallet recorded for the payment being replaced. */
  originalTxid: string;
  /** The original as it was broadcast: raw hex with its witness data (empty when it could not be had). */
  originalTxHex: string;
  /** The previous transactions of the original's inputs, by txid (raw hex, witness data or not). */
  parents: ReadonlyMap<string, string>;
  /** The unsigned replacement (`buildBumpPsbt`). */
  replacementPsbt: Uint8Array;
}

const fail = (reason: FeeBumpCheckReason, message: string): never => {
  throw new FeeBumpCheckError(reason, message);
};

/** An ECDSA signature with its sighash byte, checked as SIGHASH_ALL over `msg` by `pubkey` (DER, as consensus reads it). */
function verifySig(sigWithType: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    return secp256k1.verify(sigWithType.slice(0, -1), msg, pubkey, { prehash: false, format: 'der', lowS: false });
  } catch {
    return false;
  }
}

/** Throws `FeeBumpCheckError` unless the replacement is a fee bump of a payment this wallet signed (see the file comment). */
export function checkFeeBump(input: FeeBumpCheckInput): void {
  const { wallet } = input;

  // 1. The original is the payment the wallet recorded.
  if (!input.originalTxHex) fail('original_missing', 'The original payment could not be found.');
  let raw: ReturnType<typeof btc.RawTx.decode>;
  try {
    raw = btc.RawTx.decode(hex.decode(input.originalTxHex));
  } catch {
    return fail('original_unreadable', 'The original payment could not be read.');
  }
  let txid: string;
  try {
    txid = txidOfRaw(input.originalTxHex);
  } catch {
    return fail('original_unreadable', 'The original payment could not be read.');
  }
  if (txid !== input.originalTxid) fail('original_txid_mismatch', 'The original payment is not the one the wallet recorded.');
  if (!raw.inputs.length) fail('original_unreadable', 'The original payment spends nothing.');
  const witnesses = raw.witnesses;
  if (!raw.segwitFlag || !witnesses || witnesses.length !== raw.inputs.length || witnesses.some((w) => !w.length))
    fail('original_unsigned', 'The original payment came without its signatures.');
  const original = btc.Transaction.fromRaw(hex.decode(input.originalTxHex), { ...TX_OPTS, allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });

  // 2. Every input of the original is one of this wallet's coins, and 3. this wallet signed it.
  const originalOutpoints: { key: string; amount: bigint; script: Uint8Array }[] = [];
  raw.inputs.forEach((inp, i) => {
    const prevTxid = hex.encode(inp.txid);
    const parentHex = input.parents.get(prevTxid);
    if (!parentHex) return fail('parent_missing', 'A coin this payment spends could not be checked.');
    let parentId: string | undefined;
    let prevOut: { script: Uint8Array; amount: bigint } | undefined;
    try {
      parentId = txidOfRaw(parentHex);
      prevOut = btc.RawTx.decode(hex.decode(parentHex)).outputs[inp.index];
    } catch {
      /* below */
    }
    if (parentId !== prevTxid || !prevOut) return fail('parent_txid_mismatch', 'A coin this payment spends does not match its transaction.');
    const place = input.pathOf(prevOut.script);
    const derived = place ? wallet.derive(place.chain, place.index) : undefined;
    if (!derived || compareBytes(derived.script, prevOut.script) !== 0) return fail('foreign_input', 'This payment spends a coin that is not this wallet\'s.');

    const w = witnesses![i]!;
    const witnessScript = w[w.length - 1]!;
    if (w.length !== 4 || compareBytes(witnessScript, derived.witnessScript) !== 0) return fail('witness_script_mismatch', 'This payment was not signed with this wallet\'s keys.');
    if (w[0]!.length !== 0) return fail('bad_signature', 'This payment was not signed with this wallet\'s keys.');
    const sigs = [w[1]!, w[2]!];
    if (sigs.some((s) => s.length < 9 || s[s.length - 1] !== btc.SigHash.ALL)) return fail('bad_sighash', 'This payment was signed in a way Trikey never signs.');
    const msg = original.preimageWitnessV0(i, derived.witnessScript, btc.SigHash.ALL, prevOut.amount);
    // OP_CHECKMULTISIG reads the signatures in the order of the (sorted) keys: each must match a later key than the last.
    const keys = ROLES.map((r) => derived.pubkeys[r]).sort(compareBytes);
    let next = 0;
    for (const sig of sigs) {
      while (next < keys.length && !verifySig(sig, msg, keys[next]!)) next++;
      if (next >= keys.length) return fail('bad_signature', 'This payment was not signed with this wallet\'s keys.');
      next++;
    }
    originalOutpoints.push({ key: `${prevTxid}:${inp.index}`, amount: prevOut.amount, script: prevOut.script });
  });

  // 4. The replacement spends exactly the original's inputs, each once.
  let replacement: btc.Transaction;
  try {
    replacement = btc.Transaction.fromPSBT(input.replacementPsbt, { ...TX_OPTS, allowUnknownOutputs: true });
  } catch {
    return fail('replacement_unreadable', 'The faster payment could not be read.');
  }
  const byKey = new Map(originalOutpoints.map((o) => [o.key, o]));
  const seen = new Set<string>();
  for (let i = 0; i < replacement.inputsLength; i++) {
    const inp = replacement.getInput(i);
    if (!inp.txid || inp.index === undefined) return fail('replacement_unreadable', 'The faster payment could not be read.');
    const key = `${hex.encode(inp.txid)}:${inp.index}`;
    if (seen.has(key)) return fail('input_duplicated', 'The faster payment spends a coin twice.');
    seen.add(key);
    const orig = byKey.get(key);
    if (!orig) return fail('input_added', 'The faster payment spends a coin the original did not.');
    // What the signers will be told the coin holds is what it holds.
    const wu = inp.witnessUtxo;
    if (wu && (wu.amount !== orig.amount || compareBytes(wu.script, orig.script) !== 0)) return fail('replacement_prevout_mismatch', 'The faster payment describes a coin wrongly.');
    if (inp.nonWitnessUtxo) {
      const nw = inp.nonWitnessUtxo;
      const nwHex = hex.encode(btc.RawTx.encode(nw));
      const out = nw.outputs[inp.index];
      if (txidOfRaw(nwHex) !== hex.encode(inp.txid) || !out || out.amount !== orig.amount || compareBytes(out.script, orig.script) !== 0)
        return fail('replacement_prevout_mismatch', 'The faster payment describes a coin wrongly.');
    }
  }
  for (const o of originalOutpoints) if (!seen.has(o.key)) return fail('input_dropped', 'The faster payment leaves out a coin of the original.');

  // 5. Every output of the original is paid exactly, but the wallet's own change, which alone may shrink (or go).
  const isChange = (script: Uint8Array) => {
    const place = input.pathOf(script);
    return place?.chain === 1 && compareBytes(wallet.derive(1, place.index).script, script) === 0;
  };
  const left = raw.outputs.map((o) => ({ script: o.script, amount: o.amount, change: isChange(o.script), used: false }));
  let changesTouched = 0;
  let added = 0;
  for (let i = 0; i < replacement.outputsLength; i++) {
    const o = replacement.getOutput(i);
    if (!o.script || o.amount === undefined) return fail('replacement_unreadable', 'The faster payment could not be read.');
    const same = left.find((x) => !x.used && x.amount === o.amount && compareBytes(x.script, o.script!) === 0);
    if (same) {
      same.used = true;
      continue;
    }
    const change = left.find((x) => !x.used && x.change && compareBytes(x.script, o.script!) === 0);
    if (change) {
      if (o.amount > change.amount) return fail('change_invalid', 'The faster payment gives the wallet more change than the original.');
      change.used = true;
      changesTouched++;
      continue;
    }
    added++;
  }
  // A payment of the original left out or altered (its amount or its address) says more than "an output was added".
  for (const x of left) {
    if (x.used) continue;
    if (!x.change) return fail('output_changed', 'The faster payment changes what the original pays.');
    changesTouched++;
  }
  if (added) fail('output_added', 'The faster payment pays someone the original did not.');
  if (changesTouched > 1) fail('change_invalid', 'The faster payment changes more than the wallet\'s change.');
}
