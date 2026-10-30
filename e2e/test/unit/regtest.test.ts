/**
 * RegtestChain and the Electrum probe against scripted stand-ins (a JSON-RPC server that behaves like the parts of
 * bitcoind the stack scripts use, and the guardian's fake Electrs), so the stack scripts' logic is exercised without Docker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { FakeElectrum } from '@trikey/guardian/testing';
import { loadE2eConfig } from '../../src/config.js';
import { probeElectrum } from '../../src/electrum-probe.js';
import { MATURE_HEIGHT, RegtestChain, addressOfScript } from '../../src/regtest.js';
import { startRpcServer, type RpcAnswer, type RpcCall, type TestRpcServer } from './support/json-rpc-server.js';

/** The part of bitcoind that matters here: wallets, blocks, a mock clock, and transactions with their outputs. */
class ScriptedNode {
  height = 0;
  tipTime = 1_700_000_000;
  mockTime = 0;
  wallets = new Set<string>();
  existingWalletFiles = new Set<string>();
  txs = new Map<string, { hex: string; vout: { n: number; value: number; scriptPubKey: { hex: string } }[]; confirmations: number }>();
  private nextTx = 1;

  handle = (call: RpcCall): RpcAnswer => {
    const p = call.params as unknown[] & Record<string, unknown>;
    switch (call.method) {
      case 'getblockchaininfo':
        return { result: { chain: 'regtest', blocks: this.height, headers: this.height, bestblockhash: '00', time: this.tipTime, mediantime: this.tipTime - 60, initialblockdownload: this.height < 1 } };
      case 'getblockcount':
        return { result: this.height };
      case 'listwallets':
        return { result: [...this.wallets] };
      case 'loadwallet': {
        const name = p[0] as string;
        if (!this.existingWalletFiles.has(name)) return { error: { code: -18, message: 'Wallet file verification failed. Path does not exist.' } };
        this.wallets.add(name);
        return { result: { name } };
      }
      case 'createwallet': {
        const name = p['wallet_name'] as string;
        this.wallets.add(name);
        this.existingWalletFiles.add(name);
        return { result: { name } };
      }
      case 'getnewaddress':
        return { result: 'bcrt1qmining' };
      case 'generatetoaddress': {
        const n = p[0] as number;
        this.height += n;
        this.tipTime = Math.max(this.mockTime, this.tipTime + 1);
        for (const t of this.txs.values()) if (t.confirmations === 0) t.confirmations = 1;
        return { result: Array.from({ length: n }, (_, i) => `hash${this.height - n + i + 1}`) };
      }
      case 'getnetworkinfo':
        return { result: { relayfee: 0.00001 } };
      case 'getbalance':
        return { result: this.height >= MATURE_HEIGHT ? 50 : 0 };
      case 'setmocktime':
        this.mockTime = p[0] as number;
        return { result: null };
      case 'sendtoaddress': {
        const id = `tx${this.nextTx++}`.padEnd(64, '0');
        // The payment is the second output, the change the first: the client must find the output by script.
        this.txs.set(id, {
          hex: `raw-${id}`,
          confirmations: 0,
          vout: [
            { n: 0, value: 49.9, scriptPubKey: { hex: '0014' + '11'.repeat(20) } },
            { n: 1, value: Number(p['amount']), scriptPubKey: { hex: this.lastPaymentScript } },
          ],
        });
        return { result: id };
      }
      case 'getrawtransaction': {
        const tx = this.txs.get(p[0] as string);
        if (!tx) return { error: { code: -5, message: 'No such mempool or blockchain transaction.' } };
        return { result: { txid: p[0], hex: tx.hex, vout: tx.vout, ...(tx.confirmations ? { confirmations: tx.confirmations } : {}) } };
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${call.method}` } };
    }
  };

  /** The script the next `sendtoaddress` pays (the node would derive it from the address). */
  lastPaymentScript = '';
}

let server: TestRpcServer | undefined;
let electrs: FakeElectrum | undefined;
afterEach(async () => {
  await server?.close();
  await electrs?.stop();
  server = undefined;
  electrs = undefined;
});

async function chainOn(node: ScriptedNode, electrsPort = 1): Promise<RegtestChain> {
  server = await startRpcServer(node.handle);
  return new RegtestChain({ ...loadE2eConfig({ E2E_RPC_PORT: String(server.port), E2E_ELECTRS_PORT: String(electrsPort) }) });
}

describe('RegtestChain.prepare', () => {
  it('creates the funding wallet when it does not exist and mines until the first reward is spendable', async () => {
    const node = new ScriptedNode();
    const chain = await chainOn(node);
    expect(await chain.prepare()).toMatchObject({ height: MATURE_HEIGHT, balanceSats: 5_000_000_000n });
    expect(node.wallets.has('funding')).toBe(true);
    const methods = server!.calls.map((c) => c.method);
    expect(methods.indexOf('loadwallet')).toBeLessThan(methods.indexOf('createwallet'));
    expect(server!.calls.filter((c) => c.method === 'generatetoaddress').map((c) => c.params)).toEqual([[MATURE_HEIGHT, 'bcrt1qmining']]);
    // The funding wallet's calls go to its own endpoint.
    expect(server!.calls.find((c) => c.method === 'getnewaddress')!.path).toBe('/wallet/funding');
  });

  it('loads an existing wallet, and does not mine again on a chain that is already mature', async () => {
    const node = new ScriptedNode();
    node.existingWalletFiles.add('funding');
    node.height = 250;
    const chain = await chainOn(node);
    expect(await chain.prepare()).toMatchObject({ height: 250 });
    expect(server!.calls.some((c) => c.method === 'createwallet')).toBe(false);
    expect(server!.calls.some((c) => c.method === 'generatetoaddress')).toBe(false);
    // A second call finds the wallet loaded.
    server!.calls.length = 0;
    await chain.prepare();
    expect(server!.calls.some((c) => c.method === 'loadwallet')).toBe(false);
  });
});

describe('RegtestChain time', () => {
  it('moves the node\'s clock forward, and never to before the tip', async () => {
    const node = new ScriptedNode();
    node.tipTime = 2_000_000_000;
    const chain = await chainOn(node);
    // A request in the past of the tip (a chain left behind by an earlier run) lands just after the tip.
    expect(await chain.syncTime(1_700_000_000)).toBe(2_000_000_001);
    expect(node.mockTime).toBe(2_000_000_001);
    // A request in the future is honored as asked.
    expect(await chain.syncTime(2_000_900_000.7)).toBe(2_000_900_000);
    expect(node.mockTime).toBe(2_000_900_000);
  });
});

describe('RegtestChain policy', () => {
  it('reads the minimum relay feerate in sat/vB', async () => {
    const chain = await chainOn(new ScriptedNode());
    expect(await chain.minRelaySatPerVb()).toBe(1);
  });
});

describe('RegtestChain payments', () => {
  const script = hex.decode('0014' + 'ab'.repeat(20));

  it('pays a script and says which output of the transaction is the payment', async () => {
    const node = new ScriptedNode();
    node.lastPaymentScript = hex.encode(script);
    const chain = await chainOn(node);
    const coin = await chain.sendToScript(script, 300_000n);
    expect(coin).toMatchObject({ vout: 1, value: 300_000n });
    expect(coin.rawTx).toBe(`raw-${coin.txid}`);
    const call = server!.calls.find((c) => c.method === 'sendtoaddress')!;
    expect(call.params).toMatchObject({ address: addressOfScript(script), amount: '0.00300000', fee_rate: 10 });
    expect(addressOfScript(script)).toMatch(/^bcrt1q/);
  });

  it('refuses a transaction that does not pay the script it was asked to', async () => {
    const node = new ScriptedNode();
    node.lastPaymentScript = '0014' + 'cd'.repeat(20);
    const chain = await chainOn(node);
    await expect(chain.sendToScript(script, 1_000n)).rejects.toThrow(/does not pay the requested script/);
  });

  it('knows a transaction\'s depth: undefined, 0 in the mempool, 1 once mined', async () => {
    const node = new ScriptedNode();
    node.lastPaymentScript = hex.encode(script);
    const chain = await chainOn(node);
    expect(await chain.confirmations('ff'.repeat(32))).toBeUndefined();
    const { txid } = await chain.sendToScript(script, 1_000n);
    expect(await chain.confirmations(txid)).toBe(0);
    await chain.mine(1);
    expect(await chain.confirmations(txid)).toBe(1);
    await expect(chain.mine(0)).rejects.toThrow(RangeError);
  });
});

describe('waiting for Electrs', () => {
  it('reads the server and tip a fake Electrs announces', async () => {
    electrs = new FakeElectrum({ blocks: 12, startTime: 1_700_000_000, spacing: 600 });
    const port = await electrs.start();
    const p = await probeElectrum('127.0.0.1', port);
    expect(p.height).toBe(11);
    expect(Array.isArray(p.server)).toBe(true);
  });

  it('returns once the index has caught up, and times out with a clear message when it has not', async () => {
    electrs = new FakeElectrum({ blocks: 12, startTime: 1_700_000_000, spacing: 600 });
    const port = await electrs.start();
    const chain = await chainOn(new ScriptedNode(), port);
    expect((await chain.waitForElectrs(11, 3000)).height).toBe(11);
    await expect(chain.waitForElectrs(500, 600)).rejects.toThrow(/timed out after 600 ms waiting for Electrs .* to reach height 500/);
  });

  it('fails clearly when nothing listens', async () => {
    electrs = new FakeElectrum({ blocks: 3 });
    const port = await electrs.start();
    await electrs.stop();
    await expect(probeElectrum('127.0.0.1', port, 1000)).rejects.toThrow(/unreachable|closed/);
  });
});
