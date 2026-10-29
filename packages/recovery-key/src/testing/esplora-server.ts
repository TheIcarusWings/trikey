/**
 * A fake Esplora server over HTTP for tests (Node only: it uses node:http).
 * Listens on 127.0.0.1 on a free port.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SimChain } from './sim-chain.js';
import { routeEsplora, type FakeEsploraHooks } from './esplora-routes.js';

export interface FakeEsplora {
  url: string;
  chain: SimChain;
  hooks: FakeEsploraHooks;
  close(): Promise<void>;
}

export async function startFakeEsplora(chain: SimChain, hooks: FakeEsploraHooks = {}): Promise<FakeEsplora> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let r;
      try {
        r = routeEsplora(chain, req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks).toString('utf8'), hooks);
      } catch (e) {
        r = { status: 500, body: String((e as Error).message), type: 'text' as const };
      }
      res.writeHead(r.status, { 'content-type': r.type === 'json' ? 'application/json' : 'text/plain' });
      res.end(r.body);
    });
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chain,
    hooks,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
