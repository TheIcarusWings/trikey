/**
 * Opening the app (docs/design/motion.md, section 9): the logo against the native splash, the timeline, where the keys
 * land, the fallbacks and when it plays. The overlay itself runs in Reanimated; what is checked here is every number it
 * draws.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { palette } from '../theme/tokens';
import { OPENING, SPRINGS, STANDARD, staggerDelay } from '../theme/motion';
import {
  CLOCK_DONE,
  CLOCK_WAITING,
  NO_LANDING,
  SPLASH_MARK,
  TRIANGLE,
  answerTime,
  backdropOpacity,
  cubicBezier,
  dashAt,
  finishesOnAppState,
  homePart,
  keyLanding,
  keyPulse,
  landingPlan,
  loopRuns,
  openingDeadline,
  openingMode,
  opensWithAnimation,
  recentAt,
  retractAt,
  revealShare,
  splashColors,
  splashLayout,
  springStep,
  swellAt,
  type HomePart,
  type LandingTarget,
} from './opening';

const root = join(__dirname, '..', '..');

// ---------------------------------------------------------------- a small PNG reader (8-bit RGBA, not interlaced)

function readPng(path: string): { width: number; height: number; px: (x: number, y: number) => [number, number, number, number] } {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, px: (x, y) => [out[y * stride + x * 4]!, out[y * stride + x * 4 + 1]!, out[y * stride + x * 4 + 2]!, out[y * stride + x * 4 + 3]!] };
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** Coverage (0 to 1) of pixels close to `color`, weighted by alpha. */
function coverage(png: ReturnType<typeof readPng>, color: string, x: number, y: number): number {
  const [r, g, b, a] = png.px(x, y);
  const [cr, cg, cb] = hex(color);
  return Math.abs(r - cr!) + Math.abs(g - cg!) + Math.abs(b - cb!) < 40 ? a / 255 : 0;
}

// ---------------------------------------------------------------- the logo

describe('the app-drawn logo', () => {
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
  const splash = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen')[1];

  it("matches app.json's splash: 120 wide, contained, on the screen colour of each appearance", () => {
    expect(splash).toMatchObject({ image: './assets/splash-icon.png', imageWidth: SPLASH_MARK.imageWidth, resizeMode: 'contain', backgroundColor: '#FFFFFF' });
    expect(splash.dark).toMatchObject({ image: './assets/splash-icon-dark.png', backgroundColor: '#09090B' });
    expect(splashColors('light').backdrop).toBe(splash.backgroundColor);
    expect(splashColors('dark').backdrop).toBe(splash.dark.backgroundColor);
  });

  for (const scheme of ['light', 'dark'] as const) {
    it(`has the shapes and colours of the ${scheme} splash image`, () => {
      const png = readPng(join(root, 'assets', scheme === 'light' ? 'splash-icon.png' : 'splash-icon-dark.png'));
      expect(png.width).toBe(SPLASH_MARK.units);
      const { ink, brand } = splashColors(scheme);
      // The orange key: its centre and radius from its area.
      let area = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 40; y < 210; y++) {
        for (let x = 170; x < 340; x++) {
          const w = coverage(png, brand, x, y);
          area += w;
          sx += w * (x + 0.5);
          sy += w * (y + 0.5);
        }
      }
      expect(sx / area).toBeCloseTo(SPLASH_MARK.keys.hardware.x, 0);
      expect(sy / area).toBeCloseTo(SPLASH_MARK.keys.hardware.y, 0);
      expect(Math.sqrt(area / Math.PI)).toBeCloseTo(SPLASH_MARK.keyRadius, 0);
      // The dark keys: their outer edges (left, right, bottom) one radius from their centres.
      const phone = SPLASH_MARK.keys.phone;
      const guardian = SPLASH_MARK.keys.guardian;
      const row = Math.round(phone.y);
      // Coverage summed up to a pixel boundary puts the edge that far before it.
      const end = Math.ceil(phone.x);
      let left = 0;
      for (let x = 0; x < end; x++) left += coverage(png, ink, x, row);
      expect(phone.x - (end - left)).toBeCloseTo(SPLASH_MARK.keyRadius, 0);
      let right = 0;
      for (let x = Math.round(guardian.x); x < 512; x++) right += coverage(png, ink, x, row);
      expect(Math.round(guardian.x) + right - guardian.x).toBeCloseTo(SPLASH_MARK.keyRadius, 0);
      let below = 0;
      for (let y = row; y < 512; y++) below += coverage(png, ink, Math.round(phone.x), y);
      expect(row + below - phone.y).toBeCloseTo(SPLASH_MARK.keyRadius, 0);
      // The bottom line: centre to centre, 15.75 wide.
      let line = 0;
      for (let y = 300; y < 440; y++) line += coverage(png, ink, 256, y);
      expect(line).toBeCloseTo(SPLASH_MARK.stroke, 0);
    });
  }

  it('sits where the native one does: a 120 square centred on the screen', () => {
    const l = splashLayout(390, 844);
    expect(l).toMatchObject({ left: 135, top: 362, size: 120 });
    expect(l.keyDiameter).toBeCloseTo(24.52, 2);
    expect(l.keys.hardware.x).toBeCloseTo(195.12, 2);
    expect(l.keys.phone.y).toBeCloseTo(l.keys.guardian.y, 6);
    expect(l.keys.phone.x + l.keys.guardian.x).toBeCloseTo(2 * l.keys.hardware.x, 6);
  });

  it('runs the dash from the top key, down to this phone, across to the guardian', () => {
    expect(TRIANGLE.path.startsWith(`M${SPLASH_MARK.keys.hardware.x} ${SPLASH_MARK.keys.hardware.y}`)).toBe(true);
    expect(TRIANGLE.vertexShare.hardware).toBe(0);
    expect(TRIANGLE.vertexShare.phone).toBeCloseTo(1 / 3, 2);
    expect(TRIANGLE.vertexShare.guardian).toBeCloseTo(2 / 3, 2);
  });
});

// ---------------------------------------------------------------- curves

describe('curves', () => {
  it('reads a cubic bezier as CSS does', () => {
    for (const c of [STANDARD.curve, OPENING.xCurve, OPENING.yCurve]) {
      expect(cubicBezier(c, 0)).toBe(0);
      expect(cubicBezier(c, 1)).toBe(1);
      for (let x = 0.1; x < 1; x += 0.1) expect(cubicBezier(c, x)).toBeGreaterThan(cubicBezier(c, x - 0.05));
    }
    // A linear bezier is the identity.
    expect(cubicBezier([0.25, 0.25, 0.75, 0.75], 0.37)).toBeCloseTo(0.37, 4);
    // The y curve starts later than the x curve: the path bends.
    expect(cubicBezier(OPENING.yCurve, 0.3)).toBeLessThan(cubicBezier(OPENING.xCurve, 0.3));
  });

  it('springs like the board: the land spring passes its target by about 6% near 400ms and is at rest by 700ms', () => {
    let peak = 0;
    let peakAt = 0;
    for (let ms = 0; ms <= 1000; ms += 5) {
      const v = springStep(ms, SPRINGS.land);
      if (v > peak) [peak, peakAt] = [v, ms];
    }
    expect(peak).toBeGreaterThan(1.04);
    expect(peak).toBeLessThan(1.08);
    expect(peakAt).toBeGreaterThan(350);
    expect(peakAt).toBeLessThan(450);
    expect(Math.abs(springStep(700, SPRINGS.land) - 1)).toBeLessThan(0.01);
    expect(springStep(0, SPRINGS.land)).toBe(0);
    expect(springStep(CLOCK_DONE, SPRINGS.land)).toBe(1);
  });
});

// ---------------------------------------------------------------- booting and ready

describe('booting', () => {
  it('skips the loop on a fast boot', () => {
    const readyAt = OPENING.loopAfterMs - 50;
    for (let t = 0; t < 2000; t += 20) expect(loopRuns({ t, readyAt })).toBe(false);
    // Before ready the dash is not drawn at all; the last lap starts at the top key.
    expect(dashAt({ t: 200, readyAt: -1 }).opacity).toBe(0);
    expect(dashAt({ t: readyAt + 1, readyAt })).toMatchObject({ opacity: 1 });
    expect(dashAt({ t: readyAt + 1, readyAt }).phase).toBeCloseTo(0, 2);
  });

  it('runs the loop while a slow boot lasts: a lap in 1.4s, and each key swells as the dash passes', () => {
    expect(loopRuns({ t: OPENING.loopAfterMs - 1, readyAt: -1 })).toBe(false);
    expect(loopRuns({ t: OPENING.loopAfterMs + 1, readyAt: -1 })).toBe(true);
    const at = (ms: number) => dashAt({ t: OPENING.loopAfterMs + ms, readyAt: -1 });
    expect(at(700).phase).toBeCloseTo(0.5, 6);
    expect(at(1400 + 350).phase).toBeCloseTo(0.25, 6);
    // The swell peaks at 1.24, 8% of a lap after the dash leaves the key, and the ring fades by 36%.
    expect(swellAt(OPENING.swell.peakAt).scale).toBeCloseTo(1.24, 6);
    expect(swellAt(0.3)).toMatchObject({ scale: 1 });
    expect(swellAt(0.36).ringOpacity).toBe(0);
    const phoneSwell = OPENING.loopAfterMs + (TRIANGLE.vertexShare.phone + OPENING.swell.peakAt) * OPENING.lapMs;
    expect(keyPulse('phone', { t: phoneSwell, readyAt: -1 }).scale).toBeCloseTo(1.24, 3);
    // A key the dash has not reached yet stays still.
    expect(keyPulse('guardian', { t: OPENING.loopAfterMs + 100, readyAt: -1 }).scale).toBe(1);
  });

  it('starts the last lap where the dash is, with no jump, and fades it at its end', () => {
    const readyAt = OPENING.loopAfterMs + 1000;
    expect(dashAt({ t: readyAt, readyAt }).phase).toBeCloseTo(dashAt({ t: readyAt - 0.001, readyAt: -1 }).phase, 4);
    // A lap in 480ms.
    expect(dashAt({ t: readyAt + 240, readyAt }).phase).toBeCloseTo((1000 / 1400 + 0.5) % 1, 6);
    expect(dashAt({ t: readyAt + 0.9 * 480, readyAt }).opacity).toBeCloseTo(1, 6);
    expect(dashAt({ t: readyAt + 480, readyAt }).opacity).toBe(0);
  });

  it('has the keys answer the last lap 160ms apart, in the order the dash meets them', () => {
    const fast = 100;
    expect(answerTime('hardware', fast)).toBe(0);
    expect(answerTime('phone', fast)).toBeCloseTo(160, -1);
    expect(answerTime('guardian', fast)).toBeCloseTo(320, -1);
    // From halfway round, the guardian answers first.
    const half = OPENING.loopAfterMs + 700;
    expect(answerTime('guardian', half)).toBeLessThan(answerTime('hardware', half));
    expect(answerTime('hardware', half)).toBeLessThan(answerTime('phone', half));
    // The answer: 1.28 at 40% of 320ms, back to 1 by 320ms.
    const peak = fast + answerTime('phone', fast) + 0.4 * OPENING.answer.ms;
    expect(keyPulse('phone', { t: peak, readyAt: fast }).scale).toBeCloseTo(1.28, 3);
    expect(keyPulse('phone', { t: fast + answerTime('phone', fast) + 320, readyAt: fast }).scale).toBe(1);
  });

  it('lets a swell under way when ready play to its end', () => {
    // Ready just after the dash passed the top key: its swell carries on rather than snapping back.
    const readyAt = OPENING.loopAfterMs + 1400 + 0.05 * 1400;
    const before = keyPulse('hardware', { t: readyAt - 0.001, readyAt: -1 }).scale;
    const after = keyPulse('hardware', { t: readyAt + 0.001, readyAt }).scale;
    expect(after).toBeCloseTo(before, 2);
  });

  it('retracts the lines in 300ms from 460ms after ready', () => {
    expect(retractAt({ t: 1000, readyAt: -1 })).toBe(0);
    expect(retractAt({ t: 100 + 459, readyAt: 100 })).toBe(0);
    expect(retractAt({ t: 100 + 610, readyAt: 100 })).toBeGreaterThan(0.5);
    expect(retractAt({ t: 100 + 760, readyAt: 100 })).toBe(1);
    expect(OPENING.retractAtMs + OPENING.retractMs).toBeLessThanOrEqual(OPENING.readyMs);
  });
});

// ---------------------------------------------------------------- landing

describe('where the keys land', () => {
  const screen = { width: 390, height: 844 };
  const logo = splashLayout(screen.width, screen.height);
  const send: LandingTarget = { rect: { x: 108, y: 300, width: 64, height: 64 }, color: palette.light.accent };
  const receive: LandingTarget = { rect: { x: 220, y: 300, width: 64, height: 64 }, color: palette.light.fill };
  const dot: LandingTarget = { rect: { x: 40, y: 270, width: 8, height: 8 }, color: palette.light.good };

  it('flies each key to the centre of its place, sized to it: the buttons about 2.6x, the dot about a third', () => {
    const plan = landingPlan(logo, screen, { phone: send, guardian: receive, hardware: dot });
    expect(plan.phone).toMatchObject({ fly: true, color: palette.light.accent });
    if (!plan.phone.fly || !plan.hardware.fly || !plan.guardian.fly) throw new Error('should fly');
    expect(logo.keys.phone.x + plan.phone.dx).toBeCloseTo(140, 6);
    expect(logo.keys.phone.y + plan.phone.dy).toBeCloseTo(332, 6);
    expect(plan.phone.scale).toBeCloseTo(64 / logo.keyDiameter, 6);
    expect(plan.phone.scale).toBeCloseTo(2.61, 2);
    expect(plan.hardware.scale).toBeCloseTo(0.33, 2);
    expect(logo.keys.guardian.x + plan.guardian.dx).toBeCloseTo(252, 6);
  });

  it("measures the places in the overlay's own frame", () => {
    const plan = landingPlan(logo, screen, { phone: { ...send, rect: { ...send.rect, y: 320 } } }, { x: 0, y: 20 });
    if (!plan.phone.fly) throw new Error('should fly');
    expect(logo.keys.phone.y + plan.phone.dy).toBeCloseTo(332, 6);
  });

  it('fades a key where it is when its place is missing or cannot be trusted', () => {
    // A new wallet, a locked guardian, Recovery Key mode, another screen: no place registered.
    expect(landingPlan(logo, screen, {})).toEqual(NO_LANDING);
    expect(landingPlan(logo, screen, { phone: send }).hardware).toEqual({ fly: false });
    // Not measured in time, no size, not a number, off the screen, or absurd.
    const bad: LandingTarget['rect'][] = [
      { x: 108, y: 300, width: 0, height: 64 },
      { x: Number.NaN, y: 300, width: 64, height: 64 },
      { x: 108, y: 820, width: 64, height: 64 },
      { x: -30, y: 300, width: 64, height: 64 },
      { x: 0, y: 0, width: 390, height: 390 },
    ];
    for (const rect of bad) expect(landingPlan(logo, screen, { phone: { rect, color: '#000' } }).phone).toEqual({ fly: false });
    expect(landingPlan(logo, screen, { phone: null }).phone).toEqual({ fly: false });
  });

  it('flies on two curves for 560ms, springs to size, turns colour, and hands over at 580ms (the right key 60ms later)', () => {
    const plan = landingPlan(logo, screen, { phone: send, guardian: receive, hardware: dot });
    const start = keyLanding('phone', 0, plan.phone);
    expect(Math.abs(start.dx) + Math.abs(start.dy)).toBe(0);
    expect(start).toMatchObject({ scale: 1, mix: 0, opacity: 1 });
    const mid = keyLanding('phone', 200, plan.phone);
    if (!plan.phone.fly) throw new Error('should fly');
    // The path bends: x is further along than y.
    expect(mid.dx / plan.phone.dx).toBeGreaterThan(mid.dy / plan.phone.dy);
    const end = keyLanding('phone', 560, plan.phone);
    expect(end.dx).toBeCloseTo(plan.phone.dx, 6);
    expect(end.dy).toBeCloseTo(plan.phone.dy, 6);
    expect(end.mix).toBe(1);
    expect(keyLanding('phone', 580, plan.phone).opacity).toBe(1);
    expect(keyLanding('phone', 700, plan.phone).opacity).toBe(0);
    expect(Math.abs(keyLanding('guardian', 60, plan.guardian).dx)).toBe(0);
    expect(keyLanding('guardian', 60, plan.guardian).scale).toBe(1);
    expect(keyLanding('guardian', 700, plan.guardian).opacity).toBeGreaterThan(0);
    expect(keyLanding('guardian', 760, plan.guardian).opacity).toBe(0);
    // A small overshoot on the way.
    const scales = Array.from({ length: 70 }, (_, i) => keyLanding('phone', i * 10, plan.phone).scale);
    expect(Math.max(...scales)).toBeGreaterThan(plan.phone.scale);
    expect(Math.max(...scales)).toBeLessThan(plan.phone.scale * 1.06);
  });

  it('fades a missing key in place over 200ms, and the backdrop with it', () => {
    expect(keyLanding('hardware', 0, { fly: false })).toMatchObject({ dx: 0, dy: 0, scale: 1, opacity: 1 });
    expect(keyLanding('hardware', 100, { fly: false }).opacity).toBeCloseTo(0.5, 6);
    expect(keyLanding('hardware', 200, { fly: false }).opacity).toBe(0);
    expect(backdropOpacity(CLOCK_WAITING)).toBe(1);
    expect(backdropOpacity(100)).toBeCloseTo(0.5, 6);
    expect(backdropOpacity(200)).toBe(0);
  });
});

// ---------------------------------------------------------------- Home fills in

describe('Home filling in', () => {
  const parts: [HomePart, number][] = [
    ['balance', 0],
    ['balanceLine', 0],
    ['dot', 0],
    ['button', 0],
    ['button', 1],
    ['label', 0],
    ['recent', 0],
    ['recent', 3],
    ['tabBar', 0],
  ];

  it('is hidden while the opening waits, and exactly in place when it is over or does not play', () => {
    for (const [part, i] of parts) {
      expect(homePart(part, CLOCK_WAITING, i).opacity).toBe(0);
      expect(homePart(part, CLOCK_DONE, i)).toEqual({ opacity: 1, translateY: 0, scale: 1 });
      // ...and by the end of the landing's clock.
      const end = homePart(part, OPENING.landingMs, i);
      expect(end.opacity).toBe(1);
      expect(Math.abs(end.translateY)).toBeLessThan(0.5);
      expect(end.scale).toBeCloseTo(1, 6);
    }
    expect(revealShare(CLOCK_WAITING)).toBe(0);
    expect(revealShare(CLOCK_DONE)).toBe(1);
  });

  it('follows the board: balance from 300ms, its line 80ms later, the dot at 560ms, the sentence from 620ms', () => {
    expect(homePart('balance', 300).opacity).toBe(0);
    expect(homePart('balance', 300).translateY).toBe(18);
    expect(homePart('balance', 500).opacity).toBeGreaterThan(0.5);
    expect(homePart('balanceLine', 380).opacity).toBe(0);
    expect(homePart('dot', 559).opacity).toBe(0);
    expect(homePart('dot', 660).opacity).toBe(1);
    expect(revealShare(620)).toBe(0);
    expect(revealShare(845)).toBeGreaterThan(0.5);
    expect(revealShare(1070)).toBe(1);
  });

  it('shows Send and Receive as the keys hand over: at 1.1, settling to 1; then their names', () => {
    expect(homePart('button', 560, 0)).toMatchObject({ opacity: 0, scale: 1.1 });
    expect(homePart('button', 660, 0).opacity).toBe(1);
    expect(homePart('button', 620, 1).opacity).toBe(0);
    expect(homePart('button', 980, 0).scale).toBe(1);
    expect(homePart('button', 1040, 1).scale).toBe(1);
    // The circle is fully there by the time the key has faded.
    expect(OPENING.buttonAtMs[0]! + OPENING.buttonFadeMs).toBeLessThanOrEqual(OPENING.handOverAtMs.phone + OPENING.handOverMs);
    expect(homePart('label', 700).opacity).toBe(0);
    expect(homePart('label', 940).opacity).toBe(1);
  });

  it('brings Recent in 80ms apart within the stagger rule, and springs the tab bar up from 660ms', () => {
    for (let i = 0; i < 9; i++) expect(recentAt(i)).toBe(staggerDelay(i, OPENING.recentStepMs, OPENING.recentAtMs));
    expect(recentAt(1) - recentAt(0)).toBe(80);
    expect(homePart('recent', recentAt(2), 2)).toMatchObject({ opacity: 0, translateY: 14 });
    expect(homePart('tabBar', 660)).toMatchObject({ opacity: 0, translateY: 70 });
    const ys = Array.from({ length: 80 }, (_, i) => homePart('tabBar', 660 + i * 10).translateY);
    // It passes its place a little (the spring's overshoot), then rests.
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.min(...ys)).toBeGreaterThan(-6);
  });
});

// ---------------------------------------------------------------- the whole timeline, and the decisions

describe('the sequence', () => {
  it('lasts about 2s from ready, the overlay going well before, and never past the deadline', () => {
    // At the latest: Home late (the whole wait), and its places slow to measure.
    const landingStart = OPENING.readyMs + OPENING.homeWaitMs + 50 + OPENING.measureWaitMs;
    const keysGone = Math.max(OPENING.handOverAtMs.guardian + OPENING.handOverMs, OPENING.missingFadeMs, OPENING.backdropFadeMs);
    expect(landingStart + keysGone).toBeLessThanOrEqual(2050);
    // Usually: Home there, measured within a frame or two.
    expect(OPENING.readyMs + 40 + keysGone).toBeLessThanOrEqual(1600);
    // Everything of Home has arrived by the end of the landing's clock.
    const lastRecent = recentAt(3) + OPENING.recentMs;
    expect(lastRecent).toBeLessThanOrEqual(OPENING.landingMs);
    expect(OPENING.revealAtMs + OPENING.revealMs).toBeLessThanOrEqual(OPENING.landingMs);
    expect(OPENING.readyMs + OPENING.landingMs).toBeGreaterThan(1900);
    expect(OPENING.readyMs + OPENING.landingMs).toBeLessThan(2300);
    expect(landingStart + OPENING.landingMs).toBeLessThan(openingDeadline('full'));
    expect(openingDeadline('full')).toBeLessThanOrEqual(2800);
  });

  it('with Reduce Motion is only a 150ms fade of the logo once Home is there, gone within 1.1s', () => {
    expect(openingMode(true)).toBe('fade');
    expect(openingMode(false)).toBe('full');
    expect(OPENING.reducedWaitMs + 150).toBeLessThan(openingDeadline('fade'));
    expect(openingDeadline('fade')).toBeLessThanOrEqual(1100);
  });

  it('plays once per start of the app, and not for an iPhone started in the background', () => {
    expect(opensWithAnimation({ os: 'ios', appState: 'active', played: false })).toBe(true);
    expect(opensWithAnimation({ os: 'ios', appState: 'background', played: false })).toBe(false);
    // Android says "background" until its screen resumes, even on a normal start.
    expect(opensWithAnimation({ os: 'android', appState: 'background', played: false })).toBe(true);
    expect(opensWithAnimation({ os: 'web', appState: 'active', played: false })).toBe(true);
    expect(opensWithAnimation({ os: 'android', appState: 'active', played: true })).toBe(false);
  });

  it('puts everything in place at once when the app leaves the front', () => {
    expect(finishesOnAppState('background')).toBe(true);
    // iOS goes "inactive" for a notification pulled down: the opening carries on.
    expect(finishesOnAppState('inactive')).toBe(false);
    expect(finishesOnAppState('active')).toBe(false);
  });
});

describe('the worklets', () => {
  it('each come after every worklet they call (the worklets plugin does not hoist them)', () => {
    const src = readFileSync(join(__dirname, 'opening.ts'), 'utf8');
    const decl = /(?:export )?(?:function (\w+)\([^\n]*\{|const (\w+) = \([^\n]*=> \{)\n\s*'worklet';/g;
    const worklets: { name: string; at: number }[] = [];
    for (let m = decl.exec(src); m; m = decl.exec(src)) worklets.push({ name: (m[1] ?? m[2])!, at: m.index });
    expect(worklets.length).toBeGreaterThan(15);
    worklets.forEach((w, i) => {
      const end = worklets[i + 1]?.at ?? src.length;
      const body = src.slice(w.at, end);
      for (const other of worklets) {
        if (other.name === w.name || !new RegExp(`\\b${other.name}\\(`).test(body.slice(body.indexOf("'worklet'")))) continue;
        expect(other.at, `${w.name} calls ${other.name}, defined after it`).toBeLessThan(w.at);
      }
    });
  });
});
