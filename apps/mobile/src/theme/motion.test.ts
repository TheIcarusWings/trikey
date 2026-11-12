/**
 * The motion tokens and the small choices built on them (docs/design/motion.md, "Shared tokens"). The animations
 * themselves run in Reanimated on a device; what is checked here is the numbers they are given.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_SET,
  BREATHE,
  COUNTDOWN,
  CROSSFADE_MS,
  GUARDIAN_NOTICE,
  PAIRING,
  RECOVERY_ALERT,
  STAGGER,
  guardianNoticeMove,
  ringOffset,
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
  BUMP,
  SECURITY_ENTRANCE,
  SECURITY_FIX,
  SECURITY_HALO,
  SYNC_RING,
  securityTileTimes,
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

describe('section 6: the recovery alert and countdown', () => {
  it('scales the red mark 0.85 to 1 in 240ms and brings the words in 50ms apart', () => {
    expect(RECOVERY_ALERT).toMatchObject({ markFromScale: 0.85, markMs: STANDARD.duration, textAtMs: 50, textStepMs: 50 });
    expect(RECOVERY_ALERT.textStepMs).toBeGreaterThanOrEqual(STAGGER.minMs);
  });

  it('sweeps the ring once (900ms from 300ms), brings the steps 80ms apart and empties in 400ms when cancelled', () => {
    expect(COUNTDOWN).toMatchObject({ sweepAtMs: 300, sweepMs: 900, stepMs: 80, emptyMs: 400 });
    expect(COUNTDOWN.stepMs).toBeLessThanOrEqual(STAGGER.maxMs);
    // The steps arrive after the time left, and each done step's check draws after its step has arrived.
    expect(COUNTDOWN.stepsAtMs).toBeGreaterThan(COUNTDOWN.labelAtMs);
    expect(COUNTDOWN.checkAfterMs).toBeGreaterThan(0);
  });

  it("works out the ring's offset from the share of the wait that has passed", () => {
    const c = 2 * Math.PI * 95;
    expect(ringOffset(0.5, c)).toBeCloseTo(c / 2);
    expect(ringOffset(1, c)).toBe(0);
    expect(ringOffset(2, c)).toBe(0);
    // Never quite empty: a sliver shows from the start.
    expect(ringOffset(0, c)).toBeCloseTo(c * (1 - COUNTDOWN.minShare));
    expect(ringOffset(-1, c)).toBeCloseTo(c * (1 - COUNTDOWN.minShare));
    expect(ringOffset(Number.NaN, c)).toBeCloseTo(c * (1 - COUNTDOWN.minShare));
  });
});

describe('section 5: the guardian notice', () => {
  it('turns green and opens the shackle when the guardian is unlocked, with success felt', () => {
    expect(guardianNoticeMove('locked', 'online')).toEqual({ kind: 'unlocked', haptic: 'success' });
  });

  it('opens with no haptic when the guardian locks or goes offline (the state does not say who locked it)', () => {
    expect(guardianNoticeMove('online', 'locked')).toEqual({ kind: 'open' });
    expect(guardianNoticeMove('online', 'offline')).toEqual({ kind: 'open' });
  });

  it('closes "Guardian offline" without the padlock or a haptic, and swaps locked and offline in place', () => {
    expect(guardianNoticeMove('offline', 'online')).toEqual({ kind: 'close' });
    expect(guardianNoticeMove('locked', 'offline')).toEqual({ kind: 'swap' });
    expect(guardianNoticeMove('offline', 'locked')).toEqual({ kind: 'swap' });
    for (const s of ['online', 'locked', 'offline'] as const) expect(guardianNoticeMove(s, s)).toEqual({ kind: 'none' });
  });

  it('turns in 280ms, opens the shackle in 240ms, holds 1.4s and collapses in 280ms', () => {
    expect(GUARDIAN_NOTICE).toMatchObject({ shackleMs: 240, turnMs: 280, holdMs: 1400, closeMs: 280, openMs: 280 });
  });
});

describe('section 4: pairing and all set', () => {
  it('closes the frame onto the code and opens the next step 700ms after pairing', () => {
    expect(PAIRING.closeTo).toBeGreaterThan(0);
    expect(PAIRING.closeTo).toBeLessThan(1);
    expect(PAIRING.nextStepMs).toBe(700);
  });

  it("brings All set's six rows in 70ms apart, after the check started to draw", () => {
    expect(ALL_SET.rowStepMs).toBe(70);
    const rows = [0, 1, 2, 3, 4, 5].map((i) => staggerDelay(i, ALL_SET.rowStepMs, ALL_SET.firstRowAtMs));
    expect(rows).toEqual([340, 410, 480, 550, 620, 690]);
    expect(ALL_SET.checkAtMs).toBeLessThan(ALL_SET.titleAtMs);
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

describe('section 8: the Security tab', () => {
  it('enters as the spec says: banner, hardware 150ms, links 450ms for 450ms, phone 700ms, guardian 900ms, check 1.35s, ring 1.45s', () => {
    expect(SECURITY_ENTRANCE).toMatchObject({
      bannerFadeMs: 240,
      markAtMs: { hardware: 150, phone: 700, guardian: 900 },
      linksAtMs: 450,
      linksMs: 450,
      checkAtMs: 1350,
      haloAtMs: 1450,
      tileStepMs: 50,
      tileRise: 8,
      dotsAtMs: 300,
    });
    // About 1.8s in all: the soft ring is the last thing to move.
    expect(SECURITY_ENTRANCE.haloAtMs + SECURITY_ENTRANCE.haloMs).toBeGreaterThanOrEqual(1800);
    expect(SECURITY_ENTRANCE.haloAtMs + SECURITY_ENTRANCE.haloMs).toBeLessThanOrEqual(2200);
  });

  it('rises the tiles 50ms apart and pops their dots from 300ms, within the stagger rule', () => {
    expect([0, 1, 2, 3].map((i) => securityTileTimes(i))).toEqual([
      { riseAt: 0, dotAt: 300 },
      { riseAt: 50, dotAt: 360 },
      { riseAt: 100, dotAt: 420 },
      { riseAt: 150, dotAt: 480 },
    ]);
    // At most six items are staggered: the seventh and eighth tiles arrive with the sixth.
    expect(securityTileTimes(7)).toEqual(securityTileTimes(5));
  });

  it('turns "not set" into "all set" following the timing table exactly', () => {
    const table: [number, string][] = [
      [SECURITY_FIX.colourAtMs, 'colour'],
      [SECURITY_FIX.dashedOutAtMs, 'dashed links fade'],
      [SECURITY_FIX.linksAtMs, 'solid links draw'],
      [SECURITY_FIX.textOutAtMs, 'old text lifts out'],
      [SECURITY_FIX.textInAtMs, 'new text rises in'],
      [SECURITY_FIX.alertOutAtMs, 'alert mark fades'],
      [SECURITY_FIX.checkAtMs, 'check draws'],
      [SECURITY_FIX.haloAtMs, 'soft ring'],
    ];
    expect(table.map(([ms]) => ms)).toEqual([200, 300, 350, 450, 540, 550, 750, 850]);
    expect(SECURITY_FIX).toMatchObject({ ringMs: 500, colourMs: 500, dashedOutMs: 250, linksMs: 400 });
  });

  it('never leaves the banner empty: the new words start before the old have gone', () => {
    expect(SECURITY_FIX.textInAtMs).toBeGreaterThan(SECURITY_FIX.textOutAtMs);
    expect(SECURITY_FIX.textInAtMs).toBeLessThan(SECURITY_FIX.textOutAtMs + NUMBER_SWAP.outMs);
  });

  it('rings every 1.2s while syncing, spreads one soft ring from the centre, and bumps a changed dot', () => {
    expect(SYNC_RING.periodMs).toBe(1200);
    expect(SYNC_RING.scaleTo).toBe(PULSE_RING.scaleTo);
    expect(SECURITY_HALO).toEqual({ fromScale: 0.6, toScale: 2.4, opacityFrom: 0.4 });
    expect(BUMP.scale).toBeGreaterThan(1);
  });
});
