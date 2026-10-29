/**
 * The simulated chain for the app's Regtest simulator in Recovery Key mode, on localhost:
 * `@trikey/recovery-key`'s simulated Esplora (BIP 68, signatures, replacement rules, a fee market you can move) behind a
 * plain HTTP server. No bitcoind, no home server, throwaway regtest keys, everything forgotten when it stops.
 *
 *   npm run rk-sim -w @trikey/mobile                       listens on http://127.0.0.1:3002
 *   PORT=3002 HOST=0.0.0.0 npm run rk-sim -w @trikey/mobile   reachable from a phone on your Wi-Fi
 *
 * The app reads the chain from it like from any Esplora server (Settings > Chain server shows the address), and its
 * Settings > Developer > "Simulated chain" buttons call the same server to mine blocks and fund addresses:
 *
 *   POST /dev/mine?n=<blocks>              mine blocks (1,008 unlocks the next refill)
 *   POST /dev/fund?address=&sats=          pay an address from a faucet (in the mempool until mined)
 *   POST /dev/fees?rate=<sat/vB>&stall=1   move the fee market; with stall, blocks only take packages paying that much
 *   GET  /dev/status                       height and mempool
 *
 * It also reads commands from the terminal (or a pipe: each answer is one line starting with `ok` or `error`):
 *
 *   mine [n]                 mine n blocks (default 1)
 *   fund <address> <sats>    pay the address and mine a block
 *   fee <sat/vB> [stall]     set the fee estimates; `stall` also makes blocks refuse transactions that pay less
 *   status                   height, mempool, the server's address
 *   quit
 *
 * Options: `--height <n>` (the chain's starting height, default 200), `--auto <seconds>` (mine a block that often),
 * `--json` (print the start line as JSON, for scripts). Regtest only: the simulated chain refuses mainnet.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import * as btc from '@scure/btc-signer';
import { NETWORKS, getNetwork } from '@trikey/core';
import { SimChain, routeEsplora } from '@trikey/recovery-key/testing';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const chain = new SimChain({ network: NETWORKS.regtest, height: Number(arg('height') ?? 200) });
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3002);

function mine(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error('mine between 1 and 10000 blocks');
  return chain.mine(n);
}

function fund(address: string, sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 546) throw new Error('the amount is at least 546 sats');
  try {
    btc.OutScript.encode(btc.Address(getNetwork('regtest').btc).decode(address));
  } catch {
    throw new Error('not a regtest address');
  }
  return chain.fund(address, BigInt(sats)).txid;
}

function setFees(rate: number, stall: boolean): void {
  if (!(rate > 0 && rate <= 2000)) throw new Error('the fee rate is between 0 and 2000 sat/vB');
  chain.feeEstimates = { '1': rate, '2': rate, '3': rate, '6': rate, '144': Math.max(1, rate / 4), '1008': 1 };
  chain.minMiningFeeRate = stall ? rate : 0;
}

const status = () => ({ height: chain.height, mempool: chain.mempool().length, feeEstimates: chain.feeEstimates, minMiningFeeRate: chain.minMiningFeeRate });

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    // The browser preview is another origin: every answer says it may read it.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    const send = (status: number, body: string, type = 'text/plain') => {
      res.writeHead(status, { ...cors, 'content-type': type });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    try {
      const url = new URL(req.url ?? '/', 'http://sim');
      const path = url.pathname.replace(/^\/api(?=\/)/, '');
      if (path.startsWith('/dev/')) {
        const q = url.searchParams;
        if (path === '/dev/status' && req.method === 'GET') return send(200, JSON.stringify(status()), 'application/json');
        if (req.method !== 'POST') return send(405, 'POST only');
        if (path === '/dev/mine') return send(200, JSON.stringify({ height: mine(Number(q.get('n') ?? 1)) }), 'application/json');
        if (path === '/dev/fund') return send(200, JSON.stringify({ txid: fund(q.get('address') ?? '', Number(q.get('sats'))) }), 'application/json');
        if (path === '/dev/fees') {
          setFees(Number(q.get('rate')), q.get('stall') === '1');
          return send(200, JSON.stringify(status()), 'application/json');
        }
        return send(404, 'Not found');
      }
      const r = routeEsplora(chain, req.method ?? 'GET', path + url.search, Buffer.concat(chunks).toString('utf8'));
      send(r.status, r.body, r.type === 'json' ? 'application/json' : 'text/plain');
    } catch (e) {
      send(400, e instanceof Error ? e.message : String(e));
    }
  });
});
server.keepAliveTimeout = 1000;
await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
const { port } = server.address() as AddressInfo;
const url = `http://${HOST === '0.0.0.0' ? '<your computer>' : HOST}:${port}`;

const autoSeconds = Number(arg('auto') ?? 0);
if (autoSeconds > 0) setInterval(() => chain.mine(1), autoSeconds * 1000).unref();

const say = (line: string) => console.log(line);
say(
  flag('json')
    ? JSON.stringify({ ready: true, url, ...status() })
    : [
        'Trikey Recovery Key simulator is running (regtest, throwaway keys).',
        `  chain server   ${url}   (Settings > Chain server in the app, if it is not the default)`,
        `  height         ${chain.height}`,
        autoSeconds > 0 ? `  auto-mining    a block every ${autoSeconds} s` : '',
        '',
        'Commands: mine [n] | fund <address> <sats> | fee <sat/vB> [stall] | status | quit',
        'An Android emulator reaches this computer at http://10.0.2.2:' + port + ' ; a phone needs HOST=0.0.0.0 and your LAN address.',
      ]
        .filter((l, i, all) => l !== '' || all[i - 1] !== '')
        .join('\n'),
);

const stop = () => {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case 'mine':
        say(`ok height ${mine(Number(args[0] ?? 1))}`);
        break;
      case 'fund': {
        const [address, sats] = args;
        if (!address || !sats) throw new Error('usage: fund <address> <sats>');
        const txid = fund(address, Number(sats));
        say(`ok funded ${address} with ${sats} sats (${txid}), height ${mine(1)}`);
        break;
      }
      case 'fee':
        if (!args[0]) throw new Error('usage: fee <sat/vB> [stall]');
        setFees(Number(args[0]), args[1] === 'stall');
        say(`ok ${JSON.stringify(status())}`);
        break;
      case 'status':
        say(`ok ${JSON.stringify({ url, ...status() })}`);
        break;
      case 'quit':
      case 'exit':
        say('ok');
        stop();
        break;
      case '':
      case undefined:
        break;
      default:
        say(`error unknown command: ${cmd}`);
    }
  } catch (e) {
    say(`error ${e instanceof Error ? e.message : String(e)}`);
  }
}
// Input closed: at a terminal that means "leave"; started without one (a script, a CI job) the server keeps serving.
if (process.stdin.isTTY) stop();
else await new Promise<never>(() => undefined);
