/**
 * Rate limit for unlock attempts, shared by the web UI (`POST /api/unlock`)
 * and the protocol (`guardian.unlock`), persisted so a restart does not reset it.
 *
 * The first `freeAttempts` failures cost nothing; after that each attempt has
 * to wait `baseDelayMs * 2^(failures - freeAttempts)`, capped at `maxDelayMs`,
 * since the last one. Attempts are counted *before* the passphrase is checked
 * (and the count is persisted first), so crashing or killing the process in the
 * middle of an attempt does not give a free guess. A success resets the count.
 */
import { readJsonFile, writeFileAtomic } from './files.js';
import type { Clock } from './policy/index.js';

export interface ThrottleOptions {
  freeAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface ThrottleState {
  version: 1;
  failures: number;
  lastAttemptAt: number;
}

export type ThrottleVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export class UnlockThrottle {
  private state: ThrottleState = { version: 1, failures: 0, lastAttemptAt: 0 };
  private readonly freeAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    opts: ThrottleOptions = {},
  ) {
    this.freeAttempts = opts.freeAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.maxDelayMs = opts.maxDelayMs ?? 3_600_000;
  }

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as Partial<ThrottleState> | undefined;
    if (raw && raw.version === 1 && Number.isSafeInteger(raw.failures) && Number.isSafeInteger(raw.lastAttemptAt)) {
      this.state = { version: 1, failures: Math.max(0, raw.failures!), lastAttemptAt: raw.lastAttemptAt! };
    }
  }

  get failures(): number {
    return this.state.failures;
  }

  /** How long the next attempt must wait after the last one. */
  private delayMs(): number {
    const over = this.state.failures - this.freeAttempts;
    if (over < 0) return 0;
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(over, 40));
  }

  check(): ThrottleVerdict {
    const now = this.clock.now();
    // A clock that jumped backwards would otherwise lock unlocking out until it caught up.
    if (this.state.lastAttemptAt > now) this.state.lastAttemptAt = now;
    const wait = this.state.lastAttemptAt + this.delayMs() - now;
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  /** Counts an attempt and persists it before the caller checks the passphrase. */
  async begin(): Promise<void> {
    this.state = { version: 1, failures: this.state.failures + 1, lastAttemptAt: this.clock.now() };
    await this.save();
  }

  async succeeded(): Promise<void> {
    this.state = { version: 1, failures: 0, lastAttemptAt: this.clock.now() };
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify(this.state));
  }
}
