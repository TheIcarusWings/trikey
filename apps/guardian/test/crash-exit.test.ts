/**
 * After an uncaught exception the guardian stops cleanly and exits with 1, not 0: Umbrel runs it with
 * `restart: on-failure`, so a 0 there left a crashed guardian down for good (a 502 until someone
 * restarted the app by hand). SIGTERM, a stop the supervisor asked for, still exits 0.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const GUARDIAN_DIR = fileURLToPath(new URL('..', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Runs `main.ts`, optionally with a preload, and resolves with its exit code and output. */
async function runMain(dir: string, opts: { preload?: string; sigtermAfterStart?: boolean }) {
  const args = [...(opts.preload ? ['--import', join(GUARDIAN_DIR, opts.preload)] : []), '--import', 'tsx', 'src/main.ts'];
  const child = spawn(process.execPath, args, {
    cwd: GUARDIAN_DIR,
    env: { PATH: process.env.PATH ?? '', TRIKEY_DATA_DIR: join(dir, 'data'), BITCOIN_NETWORK: 'regtest', PORT: String(await freePort()) },
  });
  let out = '';
  let sent = false;
  child.stdout.on('data', (d) => {
    out += String(d);
    // main.ts installs its signal handlers right after `guardian.started` is logged: give it a moment.
    if (opts.sigtermAfterStart && !sent && out.includes('guardian.started')) {
      sent = true;
      setTimeout(() => child.kill('SIGTERM'), 500);
    }
  });
  child.stderr.on('data', (d) => (out += String(d)));
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { code, out };
}

describe('the guardian process', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('exits with 1 after an uncaught exception, so a supervisor restarts it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'trikey-crash-'));
    const { code, out } = await runMain(dir, { preload: 'test/support/crash-preload.mjs' });
    expect(out).toMatch(/guardian\.started/);
    expect(out).toMatch(/ERROR uncaught_exception error="test crash after start"/);
    expect(out).toMatch(/guardian\.shutdown signal=uncaughtException exitCode=1/);
    expect(code).toBe(1);
  }, 90_000);

  it('exits with 0 on SIGTERM', async () => {
    dir = await mkdtemp(join(tmpdir(), 'trikey-sigterm-'));
    const { code, out } = await runMain(dir, { sigtermAfterStart: true });
    expect(out).toMatch(/guardian\.shutdown signal=SIGTERM exitCode=0/);
    expect(code).toBe(0);
  }, 90_000);
});
