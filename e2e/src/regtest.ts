/**
 * The regtest chain behind docker-compose.yml, driven through bitcoind's RPC: a funding wallet that mines and pays,
 * block mining, the node's clock, and the node's own opinion of a transaction.
 *
 * Time: the node's clock (`setmocktime`) only ever moves forward. A block carries the node's time, and Core refuses a
 * block more than two hours ahead of its own clock, so putting the clock back after blocks were mined "in the future"
 * would stop all mining. `syncTime` therefore never goes below the tip's time.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { NETWORKS } from '@trikey/core';
import type { E2eConfig } from './config.js';
import { probeElectrum } from './electrum-probe.js';
import { NodeRpc, NodeRpcError, btcAmount, type BlockchainInfo, type NodeTx, type TestMempoolAccept } from './node-rpc.js';
import { waitFor } from './wait.js';

/** Coinbase maturity is 100 blocks: the first reward is spendable once the chain is 101 blocks long. */
export const MATURE_HEIGHT = 101;

export interface NodeFunding {
  txid: string;
  vout: number;
  value: bigint;
  /** The transaction as the node serialized it (with witness). */
  rawTx: string;
}

export const addressOfScript = (script: Uint8Array): string => btc.Address(NETWORKS.regtest.btc).encode(btc.OutScript.decode(script));

export class RegtestChain {
  readonly node: NodeRpc;
  /** The node through the funding wallet. */
  readonly wallet: NodeRpc;
  private miningAddress?: string;

  constructor(readonly cfg: E2eConfig) {
    this.node = new NodeRpc(cfg.bitcoind);
    this.wallet = this.node.wallet(cfg.fundingWallet);
  }

  /** Waits for bitcoind's RPC (it answers errors while it loads the block index). */
  async waitForNode(timeoutMs = 120_000): Promise<BlockchainInfo> {
    return waitFor(() => this.info(), `bitcoind's RPC at ${this.node.url}`, { timeoutMs, intervalMs: 500 });
  }

  info(): Promise<BlockchainInfo> {
    return this.node.call<BlockchainInfo>('getblockchaininfo');
  }

  async height(): Promise<number> {
    return this.node.call<number>('getblockcount');
  }

  async ensureFundingWallet(): Promise<void> {
    const name = this.cfg.fundingWallet;
    if ((await this.node.call<string[]>('listwallets')).includes(name)) return;
    try {
      await this.node.call('loadwallet', [name]);
    } catch (loadError) {
      if (!(loadError instanceof NodeRpcError)) throw loadError;
      await this.node.call('createwallet', { wallet_name: name });
    }
  }

  /** Mines to the funding wallet's own address, so the rewards pay for the tests. */
  async miningTo(): Promise<string> {
    this.miningAddress ??= await this.wallet.call<string>('getnewaddress', { label: 'mining', address_type: 'bech32' });
    return this.miningAddress;
  }

  async mine(count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1) throw new RangeError('mine at least one block');
    return this.node.call<string[]>('generatetoaddress', [count, await this.miningTo()]);
  }

  /** The funding wallet exists and has spendable coins (101 blocks mined). Safe to call again. */
  async prepare(): Promise<{ height: number; balanceSats: bigint }> {
    await this.waitForNode();
    await this.ensureFundingWallet();
    const height = await this.height();
    if (height < MATURE_HEIGHT) await this.mine(MATURE_HEIGHT - height);
    let balance = await this.balanceSats();
    if (balance < 100_000_000n) {
      await this.mine(MATURE_HEIGHT);
      balance = await this.balanceSats();
    }
    return { height: await this.height(), balanceSats: balance };
  }

  async balanceSats(): Promise<bigint> {
    const btcAmountNumber = await this.wallet.call<number>('getbalance');
    return BigInt(Math.round(btcAmountNumber * 1e8));
  }

  /**
   * Sets the node's clock to `minSec` or, if the chain is already past it, to the second after the tip's time.
   * Returns the time set (unix seconds).
   */
  async syncTime(minSec: number): Promise<number> {
    const info = await this.info();
    const t = Math.max(Math.floor(minSec), info.time + 1, info.mediantime + 1);
    await this.node.call('setmocktime', [t]);
    return t;
  }

  /** Pays `sats` to an address from the funding wallet (unconfirmed until a block is mined). */
  async sendToAddress(address: string, sats: bigint, feeRate = 10): Promise<string> {
    return this.wallet.call<string>('sendtoaddress', { address, amount: btcAmount(sats), fee_rate: feeRate });
  }

  /** Pays `sats` to `script` and says which output of the transaction it is. */
  async sendToScript(script: Uint8Array, sats: bigint, feeRate = 10): Promise<NodeFunding> {
    const txid = await this.sendToAddress(addressOfScript(script), sats, feeRate);
    const tx = await this.transaction(txid);
    if (!tx) throw new Error(`the node does not know the transaction ${txid} it just created`);
    const want = hex.encode(script);
    const out = tx.vout.find((o) => o.scriptPubKey.hex === want);
    if (!out) throw new Error(`transaction ${txid} does not pay the requested script`);
    return { txid, vout: out.n, value: sats, rawTx: tx.hex };
  }

  /** The node's minimum relay feerate in sat/vB (Core reports BTC per kvB). */
  async minRelaySatPerVb(): Promise<number> {
    const { relayfee } = await this.node.call<{ relayfee: number }>('getnetworkinfo');
    return Math.round(relayfee * 1e8) / 1000;
  }

  /** What the node's UTXO set (confirmed outputs only, not the mempool) holds for these addresses, in sats. */
  async utxoTotalSats(addresses: string[]): Promise<bigint> {
    const r = await this.node.call<{ success: boolean; total_amount: number }>('scantxoutset', ['start', addresses.map((a) => `addr(${a})`)]);
    if (!r.success) throw new Error('scantxoutset did not finish');
    return BigInt(Math.round(r.total_amount * 1e8));
  }

  /** The node's view of a transaction (mempool or chain); `undefined` if it does not know it. */
  async transaction(txid: string): Promise<NodeTx | undefined> {
    try {
      return await this.node.call<NodeTx>('getrawtransaction', [txid, true]);
    } catch (e) {
      if (e instanceof NodeRpcError && e.code === -5) return undefined;
      throw e;
    }
  }

  /** 0 in the mempool, n in a block n deep, `undefined` if the node does not know it. */
  async confirmations(txid: string): Promise<number | undefined> {
    const tx = await this.transaction(txid);
    return tx ? (tx.confirmations ?? 0) : undefined;
  }

  /** The mempool's entry for a transaction (`fees.base` in BTC), `undefined` if it is not in the mempool. */
  async mempoolEntry(txid: string): Promise<{ vsize: number; fees: { base: number } } | undefined> {
    try {
      return await this.node.call<{ vsize: number; fees: { base: number } }>('getmempoolentry', [txid]);
    } catch (e) {
      if (e instanceof NodeRpcError && e.code === -5) return undefined;
      throw e;
    }
  }

  async testMempoolAccept(txHex: string): Promise<TestMempoolAccept> {
    const [r] = await this.node.call<TestMempoolAccept[]>('testmempoolaccept', [[txHex]]);
    return r!;
  }

  sendRawTransaction(txHex: string): Promise<string> {
    return this.node.call<string>('sendrawtransaction', [txHex]);
  }

  /** Waits until Electrs reports a tip of at least `minHeight` (its index lags the node by a moment). */
  async waitForElectrs(minHeight?: number, timeoutMs = 120_000): Promise<{ height: number; server: [string, string] }> {
    const want = minHeight ?? (await this.height());
    return waitFor(
      async () => {
        const p = await probeElectrum(this.cfg.electrs.host, this.cfg.electrs.port);
        return p.height >= want ? p : undefined;
      },
      `Electrs at ${this.cfg.electrs.host}:${this.cfg.electrs.port} to reach height ${want}`,
      { timeoutMs, intervalMs: 500 },
    );
  }
}
