/**
 * The back end for the app's UI tests (apps/mobile/.maestro/regtest, e2e/README.md "UI flows"): the regtest stack's
 * bitcoind and Electrs (`npm run stack:up` first), a nostr relay, and the real Trikey Guardian as people run it
 * (`apps/guardian/src/main.ts` in a process of its own, set up through its own web API), with a small HTTP control API
 * on 127.0.0.1 that the Maestro flows call (`runScript` with `http`) for what a person would do outside the phone:
 * make a pairing code on the guardian's page, pay the phone from another wallet, wait for a block.
 *
 *   npm run ui-rig -w @trikey/e2e
 *
 * REGTEST ONLY. The guardian's passphrase, the setup code and the RPC credentials are throwaway values for a chain with
 * no value. Everything listens on 127.0.0.1. The relay URL that goes into the pairing code is `ws://127.0.0.1:7777`:
 * an Android emulator reaches it after `adb reverse tcp:7777 tcp:7777` (the test build allows plain ws:// to
 * 127.0.0.1, localhost and 10.0.2.2 only: apps/mobile/plugins/with-test-cleartext.js).
 *
 * Control API (http://127.0.0.1:8790; GET or POST, query parameters, JSON answers, `{ "error": ... }` with status 4xx/5xx):
 *
 *   /health                         the chain's height; the guardians running
 *   /pairing?guardian=1             a fresh pairing code from guardian 1 or 2 (2 is started on first use: Replace guardian)
 *   /recovery-code?guardian=1       the guardian's "Recover on a new phone" code (once a wallet is paired)
 *   /guardian?guardian=1            the guardian's own status (GET /api/status, signed in)
 *   /address                        a new address of the funding wallet, to pay to
 *   /fund?address=&sats=            pay an address from the funding wallet (spaces in the address are ignored)
 *   /mine?blocks=1                  mine blocks; answers once Electrs has them
 *   /received?address=              what the funding wallet received at one of its addresses: in the mempool and confirmed
 *   /kv?key=&value=                 keep a value between flows (the recovery code, a balance); without value: read it
 *   /log?guardian=1&lines=40        the end of the guardian's log
 *
 * Environment: UI_RIG_PORT (8790), UI_RELAY_PORT (7777), UI_GUARDIAN_PORT (8787; guardian 2 on the next port),
 * UI_RIG_DIR (the guardians' data and logs; default a new temp directory), and the stack's E2E_* variables.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevRelay } from '@trikey/protocol/dev/relay';
import { loadE2eConfig } from '../src/config.js';
import { RegtestChain } from '../src/regtest.js';
import { sleep, waitFor } from '../src/wait.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = (k: string, fallback: string) => (process.env[k]?.trim() ? process.env[k]!.trim() : fallback);
const RIG_PORT = Number(env('UI_RIG_PORT', '8790'));
const RELAY_PORT = Number(env('UI_RELAY_PORT', '7777'));
const GUARDIAN_PORT = Number(env('UI_GUARDIAN_PORT', '8787'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
/** Regtest only: what the owner would type on the guardian's first-run page. */
const PASSPHRASE = 'regtest ui flows only';
/** Regtest only: 16 characters of Crockford base32, as TRIKEY_SETUP_CODE takes it. */
const SETUP_CODE = 'REGTESTF10WS0000';

const cfg = loadE2eConfig();
const chain = new RegtestChain(cfg);

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One Trikey Guardian process (apps/guardian/src/main.ts), set up and signed in through its web API. */
class GuardianProcess {
  private child?: ChildProcess;
  private cookie = '';
  private secret = '';
  readonly logFile: string;

  constructor(
    readonly n: number,
    readonly port: number,
    readonly dir: string,
  ) {
    this.logFile = join(dirname(dir), `guardian-${n}.log`);
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const log = createWriteStream(this.logFile, { flags: 'a' });
    const { bitcoind, electrs } = cfg;
    this.child = spawn(process.execPath, ['--import', 'tsx', 'apps/guardian/src/main.ts'], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(this.port),
        TRIKEY_DATA_DIR: this.dir,
        BITCOIN_NETWORK: 'regtest',
        ELECTRUM_HOST: electrs.host,
        ELECTRUM_PORT: String(electrs.port),
        BITCOIN_RPC_HOST: bitcoind.host,
        BITCOIN_RPC_PORT: String(bitcoind.port),
        BITCOIN_RPC_USER: bitcoind.user,
        BITCOIN_RPC_PASS: bitcoind.pass,
        TRIKEY_PLATFORM: 'docker',
        TRIKEY_SETUP_CODE: SETUP_CODE,
        TRIKEY_LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout!.pipe(log);
    this.child.stderr!.pipe(log);
    this.child.on('exit', (code, signal) => log.write(`--- guardian ${this.n} exited (${code ?? signal})\n`));
    await waitFor(
      () => {
        if (this.child?.exitCode !== null) throw new Error(`guardian ${this.n} exited with ${this.child?.exitCode}; see ${this.logFile}`);
        return this.call('GET', '/status').then(() => true);
      },
      `guardian ${this.n} on port ${this.port}`,
      { timeoutMs: 60_000, intervalMs: 250 },
    ).catch(async (e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n${(await this.logTail(15)).join('\n')}`);
    });
    const res = await fetch(`${this.base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE, relays: [RELAY_URL], setupCode: SETUP_CODE }),
    });
    const body = (await res.json()) as { sessionSecret?: string; message?: string };
    if (!res.ok || !body.sessionSecret) throw new Error(`guardian ${this.n} setup failed: ${res.status} ${body.message ?? ''}`);
    const cookie = /trikey_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
    if (!cookie) throw new Error(`guardian ${this.n} setup set no session cookie`);
    this.cookie = `trikey_session=${cookie[1]}`;
    this.secret = body.sessionSecret;
  }

  /** A call to the guardian's web API, signed in (once set up). */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie, 'x-trikey-session': this.secret } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpProblem(502, `guardian ${this.n} ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async logTail(lines: number): Promise<string[]> {
    const text = await readFile(this.logFile, 'utf8').catch(() => '');
    return text.trimEnd().split('\n').slice(-lines);
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    c.kill('SIGTERM');
    for (let i = 0; i < 100 && c.exitCode === null; i++) await sleep(100);
    if (c.exitCode === null) c.kill('SIGKILL');
  }
}

const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const dir = process.env['UI_RIG_DIR']?.trim() || (await mkdtemp(join(tmpdir(), 'trikey-ui-rig-')));
  await mkdir(dir, { recursive: true });
  say(`ui-rig: waiting for bitcoind and Electrs (${cfg.bitcoind.host}:${cfg.bitcoind.port}, ${cfg.electrs.host}:${cfg.electrs.port})`);
  const { height } = await chain.prepare();
  await chain.waitForElectrs(height);

  const relay = new DevRelay({ port: RELAY_PORT, host: '127.0.0.1' });
  await relay.start();
  say(`ui-rig: relay ${RELAY_URL}`);

  const guardians = new Map<number, GuardianProcess>();
  const guardian = async (n: number): Promise<GuardianProcess> => {
    const have = guardians.get(n);
    if (have) return have;
    const g = new GuardianProcess(n, GUARDIAN_PORT + n - 1, join(dir, `guardian-${n}`));
    guardians.set(n, g);
    try {
      await g.start();
    } catch (e) {
      guardians.delete(n);
      await g.stop();
      throw e;
    }
    say(`ui-rig: guardian ${n} set up on port ${g.port} (log ${g.logFile})`);
    return g;
  };
  await guardian(1);

  const kv = new Map<string, string>();
  const which = (q: URLSearchParams) => {
    const n = Number(q.get('guardian') ?? '1');
    if (n !== 1 && n !== 2) throw new HttpProblem(400, 'guardian must be 1 or 2');
    return n;
  };
  const address = (q: URLSearchParams) => {
    const a = (q.get('address') ?? '').replace(/\s+/g, '');
    if (!/^bcrt1[02-9ac-hj-np-z]{8,90}$/.test(a)) throw new HttpProblem(400, `not a regtest address: ${q.get('address')}`);
    return a;
  };
  const routes: Record<string, (q: URLSearchParams) => Promise<unknown>> = {
    '/health': async () => ({ ok: true, height: await chain.height(), guardians: [...guardians.keys()] }),
    '/pairing': async (q) => {
      const g = await guardian(which(q));
      const s = await g.call<{ uri: string; expiresAt: string }>('POST', '/pairing');
      return { uri: s.uri, expiresAt: s.expiresAt };
    },
    '/recovery-code': async (q) => {
      const r = await (await guardian(which(q))).call<{ uri: string }>('GET', '/recovery-code');
      return { uri: r.uri };
    },
    '/guardian': async (q) => (await guardian(which(q))).call('GET', '/status'),
    '/address': async () => ({ address: await chain.wallet.call<string>('getnewaddress', { label: 'ui-flows', address_type: 'bech32' }) }),
    '/fund': async (q) => {
      const sats = q.get('sats') ?? '';
      if (!/^\d+$/.test(sats) || BigInt(sats) <= 0n) throw new HttpProblem(400, 'sats must be a positive whole number');
      return { txid: await chain.sendToAddress(address(q), BigInt(sats)) };
    },
    '/mine': async (q) => {
      const n = Number(q.get('blocks') ?? '1');
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpProblem(400, 'blocks must be 1 to 1000');
      await chain.mine(n);
      const h = await chain.height();
      await chain.waitForElectrs(h);
      return { height: h };
    },
    '/received': async (q) => {
      const a = address(q);
      const sats = async (minconf: number) => Math.round((await chain.wallet.call<number>('getreceivedbyaddress', [a, minconf])) * 1e8);
      return { address: a, sats: await sats(0), confirmedSats: await sats(1) };
    },
    '/kv': async (q) => {
      const key = q.get('key') ?? '';
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw new HttpProblem(400, 'key: 1 to 64 letters, digits, _ . -');
      const value = q.get('value');
      if (value !== null) kv.set(key, value);
      if (!kv.has(key)) throw new HttpProblem(404, `nothing kept under ${key}`);
      return { key, value: kv.get(key) };
    },
    '/log': async (q) => {
      const g = guardians.get(which(q));
      return { lines: g ? await g.logTail(Math.min(500, Number(q.get('lines') ?? '40'))) : [] };
    },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routes[url.pathname];
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!route) return send(404, { error: `no such endpoint: ${url.pathname}` });
    // A short line per call, for the job's log (a kept recovery code is not printed, though it is a throwaway one).
    const kvKey = url.searchParams.get('key') ?? '';
    const shown =
      url.pathname === '/kv' && /recovery/i.test(kvKey) ? `/kv?key=${kvKey}${url.searchParams.has('value') ? ' (set)' : ''}` : `${url.pathname}${decodeURIComponent(url.search)}`;
    route(url.searchParams).then(
      (body) => {
        say(`ui-rig: ${req.method} ${shown} -> 200`);
        send(200, body);
      },
      (e: unknown) => {
        const status = e instanceof HttpProblem ? e.status : 500;
        const message = e instanceof Error ? e.message : String(e);
        say(`ui-rig: ${req.method} ${shown} -> ${status} ${message}`);
        send(status, { error: message });
      },
    );
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(RIG_PORT, '127.0.0.1', () => ok());
  });
  say(`ui-rig: ready on http://127.0.0.1:${RIG_PORT} (data and logs in ${dir})`);

  const stop = async () => {
    server.close();
    for (const g of guardians.values()) await g.stop();
    await relay.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e: unknown) => {
  process.stderr.write(`ui-rig: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
