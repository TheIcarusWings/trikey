/**
 * Synthetic transactions and blocks for the silent payment scanner's tests: P2WPKH-funded
 * transactions paying taproot outputs (silent payments to a receiver, or random keys), in the shape
 * of `getblock <hash> 3`. Signatures are dummies: BIP 352 reads only the public keys, and nothing
 * here is checked by a node. Throwaway keys, regtest only.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { createOutputs } from '@trikey/silent-payments';
import type { VerboseBlock, VerboseTx } from '../../src/chain/bitcoind.js';

const rawTxid = (raw: Uint8Array) => {
  const tx = btc.RawTx.decode(raw);
  return hex.encode(sha256(sha256(btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }))).reverse());
};

/** A deterministic private key from a counter. */
export const keyOf = (n: number) => sha256(new TextEncoder().encode(`sp-test-key-${n}`));

/**
 * A transaction spending `inputs` P2WPKH coins (keys from `seed`) and paying `taprootOutputs` taproot
 * outputs (silent payment outputs for `recipients`, else random keys) plus one P2WPKH change output.
 */
export function syntheticTx(seed: number, opts: { inputs?: number; taprootOutputs?: number; recipients?: string[] } = {}): VerboseTx {
  const nIn = opts.inputs ?? 1;
  const keys = Array.from({ length: nIn }, (_, i) => keyOf(seed * 16 + i));
  const pubs = keys.map((k) => secp256k1.getPublicKey(k, true));
  const prevTxids = keys.map((_, i) => hex.encode(sha256(new TextEncoder().encode(`prev-${seed}-${i}`))));
  const prevScripts = pubs.map((p) => btc.p2wpkh(p).script);
  const outputs: { script: Uint8Array; amount: bigint }[] = [];
  if (opts.recipients?.length) {
    const r = createOutputs({
      inputs: prevTxids.map((txid, i) => ({ txid, vout: 0, prevoutScript: prevScripts[i]!, privateKey: keys[i]! })),
      recipients: opts.recipients,
    });
    for (const o of r.outputs) outputs.push({ script: o.script, amount: 30_000n });
  } else {
    for (let i = 0; i < (opts.taprootOutputs ?? 1); i++) outputs.push({ script: btc.p2tr(secp256k1.getPublicKey(keyOf(1_000_000 + seed * 8 + i), true).slice(1)).script, amount: 25_000n });
  }
  outputs.push({ script: btc.p2wpkh(secp256k1.getPublicKey(keyOf(2_000_000 + seed), true)).script, amount: 10_000n });
  const dummySig = new Uint8Array(71).fill(0x30);
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: true,
    inputs: prevTxids.map((txid) => ({ txid: hex.decode(txid), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xfffffffd })),
    outputs,
    witnesses: pubs.map((p) => [dummySig, p]),
    lockTime: 0,
  });
  return {
    txid: rawTxid(raw),
    hex: hex.encode(raw),
    vin: prevTxids.map((txid, i) => ({ txid, vout: 0, prevout: { value: 0.001, scriptPubKey: { hex: hex.encode(prevScripts[i]!) } } })),
    vout: outputs.map((o, n) => ({ value: Number(o.amount) / 1e8, n, scriptPubKey: { hex: hex.encode(o.script) } })),
  };
}

/** A P2WPKH-only payment (no taproot output): what the scanner skips before any curve work. */
export function legacyTx(seed: number): VerboseTx {
  const tx = syntheticTx(seed, { taprootOutputs: 0 });
  return tx;
}

/** A block of `n` transactions, `taprootShare` of them with a taproot output, plus `extra` at the end. */
export function syntheticBlock(n: number, opts: { taprootShare?: number; height?: number; extra?: VerboseTx[] } = {}): VerboseBlock {
  const share = opts.taprootShare ?? 1;
  const tx: VerboseTx[] = [{ txid: '00'.repeat(32), hex: '', vin: [{ coinbase: '03' }], vout: [{ value: 50, n: 0, scriptPubKey: { hex: '51' } }] }];
  for (let i = 0; i < n; i++) tx.push(i < Math.round(n * share) ? syntheticTx(i) : legacyTx(i));
  tx.push(...(opts.extra ?? []));
  return { hash: 'aa'.repeat(32), height: opts.height ?? 100, confirmations: 1, tx };
}
