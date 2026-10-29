import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GuardianState } from './types.js';

/** Where the engine keeps its state. `save` must be durable before it resolves. */
export interface StateStore {
  load(): Promise<GuardianState | undefined>;
  save(state: GuardianState): Promise<void>;
}

const BIGINT_TAG = '$bigint';

/** JSON with bigints tagged as {"$bigint": "123"}. */
export function serializeState(state: GuardianState): string {
  return JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v), 2);
}

export function deserializeState(text: string): GuardianState {
  const state = JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof v[BIGINT_TAG] === 'string' && /^-?\d+$/.test(v[BIGINT_TAG]))
        return BigInt(v[BIGINT_TAG]);
    }
    return v;
  }) as GuardianState;
  if (!state || state.version !== 1) throw new Error('unsupported guardian state version');
  return state;
}

/** Keeps state in memory, round-tripped through the same serializer as the file store. */
export class MemoryStore implements StateStore {
  private text?: string;
  saves = 0;

  async load(): Promise<GuardianState | undefined> {
    return this.text === undefined ? undefined : deserializeState(this.text);
  }

  async save(state: GuardianState): Promise<void> {
    this.text = serializeState(state);
    this.saves++;
  }
}

/**
 * One JSON file, replaced atomically: write a temp file in the same directory,
 * fsync it, rename it over the old file, then fsync the directory. A crash
 * leaves either the old or the new state, never a torn file.
 */
export class JsonFileStore implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<GuardianState | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    return deserializeState(text);
  }

  async save(state: GuardianState): Promise<void> {
    const dir = dirname(this.path);
    const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(serializeState(state), 'utf8');
      await fh.sync();
    } catch (e) {
      await fh.close();
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await fh.close();
    try {
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    // Make the rename itself durable. Some platforms can't fsync a directory; that's not fatal.
    try {
      const d = await open(dir, 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {
      /* best effort */
    }
  }
}
