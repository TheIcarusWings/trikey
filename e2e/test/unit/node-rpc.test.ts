import { afterEach, describe, expect, it } from 'vitest';
import { NodeRpc, NodeRpcError, btcAmount } from '../../src/node-rpc.js';
import { startRpcServer, type TestRpcServer } from './support/json-rpc-server.js';

let server: TestRpcServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const cfg = (port: number) => ({ host: '127.0.0.1', port, user: 'trikey', pass: 'regtest only' });

describe('NodeRpc', () => {
  it('sends basic auth, the method and the parameters, and returns the result', async () => {
    server = await startRpcServer(() => ({ result: 101 }));
    const rpc = new NodeRpc(cfg(server.port));
    expect(await rpc.call('getblockcount')).toBe(101);
    expect(await rpc.call('generatetoaddress', [2, 'bcrt1qexample'])).toBe(101);
    expect(await rpc.call('sendtoaddress', { address: 'a', amount: '0.001' })).toBe(101);
    expect(server.calls.map((c) => c.method)).toEqual(['getblockcount', 'generatetoaddress', 'sendtoaddress']);
    expect(server.calls[1]!.params).toEqual([2, 'bcrt1qexample']);
    expect(server.calls[2]!.params).toEqual({ address: 'a', amount: '0.001' });
    expect(server.calls[0]!.authorization).toBe(`Basic ${Buffer.from('trikey:regtest only').toString('base64')}`);
    expect(server.calls[0]!.path).toBe('/');
  });

  it('goes to /wallet/<name> through a wallet client', async () => {
    server = await startRpcServer(() => ({ result: 0.5 }));
    const rpc = new NodeRpc(cfg(server.port)).wallet('funding');
    expect(rpc.walletName).toBe('funding');
    await rpc.call('getbalance');
    expect(server.calls[0]!.path).toBe('/wallet/funding');
  });

  it('reports the node\'s error with its code and method', async () => {
    server = await startRpcServer(() => ({ error: { code: -26, message: 'dust' } }));
    const e = await new NodeRpc(cfg(server.port)).call('sendrawtransaction', ['00']).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NodeRpcError);
    expect(e).toMatchObject({ method: 'sendrawtransaction', code: -26, message: 'sendrawtransaction: dust' });
  });

  it('says so when the credentials are refused, or the node does not answer', async () => {
    server = await startRpcServer(() => ({ status: 401 }));
    await expect(new NodeRpc(cfg(server.port)).call('getblockcount')).rejects.toThrow(/rejected the RPC credentials/);
    const port = server.port;
    await server.close();
    server = undefined;
    await expect(new NodeRpc(cfg(port)).call('getblockcount')).rejects.toThrow(/unreachable/);
  });
});

describe('btcAmount', () => {
  it('formats satoshis exactly, with no float in between', () => {
    expect(btcAmount(0n)).toBe('0.00000000');
    expect(btcAmount(1)).toBe('0.00000001');
    expect(btcAmount(30_000n)).toBe('0.00030000');
    expect(btcAmount(100_000_000n)).toBe('1.00000000');
    expect(btcAmount(2_100_000_000_000_000n)).toBe('21000000.00000000');
    expect(() => btcAmount(-1)).toThrow(RangeError);
  });
});
