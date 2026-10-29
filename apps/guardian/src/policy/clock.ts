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
