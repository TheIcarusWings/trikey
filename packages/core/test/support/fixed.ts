/**
 * Deterministic PSBTs for golden tests: funding transactions with fixed txids, a fixed wallet and
 * a fixed single-key "helper" key (P2WPKH), so every byte is the same on every run. Throwaway test
 * keys on regtest only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { TX_OPTS, type MultisigWallet } from '../../src/wallet.js';
import type { Utxo } from '../../src/psbt.js';
import { network } from './signing.js';

/** A funding transaction (from a fake input) paying `value` to `script`, with a txid fixed by `seed`. */
export function fundScriptFixed(script: Uint8Array, value: bigint, seed: number): { txid: string; vout: number; value: bigint; prevTxHex: string } {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: sha256(Uint8Array.of(seed, 0xa5)), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: value }],
    lockTime: 0,
  });
  return { txid: hex.encode(sha256(sha256(raw)).reverse()), vout: 0, value, prevTxHex: hex.encode(raw) };
}

/** A vault coin at (chain, index) with a fixed txid. */
export function fundFixed(wallet: MultisigWallet, chain: number, index: number, value: bigint, seed: number): Utxo {
  return { ...fundScriptFixed(wallet.derive(chain, index).script, value, seed), chain, index };
}

/** A single-key P2WPKH key (the phone's helper coin in the wallet), fixed by `seed`. */
export function helperKey(seed = 21) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = secp256k1.getPublicKey(priv, true);
  return { priv, pub, script: btc.p2wpkh(pub).script };
}

export const p2trScript = (seed = 4) => btc.p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true).slice(1)).script;
export const p2wpkhScript = (seed = 3) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true)).script;

export interface MixedInput {
  kind: 'vault';
  utxo: Utxo;
}
export interface HelperInputSpec {
  kind: 'helper';
  coin: { txid: string; vout: number; value: bigint; prevTxHex?: string };
  script: Uint8Array;
}

/**
 * A PSBT spending vault coins (with the wallet's PSBT fields) and helper coins (P2WPKH, with
 * `nonWitnessUtxo` unless left out), in the given order, paying `outputs`; `self` outputs carry the
 * wallet's fields for (chain, index).
 */
export function mixedPsbt(
  wallet: MultisigWallet,
  inputs: (MixedInput | HelperInputSpec)[],
  outputs: ({ script: Uint8Array; amount: bigint } | { self: { chain: number; index: number }; amount: bigint })[],
): Uint8Array {
  const tx = new btc.Transaction(TX_OPTS);
  for (const i of inputs) {
    if (i.kind === 'vault') {
      const d = wallet.derive(i.utxo.chain, i.utxo.index);
      tx.addInput({
        txid: i.utxo.txid,
        index: i.utxo.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script: d.script, amount: i.utxo.value },
        ...(i.utxo.prevTxHex ? { nonWitnessUtxo: hex.decode(i.utxo.prevTxHex) } : {}),
        sighashType: btc.SigHash.ALL,
        ...wallet.psbtFields(d),
      });
    } else {
      tx.addInput({
        txid: i.coin.txid,
        index: i.coin.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script: i.script, amount: i.coin.value },
        ...(i.coin.prevTxHex ? { nonWitnessUtxo: hex.decode(i.coin.prevTxHex) } : {}),
        sighashType: btc.SigHash.ALL,
      });
    }
  }
  for (const o of outputs) {
    if ('self' in o) {
      const d = wallet.derive(o.self.chain, o.self.index);
      tx.addOutput({ script: d.script, amount: o.amount, ...wallet.psbtFields(d) });
    } else tx.addOutput({ script: o.script, amount: o.amount });
  }
  return tx.toPSBT();
}

/** Signs input `index` (a P2WPKH helper input) with `priv` under SIGHASH_ALL and finalizes it. */
export function signAndFinalizeHelper(psbt: Uint8Array, index: number, priv: Uint8Array, opts: { finalize?: boolean } = {}): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
  tx.signIdx(priv, index, [btc.SigHash.ALL]);
  if (opts.finalize !== false) tx.finalizeIdx(index);
  return tx.toPSBT();
}

export { network };
