/**
 * Security review 2026-11, finding 4: Bitcoin Core's RPC carries the node's credentials in clear (HTTP basic auth).
 * The client used to check a host name's addresses once and trust the answer for five minutes, while `fetch` resolved
 * the name again on its own and followed redirects: a DNS answer that changed in between (a rebinding), or a redirect
 * from the node's address, sent the credentials elsewhere. Now the name is resolved at every call, every address must
 * pass, the request goes to the checked address, redirects are refused, and a name that points to a link-local address
 * is refused.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BitcoinRpc, isLinkLocal } from '../../src/chain/bitcoind.js';

interface Seen {
  host?: string;
  authorization?: string;
  body: string;
}

async function node(answer: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body: string }): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ host: req.headers.host, authorization: req.headers.authorization, body });
      const a = answer(req, body);
      res.writeHead(a.status, { 'Content-Type': 'application/json', ...a.headers });
      res.end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const ok = (_req: IncomingMessage, body: string) => ({ status: 200, body: JSON.stringify({ result: 812_000, error: null, id: JSON.parse(body).id }) });

let real: Awaited<ReturnType<typeof node>>;
let elsewhere: Awaited<ReturnType<typeof node>>;
beforeAll(async () => {
  real = await node(ok);
  elsewhere = await node(ok);
});
afterAll(async () => {
  for (const n of [real, elsewhere]) await new Promise<void>((r) => n.server.close(() => r()));
});
beforeEach(() => {
  real.seen.length = 0;
  elsewhere.seen.length = 0;
});

const cfg = (host: string, port = real.port) => ({ host, port, user: 'guardian', pass: 'rpc-password-for-tests' });

describe('Bitcoin Core RPC: the checked address is the connected address', () => {
  it('resolves the name at every call and connects to the address it checked (no second lookup)', async () => {
    const answers: string[][] = [['127.0.0.1'], ['127.0.0.1']];
    const lookups: string[] = [];
    const rpc = new BitcoinRpc(cfg('bitcoind.invalid'), {
      resolve: async (h) => {
        lookups.push(h);
        return answers.shift()!.map((address) => ({ address, family: 4 }));
      },
    });
    expect(await rpc.getBlockCount()).toBe(812_000);
    expect(await rpc.getBlockCount()).toBe(812_000);
    expect(lookups).toEqual(['bitcoind.invalid', 'bitcoind.invalid']);
    // `bitcoind.invalid` cannot resolve anywhere: the requests reached the node because they went to the checked address.
    expect(real.seen).toHaveLength(2);
    expect(real.seen[0]!.host).toBe(`bitcoind.invalid:${real.port}`);
  });

  it('PoC: a name that rebinds to an internet address after a good answer gets no credentials', async () => {
    const answers = [['127.0.0.1'], ['203.0.113.9']];
    const rpc = new BitcoinRpc(cfg('bitcoind.invalid'), { resolve: async () => answers.shift()!.map((address) => ({ address, family: 4 })) });
    expect(await rpc.getBlockCount()).toBe(812_000);
    // Before: the first check held for five minutes, and fetch resolved the name again by itself.
    await expect(rpc.getBlockCount()).rejects.toThrow(/203\.0\.113\.9\) is not on this box or your own network/);
    expect(real.seen).toHaveLength(1);
  });

  it('every address of the name must pass, not only one', async () => {
    const rpc = new BitcoinRpc(cfg('bitcoind.invalid'), {
      resolve: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '203.0.113.9', family: 4 },
      ],
    });
    await expect(rpc.getBlockCount()).rejects.toThrow(/not on this box/);
    expect(real.seen).toHaveLength(0);
  });

  it('a name that points to a link-local address (cloud metadata) is refused, even with BITCOIN_RPC_ALLOW_PUBLIC', async () => {
    for (const address of ['169.254.169.254', 'fe80::1']) {
      const rpc = new BitcoinRpc(cfg('bitcoind.invalid'), { allowPublic: true, resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await expect(rpc.getBlockCount(), address).rejects.toThrow(/link-local/);
    }
    expect(isLinkLocal('::ffff:169.254.1.1')).toBe(true);
    expect(isLinkLocal('10.21.21.8')).toBe(false);
  });

  it('PoC: a redirect is not followed, so the credentials never reach its target', async () => {
    const redirecting = await node(() => ({ status: 307, headers: { Location: `http://127.0.0.1:${elsewhere.port}/` }, body: '' }));
    try {
      const rpc = new BitcoinRpc(cfg('127.0.0.1', redirecting.port));
      await expect(rpc.getBlockCount()).rejects.toThrow(/HTTP 307: redirects are not followed/);
      await expect(rpc.batch('getblockhash', [[1], [2]])).rejects.toThrow(/redirects are not followed/);
      expect(redirecting.seen).toHaveLength(2);
      expect(elsewhere.seen).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => redirecting.server.close(() => r()));
    }
  });

  it('literal addresses work as before; errors carry no credentials', async () => {
    const rpc = new BitcoinRpc(cfg('127.0.0.1'));
    expect(await rpc.getBlockCount()).toBe(812_000);
    expect(real.seen[0]!.authorization).toBe(`Basic ${Buffer.from('guardian:rpc-password-for-tests').toString('base64')}`);
    const down = new BitcoinRpc(cfg('127.0.0.1', 1), { timeoutMs: 2000 });
    const e = await down.getBlockCount().catch((x: Error) => x);
    expect(String(e)).toMatch(/node unreachable \(ECONNREFUSED\)/);
    expect(String(e)).not.toContain('rpc-password-for-tests');
    // A literal internet address is still refused without BITCOIN_RPC_ALLOW_PUBLIC.
    await expect(new BitcoinRpc(cfg('203.0.113.9')).getBlockCount()).rejects.toThrow(/not on this box/);
  });
});
