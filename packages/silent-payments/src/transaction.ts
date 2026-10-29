/**
 * Raw transactions to BIP 352's input/output view. A scanner gets blocks with each input's previous output (what
 * bitcoind's `getblock <hash> 3` returns as `prevout`), or looks them up itself.
 */
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from './curve.js';
import { SilentPaymentError } from './errors.js';
import type { TxInput } from './inputs.js';

export interface PrevoutLike {
  /** scriptPubKey, bytes or hex. */
  script: Uint8Array | string;
  /** Satoshis (not needed for the tweak; kept for callers). */
  amount?: bigint | number;
}

export interface ParsedTransaction {
  txid: string;
  inputs: TxInput[];
  outputs: { script: Uint8Array; amount: bigint }[];
}

const asBytes = (b: Uint8Array | string) => (typeof b === 'string' ? hexToBytes(b) : b);

/** Splits a raw transaction (with witnesses) into BIP 352's view, given one prevout per input in input order. */
export function parseTransaction(raw: Uint8Array | string, prevouts: PrevoutLike[]): ParsedTransaction {
  let tx: ReturnType<typeof btc.RawTx.decode>;
  const bytes = asBytes(raw);
  try {
    tx = btc.RawTx.decode(bytes);
  } catch (e) {
    throw new SilentPaymentError('invalid_argument', `not a raw transaction: ${(e as Error).message}`);
  }
  if (prevouts.length !== tx.inputs.length)
    throw new SilentPaymentError('invalid_argument', `the transaction has ${tx.inputs.length} inputs but ${prevouts.length} prevouts were given`);
  const inputs: TxInput[] = tx.inputs.map((inp, i) => ({
    // RawTx gives the txid in display order.
    txid: bytesToHex(inp.txid),
    vout: inp.index,
    prevoutScript: asBytes(prevouts[i]!.script),
    scriptSig: inp.finalScriptSig ?? new Uint8Array(),
    witness: tx.witnesses?.[i] ?? [],
  }));
  const outputs = tx.outputs.map((o) => ({ script: o.script, amount: o.amount }));
  const stripped = btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined });
  return { txid: txidOf(stripped), inputs, outputs };
}

/** Double SHA-256 of the serialization without witnesses, displayed reversed. */
function txidOf(stripped: Uint8Array): string {
  return bytesToHex(sha256(sha256(stripped)).reverse());
}

/** Parses a BIP 141 witness serialized as in `getrawtransaction` (`txinwitness`) or the test vectors: count, then items. */
export function parseSerializedWitness(data: Uint8Array | string): Uint8Array[] {
  const b = asBytes(data);
  if (!b.length) return [];
  let o = 0;
  const varint = (): number => {
    const first = b[o++];
    if (first === undefined) throw new SilentPaymentError('invalid_argument', 'truncated witness');
    if (first < 0xfd) return first;
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let v = 0;
    for (let i = 0; i < size; i++) v += (b[o + i] ?? 0) * 2 ** (8 * i);
    o += size;
    return v;
  };
  const n = varint();
  const items: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const len = varint();
    if (o + len > b.length) throw new SilentPaymentError('invalid_argument', 'truncated witness');
    items.push(b.slice(o, o + len));
    o += len;
  }
  return items;
}
