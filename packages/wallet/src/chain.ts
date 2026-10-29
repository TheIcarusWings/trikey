/**
 * Where the wallet gets chain data and broadcasts.
 *
 * In guardian mode the guardian serves both from the user's own Electrs
 * (`GuardianChainSource`), so the phone never talks to a public server. A
 * Recovery Key mode wallet, which has no guardian, would plug an Esplora or
 * Electrum implementation in here; the wallet only depends on this interface.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Alert, FeeEstimate, HistoryEntry, MethodName, Params, Result, WalletUtxo } from '@trikey/protocol';
import { WalletError, asWalletError } from './errors.js';

/** Everything one sync returns; the shape of the protocol's `wallet.sync` result. */
export interface ChainSnapshot {
  tipHeight: number;
  tipHash: string;
  utxos: WalletUtxo[];
  utxosTruncated: boolean;
  balance: { confirmedSats: number; unconfirmedSats: number };
  history: HistoryEntry[];
  historyTruncated: boolean;
  nextReceiveIndex: number;
  nextChangeIndex: number;
  gapLimit: number;
}

export interface FeeEstimates {
  estimates: FeeEstimate[];
  minRelaySatPerVb: number;
}

export interface ChainSource {
  readonly kind: string;
  sync(opts?: { historyLimit?: number }): Promise<ChainSnapshot>;
  /** Raw transaction hex, checked to hash to `txid`. */
  getTransaction(txid: string): Promise<string>;
  /** Broadcasts a fully signed transaction; resolves with its txid. */
  broadcast(txHex: string): Promise<string>;
  estimateFees(targets?: number[]): Promise<FeeEstimates>;
}

/** The subset of `RpcClient` the wallet uses (tests and other transports can stand in). */
export interface GuardianRpc {
  readonly publicKey: string;
  start(): Promise<void>;
  close(): void;
  call<M extends MethodName>(method: M, params: Params<M>, opts?: { timeoutMs?: number; id?: string; retryIntervalMs?: number }): Promise<Result<M>>;
  onAlert(handler: (alert: Alert, meta: { id: string; at: number }) => void): () => void;
}

/** txid of a raw transaction: double SHA-256 of the serialization without witnesses, byte-reversed. */
export function txidOfRaw(txHex: string): string {
  let raw: ReturnType<typeof btc.RawTx.decode>;
  try {
    raw = btc.RawTx.decode(hex.decode(txHex));
  } catch (e) {
    throw new WalletError('internal', 'not a valid raw transaction', { cause: e });
  }
  const stripped = btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined });
  return hex.encode(sha256(sha256(stripped)).reverse());
}

/** Chain data through the paired guardian (`wallet.sync`, `tx.get`, `tx.broadcast`, `fees.estimate`). */
export class GuardianChainSource implements ChainSource {
  readonly kind = 'guardian';

  constructor(
    private readonly rpc: () => GuardianRpc,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  private async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    try {
      return await this.rpc().call(method, params, { timeoutMs: this.opts.timeoutMs });
    } catch (e) {
      throw asWalletError(e, method);
    }
  }

  sync(opts: { historyLimit?: number } = {}): Promise<ChainSnapshot> {
    return this.call('wallet.sync', opts.historyLimit ? { historyLimit: opts.historyLimit } : {});
  }

  async getTransaction(txid: string): Promise<string> {
    const { txHex } = await this.call('tx.get', { txid });
    // The guardian checked this too; a phone does not take a previous transaction on trust.
    if (txidOfRaw(txHex) !== txid) throw new WalletError('guardian_mismatch', `tx.get returned a transaction that is not ${txid}`);
    return txHex;
  }

  async broadcast(txHex: string): Promise<string> {
    const { txid } = await this.call('tx.broadcast', { txHex });
    const own = txidOfRaw(txHex);
    if (txid !== own) throw new WalletError('guardian_mismatch', `tx.broadcast reported txid ${txid}, expected ${own}`);
    return txid;
  }

  estimateFees(targets?: number[]): Promise<FeeEstimates> {
    return this.call('fees.estimate', targets ? { targets } : {});
  }
}
