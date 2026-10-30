/**
 * The data directory: made if missing, and a folder the guardian cannot write is refused at once with a
 * message that says why (on Umbrel, a folder Docker created for root), not at the first write deep inside
 * start-up.
 */
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDataDir } from '../src/files.js';

// Root can write anywhere, so the refusal can only be seen as another user (CI runs as one).
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('ensureDataDir', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'trikey-datadir-'));
  });
  afterEach(async () => {
    await chmod(base, 0o700).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });

  it('makes a missing folder, private to this user', async () => {
    const dir = join(base, 'data');
    await ensureDataDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isRoot)('refuses a folder it cannot write, and says whose it is', async () => {
    const dir = join(base, 'data');
    await ensureDataDir(dir);
    await chmod(dir, 0o500);
    await expect(ensureDataDir(dir)).rejects.toThrow(/is not writable by this process \(uid \d+; the folder belongs to uid \d+\)/);
  });
});
