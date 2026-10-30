/** Injected time source, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests (and simulations) move by hand. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const SECOND = 1000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** What the engine needs to know of the chain to check its own clock: the tip's height and median time past. */
export interface ChainTime {
  height: number;
  /** Median time past of the tip, ms since the Unix epoch. */
  medianTimePastMs: number;
}

/**
 * The chain's time (the service asks Electrs; tests move one by hand). `tip()` rejects when no chain
 * data is available: the engine then refuses what it cannot check (a recovery start, a completion, and
 * once its last observation is too old, a co-signature).
 */
export interface ChainTimeSource {
  tip(): Promise<ChainTime>;
}

/** A chain that follows a clock exactly (median time past = the clock, one block per 10 minutes): tests that do not test clock trust. */
export class ClockChain implements ChainTimeSource {
  constructor(private readonly clock: Clock) {}
  async tip(): Promise<ChainTime> {
    const now = this.clock.now();
    return { height: Math.floor(now / 600_000), medianTimePastMs: now };
  }
}

/** A chain tests move by hand, independently of the clock. `available = false` makes `tip()` reject. */
export class ManualChain implements ChainTimeSource {
  available = true;
  constructor(
    public height: number,
    public medianTimePastMs: number,
  ) {}
  async tip(): Promise<ChainTime> {
    if (!this.available) throw new Error('chain data is unavailable');
    return { height: this.height, medianTimePastMs: this.medianTimePastMs };
  }
  /** `blocks` blocks over `ms` of chain time. */
  advance(ms: number, blocks = Math.floor(ms / 600_000)): void {
    this.medianTimePastMs += ms;
    this.height += blocks;
  }
}
