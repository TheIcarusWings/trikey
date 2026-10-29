/**
 * The two pieces `@trikey/wallet` needs to take its single-key coins and its silent payment scanner from
 * the guardian instead of a public server, written against the wallet's own interfaces so the tests
 * can run the real wallet on them. They are the reference for the wallet's change (DESIGN.md,
 * "Silent payments"):
 *
 * - `GuardianSingleKeyChain` implements `SingleKeyChainSource` with `wallet.sync` (`wallet: "helper"`),
 *   `tx.get`, `tx.broadcast` and `fees.estimate`;
 * - `GuardianSilentPaymentScanner` implements `SilentPaymentScanner` with `sp.scan`.
 *
 * Both take a function returning the phone's RPC client (the wallet's `client()`), and the first one
 * the helper account's xpub (the wallet holds it), to tell used helper scripts from unused ones.
 */
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import type { MethodName, Params, Result } from '@trikey/protocol';
import type { FeeEstimates, ScriptUtxo, SilentPaymentMatch, SilentPaymentScanner, SingleKeyChainSource } from '@trikey/wallet';

export interface RpcLike {
  call<M extends MethodName>(method: M, params: Params<M>, opts?: { timeoutMs?: number }): Promise<Result<M>>;
}

const txidOf = (txHex: string) => {
  const raw = btc.RawTx.decode(hex.decode(txHex));
  return hex.encode(sha256(sha256(btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined }))).reverse());
};

export class GuardianSingleKeyChain implements SingleKeyChainSource {
  readonly kind = 'guardian';
  private readonly account?: HDKey;

  constructor(
    private readonly rpc: () => RpcLike,
    helper?: { xpub: string; versions: { public: number; private: number } },
  ) {
    if (helper) this.account = HDKey.fromExtendedKey(helper.xpub, helper.versions);
  }

  private sync() {
    return this.rpc().call('wallet.sync', { wallet: 'helper', historyLimit: 1 });
  }

  async tipHeight(): Promise<number> {
    return (await this.sync()).tipHeight;
  }

  async unspent(scripts: string[]): Promise<ScriptUtxo[]> {
    const want = new Set(scripts);
    const r = await this.sync();
    const all = [
      ...r.utxos.flatMap((u) => (u.script ? [{ script: u.script, txid: u.txid, vout: u.vout, valueSats: u.valueSats, height: u.height, confirmations: u.confirmations }] : [])),
      ...(r.coins ?? []),
    ];
    return all.filter((u) => want.has(u.script));
  }

  /** Helper scripts below the guardian's next unused index on their chain (the wallet only needs the highest used one). */
  async used(scripts: string[]): Promise<string[]> {
    if (!this.account) return [];
    const r = await this.sync();
    const next = { 0: r.nextReceiveIndex, 1: r.nextChangeIndex } as const;
    const usedScripts = new Set<string>();
    for (const chain of [0, 1] as const) for (let i = 0; i < next[chain]; i++) usedScripts.add(hex.encode(btc.p2wpkh(this.account.deriveChild(chain).deriveChild(i).publicKey!).script));
    return scripts.filter((s) => usedScripts.has(s));
  }

  async getTransaction(txid: string): Promise<string> {
    const { txHex } = await this.rpc().call('tx.get', { txid, witness: false });
    if (txidOf(txHex) !== txid) throw new Error(`tx.get returned a transaction that is not ${txid}`);
    return txHex;
  }

  async broadcast(txHex: string): Promise<string> {
    const { txid } = await this.rpc().call('tx.broadcast', { txHex });
    return txid;
  }

  estimateFees(targets?: number[]): Promise<FeeEstimates> {
    return this.rpc().call('fees.estimate', targets ? { targets } : {});
  }
}

/** The guardian scans; the wallet still checks every match against its spend key (`SilentPaymentReceiver.verify`). */
export class GuardianSilentPaymentScanner implements SilentPaymentScanner {
  constructor(private readonly rpc: () => RpcLike) {}

  async scan(fromHeight: number): Promise<{ tipHeight: number; matches: SilentPaymentMatch[] }> {
    const r = await this.rpc().call('sp.scan', { fromHeight });
    return { tipHeight: r.tipHeight, matches: r.matches.map((m) => ({ ...m })) };
  }
}
