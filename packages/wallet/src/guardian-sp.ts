/**
 * The phone's single-key coins and its silent payment scanner, served by the guardian instead of a public server.
 * DESIGN.md, "Silent payments", "The wallet's side".
 *
 * - `GuardianSingleKeyChain` implements `SingleKeyChainSource` with `wallet.sync` (`wallet: "helper"`), `tx.get`,
 *   `tx.broadcast` and `fees.estimate`: the helper coin's balance, the received silent payments (by script), the
 *   previous transactions of both, and the broadcast of a sweep into the vault. In guardian mode it is the wallet's
 *   default `singleKeyChain`.
 * - `GuardianSilentPaymentScanner` implements `SilentPaymentScanner` with `sp.scan`. It is the default scanner in
 *   guardian mode; the wallet still checks every match against its spend key.
 *
 * Both take a function returning the phone's guardian client, so they follow the wallet when it reconnects or moves
 * to another guardian.
 */
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import type { MethodName, Params, Result } from '@trikey/protocol';
import type { FeeEstimates, ScriptUtxo, SingleKeyChainSource } from './chain.js';
import { txidOfRaw } from './chain.js';
import { WalletError, asWalletError } from './errors.js';
import type { SilentPaymentMatch, SilentPaymentScanner } from './silent.js';

/** The part of the guardian client these need. */
export interface RpcLike {
  call<M extends MethodName>(method: M, params: Params<M>, opts?: { timeoutMs?: number }): Promise<Result<M>>;
}

async function guardianCall<M extends MethodName>(rpc: RpcLike, method: M, params: Params<M>, timeoutMs?: number): Promise<Result<M>> {
  try {
    return await rpc.call(method, params, timeoutMs === undefined ? undefined : { timeoutMs });
  } catch (e) {
    throw asWalletError(e, method);
  }
}

/** How long one `wallet.sync` answer serves the several lookups of a single sync of the wallet. */
const SNAPSHOT_TTL_MS = 10_000;

export class GuardianSingleKeyChain implements SingleKeyChainSource {
  readonly kind = 'guardian';
  private cached?: { at: number; value: Promise<Result<'wallet.sync'>> };
  private account?: { xpub: string; hd: HDKey };

  /**
   * @param rpc the guardian client (the wallet's, which changes when it moves to another guardian)
   * @param helper the helper account's xpub, to tell used helper scripts from unused ones (the wallet has it)
   */
  constructor(
    private readonly rpc: () => RpcLike,
    private readonly helper?: () => { xpub: string; versions: { public: number; private: number } } | undefined,
    private readonly opts: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  /** Forget the last `wallet.sync` answer: the next lookup asks the guardian again. */
  refresh(): void {
    this.cached = undefined;
  }

  private sync(): Promise<Result<'wallet.sync'>> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && now - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.value;
    const value = guardianCall(this.rpc(), 'wallet.sync', { wallet: 'helper', historyLimit: 1 }, this.opts.timeoutMs);
    this.cached = { at: now, value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = undefined; // never keep a failure
    });
    return value;
  }

  async tipHeight(): Promise<number> {
    return (await this.sync()).tipHeight;
  }

  async unspent(scripts: string[]): Promise<ScriptUtxo[]> {
    const want = new Set(scripts);
    const r = await this.sync();
    const all: ScriptUtxo[] = [
      ...r.utxos.flatMap((u) => (u.script ? [{ script: u.script, txid: u.txid, vout: u.vout, valueSats: u.valueSats, height: u.height, confirmations: u.confirmations }] : [])),
      ...(r.coins ?? []),
    ];
    return all.filter((u) => want.has(u.script));
  }

  /** Helper scripts below the guardian's next unused index on their chain (the wallet only needs the highest used one). */
  async used(scripts: string[]): Promise<string[]> {
    const h = this.helper?.();
    if (!h) return [];
    if (this.account?.xpub !== h.xpub) this.account = { xpub: h.xpub, hd: HDKey.fromExtendedKey(h.xpub, h.versions) };
    const r = await this.sync();
    const next = { 0: r.nextReceiveIndex, 1: r.nextChangeIndex } as const;
    const usedScripts = new Set<string>();
    for (const chain of [0, 1] as const)
      for (let i = 0; i < next[chain]; i++) usedScripts.add(hex.encode(btc.p2wpkh(this.account.hd.deriveChild(chain).deriveChild(i).publicKey!).script));
    return scripts.filter((s) => usedScripts.has(s));
  }

  async getTransaction(txid: string): Promise<string> {
    const { txHex } = await guardianCall(this.rpc(), 'tx.get', { txid, witness: false }, this.opts.timeoutMs);
    if (txidOfRaw(txHex) !== txid) throw new WalletError('guardian_mismatch', `tx.get returned a transaction that is not ${txid}`);
    return txHex;
  }

  async broadcast(txHex: string): Promise<string> {
    this.refresh();
    const { txid } = await guardianCall(this.rpc(), 'tx.broadcast', { txHex }, this.opts.timeoutMs);
    const own = txidOfRaw(txHex);
    if (txid !== own) throw new WalletError('guardian_mismatch', `tx.broadcast reported txid ${txid}, expected ${own}`);
    return txid;
  }

  estimateFees(targets?: number[]): Promise<FeeEstimates> {
    return guardianCall(this.rpc(), 'fees.estimate', targets ? { targets } : {}, this.opts.timeoutMs);
  }
}

/** What the guardian says about its scan, next to the matches. */
export interface GuardianScanResult {
  tipHeight: number;
  matches: SilentPaymentMatch[];
  /** The guardian's scanner is still catching up with the node. */
  scanning: boolean;
  birthHeight: number;
  /** More matches than one answer holds: ask again from the last height. */
  matchesTruncated: boolean;
}

/** The guardian scans; the wallet still checks every match against its spend key (`SilentPaymentReceiver.verify`). */
export class GuardianSilentPaymentScanner implements SilentPaymentScanner {
  constructor(
    private readonly rpc: () => RpcLike,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  async scan(fromHeight: number): Promise<GuardianScanResult> {
    const r = await guardianCall(this.rpc(), 'sp.scan', { fromHeight: Math.max(0, fromHeight) }, this.opts.timeoutMs);
    return { tipHeight: r.tipHeight, matches: r.matches.map((m) => ({ ...m })), scanning: r.scanning, birthHeight: r.birthHeight, matchesTruncated: r.matchesTruncated };
  }
}
