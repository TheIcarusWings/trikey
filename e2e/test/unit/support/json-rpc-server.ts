/** A tiny JSON-RPC-over-HTTP server for testing the node client without a node. */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RpcCall {
  method: string;
  params: unknown;
  /** The URL path, e.g. `/` or `/wallet/funding`. */
  path: string;
  authorization: string | undefined;
}

export type RpcAnswer = { result: unknown } | { error: { code: number; message: string } } | { status: number };

export interface TestRpcServer {
  port: number;
  calls: RpcCall[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (s += c));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

export async function startRpcServer(handler: (call: RpcCall) => RpcAnswer): Promise<TestRpcServer> {
  const calls: RpcCall[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const msg = JSON.parse(body) as { id: number; method: string; params: unknown };
      const call: RpcCall = { method: msg.method, params: msg.params, path: req.url ?? '/', authorization: req.headers['authorization'] };
      calls.push(call);
      const a = handler(call);
      if ('status' in a) {
        res.writeHead(a.status).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'result' in a ? a.result : null, error: 'error' in a ? a.error : null, id: msg.id }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
