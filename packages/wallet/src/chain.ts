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
  /** Which wallet this is, when the source says (the guardian does: the replaced wallet's id for `wallet: "replaced"`). */
  walletId?: string;
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
  /** Raw transaction hex (witness data may be left out), checked to hash to `txid`. For PSBT `nonWitnessUtxo`. */
  getTransaction(txid: string): Promise<string>;
  /** Broadcasts a fully signed transaction; resolves with its txid. */
  broadcast(txHex: string): Promise<string>;
  estimateFees(targets?: number[]): Promise<FeeEstimates>;
}

/** An unspent output found by its script. */
export interface ScriptUtxo {
  /** scriptPubKey, hex. */
  script: string;
  txid: string;
  vout: number;
  valueSats: number;
  /** 0 while unconfirmed. */
  height: number;
  confirmations: number;
}

/**
 * Chain data by output script, for the phone's own single-key coins: the helper coin (P2WPKH) and received silent
 * payments (P2TR). The guardian's `wallet.sync` serves only the vault and its `tx.broadcast` only relays spends of
 * vault coins, so these come from here: today the user's own Electrum/Esplora server (or a test double); later
 * the guardian, once its protocol serves scripts (DESIGN.md, "Silent payments").
 */
export interface SingleKeyChainSource {
  readonly kind: string;
  tipHeight(): Promise<number>;
  /** Unspent outputs paying any of `scripts` (hex scriptPubKeys), mempool included. */
  unspent(scripts: string[]): Promise<ScriptUtxo[]>;
  /** The scripts among `scripts` that ever received a coin (for the helper's address gap). */
  used(scripts: string[]): Promise<string[]>;
  /** Raw transaction hex (witness data may be left out); the wallet checks it hashes to `txid`. */
  getTransaction(txid: string): Promise<string>;
  /** Broadcasts a fully signed transaction; resolves with its txid. */
  broadcast(txHex: string): Promise<string>;
  estimateFees?(targets?: number[]): Promise<FeeEstimates>;
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

  /**
   * `wallet: "replaced"` (or the replaced wallet's id) reads the wallet the guardian watches for "Replace guardian"
   * instead of the paired one; its coins and previous transactions come from here, and a sweep of them is relayed
   * into the paired wallet. Default: the paired wallet.
   */
  constructor(
    private readonly rpc: () => GuardianRpc,
    private readonly opts: { timeoutMs?: number; wallet?: string } = {},
  ) {}

  private async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    try {
      return await this.rpc().call(method, params, { timeoutMs: this.opts.timeoutMs });
    } catch (e) {
      throw asWalletError(e, method);
    }
  }

  sync(opts: { historyLimit?: number } = {}): Promise<ChainSnapshot> {
    return this.call('wallet.sync', { ...(opts.historyLimit ? { historyLimit: opts.historyLimit } : {}), ...(this.opts.wallet ? { wallet: this.opts.wallet } : {}) });
  }

  async getTransaction(txid: string): Promise<string> {
    // Without witness data: same txid, all nonWitnessUtxo needs, and it keeps large transactions within a message.
    const { txHex } = await this.call('tx.get', { txid, witness: false });
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

/**
 * When an alert happened, in unix milliseconds on the guardian's clock: its `atMs`, or `at` (seconds) times 1000 from a
 * guardian that predates `atMs`.
 */
export function alertTimeMs(a: { at: number; atMs?: number }): number {
  return a.atMs ?? a.at * 1000;
}
