/**
 * The guardian tests its random source and its crypto before it makes, opens or unlocks anything
 * (apps/guardian/src/rng-check.ts, packages/core/src/random-health.ts), and refuses to start if either
 * fails: a clear log line, no bytes in it, and a non-zero exit.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RandomSourceError, pinRandomSource, type GetRandomValues } from '@trikey/core/random';
import { installRandomSource } from '@trikey/core/testing/random';
import { loadConfig } from '../src/config.js';
import { Guardian } from '../src/guardian.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { generateSeed } from '../src/keystore.js';
import { createLogger } from '../src/log.js';
import { EXIT_RNG, checkRandomSource } from '../src/rng-check.js';

const real = globalThis.crypto.getRandomValues as unknown as GetRandomValues;
const GUARDIAN_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Two blocks, repeated: every draw differs from the last, so the per-call checks pass. */
function cycling(): (buf: Uint8Array) => void {
  const blocks = [0x11, 0x77].map((m) => Uint8Array.from({ length: 32 }, (_, i) => (i * 73 + m * 3) & 255));
  let n = 0;
  return (buf) => {
    for (let o = 0; o < buf.length; o += 32) buf.set(blocks[n++ % 2]!.subarray(0, Math.min(32, buf.length - o)), o);
  };
}

function lines() {
  const out: string[] = [];
  return { out, log: createLogger({ write: (l) => out.push(l) }) };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-rng-'));
});
afterEach(async () => {
  delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
  pinRandomSource(real, { name: 'node:crypto webcrypto', target: globalThis.crypto, repin: true });
  await rm(dir, { recursive: true, force: true });
});

describe('guardian start-up RNG check', () => {
  it('passes on the real source and logs one line', () => {
    const { out, log } = lines();
    expect(checkRandomSource(log)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/ INFO rng\.selftest_ok ms=\d+$/);
  });

  it('fails on a cycling source: a clear line, no bytes, and the exit code is not 0', () => {
    installRandomSource(cycling(), 'cycling');
    const { out, log } = lines();
    expect(checkRandomSource(log)).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/ ERROR rng\.selftest_failed code=health reason="guardian start: .*health test \(repeated_block: block 2 equals block 0\).*" action="refusing to start; no key was made"/);
    expect(out[0]).not.toMatch(/[0-9a-f]{16}/);
    expect(EXIT_RNG).not.toBe(0);
  });

  it('fails on an all-zero source', () => {
    installRandomSource((b) => b.fill(0), 'zeros');
    const { out, log } = lines();
    expect(checkRandomSource(log)).toBe(false);
    expect(out[0]).toMatch(/rng\.selftest_failed code=stuck/);
  });

  it('Guardian.open refuses to open with a bad source, before it touches the data folder', async () => {
    installRandomSource(cycling(), 'cycling');
    const config = loadConfig({ TRIKEY_DATA_DIR: join(dir, 'data'), BITCOIN_NETWORK: 'regtest' });
    const e = await Guardian.open({ config }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RandomSourceError);
    expect((e as RandomSourceError).code).toBe('health');
    await expect(readdir(join(dir, 'data'))).rejects.toThrow(/ENOENT/);
  });

  it('no key 3 seed and no identity are made from a bad source', async () => {
    installRandomSource(cycling(), 'cycling');
    expect(() => generateSeed()).toThrow(RandomSourceError);
    await expect(loadOrCreateIdentity(join(dir, 'identity'))).rejects.toThrow(RandomSourceError);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('main.ts exits with a non-zero code and writes no key file when the OS generator cycles', async () => {
    const data = join(dir, 'data');
    const r = spawnSync(process.execPath, ['--import', join(GUARDIAN_DIR, 'test/support/bad-rng-preload.mjs'), '--import', 'tsx', 'src/main.ts'], {
      cwd: GUARDIAN_DIR,
      env: { PATH: process.env.PATH ?? '', TRIKEY_DATA_DIR: data, BITCOIN_NETWORK: 'regtest', PORT: '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(EXIT_RNG);
    expect(r.stdout).toMatch(/ERROR rng\.selftest_failed code=health reason="guardian start: .*repeated_block/);
    expect(r.stdout).not.toMatch(/guardian\.(start|listening)/);
    expect(r.stdout + r.stderr).not.toMatch(/[0-9a-f]{32}/);
    await expect(readdir(data)).rejects.toThrow(/ENOENT/);
  }, 90_000);
});
