/**
 * Small file helpers for the guardian's data directory.
 *
 * Every file the guardian writes holds either secrets (the encrypted key 3, the
 * nostr identity key) or state an attacker would like to roll back, so all
 * writes are atomic (temp file in the same directory, fsync, rename or link,
 * fsync the directory) and created with mode 0600.
 */
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { secureRandomBytes } from '@trikey/core/random';
import { hex } from '@scure/base';

export class FileExistsError extends Error {
  constructor(readonly path: string) {
    super(`refusing to overwrite ${basename(path)}`);
    this.name = 'FileExistsError';
  }
}

/**
 * Writes `data` to `path` atomically with mode 0600. With `overwrite: false`
 * the final step is a hard link, which fails if `path` already exists, so an
 * existing file (key 3!) can never be replaced, even by a racing writer.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: { overwrite?: boolean } = {}): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${hex.encode(secureRandomBytes(6))}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  try {
    if (opts.overwrite === false) {
      try {
        await link(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError(path);
        throw e;
      }
      await unlink(tmp);
    } else {
      await rename(tmp, path);
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await syncDir(dir);
}

async function syncDir(dir: string): Promise<void> {
  try {
    const d = await open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
    /* some platforms cannot fsync a directory; the rename is still atomic */
  }
}

/** Reads a JSON file, or returns undefined if it does not exist. */
export async function readJsonFile(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text) as unknown;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Creates the data directory (mode 0700) if needed and tightens a looser mode we own. */
export async function ensureDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await stat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if ((st.mode & 0o077) !== 0 && typeof process.getuid === 'function' && st.uid === process.getuid()) {
    // Best effort: a volume mounted by the platform may not let us change it.
    await chmod(dir, 0o700).catch(() => {});
  }
}

/** A promise-chain mutex: `run` calls execute one at a time, in order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
