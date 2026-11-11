/**
 * The motion tokens and the small choices built on them (docs/design/motion.md, "Shared tokens"). The animations
 * themselves run in Reanimated on a device; what is checked here is the numbers they are given.
 */
import { describe, expect, it } from 'vitest';
import {
  BREATHE,
  CROSSFADE_MS,
  DEVICE_RING,
  EXIT,
  NO_BOUNCE,
  NUMBER_SWAP,
  PRESS,
  PULSE_RING,
  REDUCED_FADE_MS,
  SENT,
  SHAKE,
  SPRINGS,
  STANDARD,
  STATUS_PULSES,
  limitShare,
  loopRepeats,
  motionPlan,
  shakeSteps,
  staggerDelay,
} from './motion';

describe('motion tokens', () => {
  it('are the table in the spec', () => {
    expect(STANDARD).toEqual({ duration: 240, curve: [0.2, 0, 0, 1] });
    expect(EXIT).toEqual({ duration: 160, curve: [0.4, 0, 1, 1] });
    expect(SPRINGS).toEqual({
      settle: { damping: 14, stiffness: 180, mass: 1 },
      firm: { damping: 26, stiffness: 300, mass: 1 },
      pop: { damping: 12, stiffness: 220, mass: 1 },
      toast: { damping: 16, stiffness: 200, mass: 1 },
      scanFrame: { damping: 20, stiffness: 260, mass: 1 },
    });
    expect(BREATHE).toEqual({ from: 1, to: 0.35, periodMs: 2400, smallPeriodMs: 1600 });
    expect(PULSE_RING).toMatchObject({ scaleTo: 2.6, opacityFrom: 0.55, periodMs: 1800, curve: [0.2, 0, 0.3, 1] });
    expect(DEVICE_RING).toMatchObject({ scaleTo: 1.12, opacityFrom: 0.5, periodMs: 2400 });
    expect(PRESS).toEqual({ scale: 0.96, inMs: 90 });
    expect(CROSSFADE_MS).toBe(160);
  });

  it('leave faster than they arrive', () => {
    expect(EXIT.duration).toBeLessThan(STANDARD.duration);
    expect(NUMBER_SWAP.outMs).toBeLessThan(NUMBER_SWAP.inMs);
  });

  it('keep the small overshoot, except the firm spring, which is clamped so it never bounces', () => {
    const ratio = (s: { damping: number; stiffness: number; mass: number }) => s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
    // All under-damped as specified (a ratio under 1 overshoots), the settle, pop and toast springs more so.
    expect(ratio(SPRINGS.firm)).toBeCloseTo(0.75, 2);
    for (const name of ['settle', 'pop', 'toast'] as const) {
      expect(ratio(SPRINGS[name])).toBeLessThan(ratio(SPRINGS.firm));
      expect(ratio(SPRINGS[name])).toBeGreaterThan(0.35);
    }
    expect(NO_BOUNCE).toEqual(['firm']);
  });
});

describe('Reduce Motion', () => {
  it('turns every change into a 150ms linear fade with no movement and no delay', () => {
    expect(motionPlan(true, STANDARD, 12, 300)).toEqual({ duration: REDUCED_FADE_MS, curve: 'linear', distance: 0, delay: 0 });
    expect(motionPlan(true, EXIT, 8)).toEqual({ duration: 150, curve: 'linear', distance: 0, delay: 0 });
  });

  it('leaves the token as it is otherwise', () => {
    expect(motionPlan(false, STANDARD, 12, 300)).toEqual({ duration: 240, curve: [0.2, 0, 0, 1], distance: 12, delay: 300 });
    expect(motionPlan(false, EXIT, -12)).toEqual({ duration: 160, curve: [0.4, 0, 1, 1], distance: -12, delay: 0 });
  });

  it('stops every loop', () => {
    expect(loopRepeats('activity', true)).toBe(0);
    expect(loopRepeats('status', true)).toBe(0);
  });
});

describe('loops', () => {
  it('activity loops run while the wait lasts; status loops pulse three times, then rest', () => {
    expect(loopRepeats('activity', false)).toBe(-1);
    expect(loopRepeats('status', false)).toBe(3);
    expect(STATUS_PULSES).toBe(3);
  });

  it('a pulse rests for the last 30% of its period, so three of them end in under 6 seconds', () => {
    expect(PULSE_RING.activeShare).toBe(0.7);
    expect(STATUS_PULSES * PULSE_RING.periodMs).toBeLessThan(6000);
  });
});

describe('staged entrances', () => {
  it('step 50-80ms apart, from a start', () => {
    expect([0, 1, 2].map((i) => staggerDelay(i, 60, 300))).toEqual([300, 360, 420]);
    expect(staggerDelay(1, 20)).toBe(50);
    expect(staggerDelay(1, 200)).toBe(80);
  });

  it('stagger at most six items: the rest arrive with the sixth', () => {
    expect(staggerDelay(5, 60)).toBe(300);
    expect(staggerDelay(6, 60)).toBe(300);
    expect(staggerDelay(40, 60)).toBe(300);
    expect(staggerDelay(-1, 60)).toBe(0);
  });

  it("Sent's buttons have arrived by about 600ms, after the check started to draw", () => {
    const buttons = SENT.firstItemAtMs + 5 * SENT.itemStepMs;
    expect(buttons).toBe(600);
    expect(SENT.checkAtMs).toBe(SENT.circleAtMs + 140);
    expect(SENT.checkAtMs).toBeLessThan(SENT.firstItemAtMs);
  });
});

describe('the shake', () => {
  it('is -6, 6, -4, 3, 0 over 360ms and ends where it started', () => {
    const steps = shakeSteps();
    expect(steps.map((s) => s.to)).toEqual([-6, 6, -4, 3, 0]);
    expect(steps.reduce((t, s) => t + s.ms, 0)).toBe(SHAKE.durationMs);
    expect(SHAKE.durationMs).toBe(360);
    expect(steps.at(-1)!.to).toBe(0);
  });
});

describe('the whole-number change', () => {
  it('lifts the old number 12px over 200ms and brings the new one in over 280ms, overlapping', () => {
    expect(NUMBER_SWAP).toEqual({ outMs: 200, inMs: 280, inDelayMs: 140, lift: 12 });
    expect(NUMBER_SWAP.inDelayMs).toBeLessThan(NUMBER_SWAP.outMs);
  });
});

describe('the limit bar', () => {
  it('shows what is left of the limit, held between empty and full', () => {
    expect(limitShare(150_000, 200_000)).toBe(0.75);
    expect(limitShare(0, 200_000)).toBe(0);
    expect(limitShare(300_000, 200_000)).toBe(1);
    expect(limitShare(-5, 200_000)).toBe(0);
    expect(limitShare(10, 0)).toBe(0);
  });
});
