/**
 * Opening the app (docs/design/motion.md, section 9): the pure parts. The native splash's logo, measured; where the
 * app-drawn copy goes; every value of the sequence as a function of its clock; and the decisions (whether it plays,
 * where each key lands or whether it fades where it is). src/components/opening.tsx draws it with Reanimated.
 *
 * The frame functions are worklets: the overlay and Home call them on the UI thread, every frame, from one clock. They
 * only read numbers, so they also run here, in the tests. The worklets plugin turns each one into a constant that
 * captures what it calls when it is defined: a worklet must come after every worklet it calls (no hoisting).
 */
import { palette, type ColorScheme } from '../theme/tokens';
import { OPENING, REDUCED_FADE_MS, SPRINGS, STAGGER, STANDARD, type Curve, type SpringToken } from '../theme/motion';

// ---------------------------------------------------------------- the logo

/** The three keys: the orange one on top (the hardware wallet), this phone bottom left, the guardian bottom right. */
export type OpeningKey = 'hardware' | 'phone' | 'guardian';
export const OPENING_KEYS: readonly OpeningKey[] = ['hardware', 'phone', 'guardian'];

/**
 * The native splash's logo, measured from assets/splash-icon.png (and -dark.png, the same shapes): a 512-unit square
 * that app.json's expo-splash-screen config draws 120 wide, centred on the screen (iOS centres a 120pt image view;
 * Android puts the 120dp image in the middle of the 288dp splash icon, shown at its size). The keys are discs of
 * radius 52.3 units on the triangle's corners; the lines are 15.75 units wide, centre to centre.
 * src/lib/opening.test.ts checks these numbers against the PNG files and app.json.
 */
export const SPLASH_MARK = {
  imageWidth: 120,
  units: 512,
  keyRadius: 52.3,
  stroke: 15.75,
  keys: { hardware: { x: 256.5, y: 120.25 }, phone: { x: 109.75, y: 371.7 }, guardian: { x: 403.25, y: 371.7 } },
} as const;

/** The colours of the splash, for the system's appearance (the native splash follows the system, not the app's setting). */
export function splashColors(scheme: ColorScheme): { backdrop: string; ink: string; brand: string } {
  const p = palette[scheme];
  return { backdrop: p.screen, ink: p.ink, brand: p.brand };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const K = SPLASH_MARK.keys;
const SIDE_LEFT = dist(K.hardware, K.phone);
const SIDE_BOTTOM = dist(K.phone, K.guardian);
const SIDE_RIGHT = dist(K.guardian, K.hardware);

/**
 * The triangle, in the logo's units: drawn from the top key, down to this phone, across to the guardian and back up
 * (the dash runs this way). `vertexShare` is where each key sits along the outline, as a share of it.
 */
export const TRIANGLE = {
  path: `M${K.hardware.x} ${K.hardware.y} L${K.phone.x} ${K.phone.y} L${K.guardian.x} ${K.guardian.y} Z`,
  perimeter: SIDE_LEFT + SIDE_BOTTOM + SIDE_RIGHT,
  vertexShare: {
    hardware: 0,
    phone: SIDE_LEFT / (SIDE_LEFT + SIDE_BOTTOM + SIDE_RIGHT),
    guardian: (SIDE_LEFT + SIDE_BOTTOM) / (SIDE_LEFT + SIDE_BOTTOM + SIDE_RIGHT),
  } as Record<OpeningKey, number>,
} as const;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Where the app-drawn logo goes on a screen `width` x `height`: the same place and size as the native one. */
export type SplashLayout = { left: number; top: number; size: number; keyDiameter: number; keys: Record<OpeningKey, Point> };

export function splashLayout(width: number, height: number): SplashLayout {
  const size = SPLASH_MARK.imageWidth;
  const unit = size / SPLASH_MARK.units;
  const left = (width - size) / 2;
  const top = (height - size) / 2;
  const at = (p: Point): Point => ({ x: left + p.x * unit, y: top + p.y * unit });
  return { left, top, size, keyDiameter: 2 * SPLASH_MARK.keyRadius * unit, keys: { hardware: at(K.hardware), phone: at(K.phone), guardian: at(K.guardian) } };
}

// ---------------------------------------------------------------- curves

export function clamp01(x: number): number {
  'worklet';
  return x <= 0 || x !== x ? 0 : x >= 1 ? 1 : x;
}

/** How far through a step that starts at `at` and lasts `ms`, 0 to 1. */
export function share(t: number, at: number, ms: number): number {
  'worklet';
  return ms <= 0 ? (t >= at ? 1 : 0) : clamp01((t - at) / ms);
}

/** A CSS cubic bezier (x1, y1, x2, y2) at `x`, 0 to 1 (y may pass 1 for an overshoot curve). */
export function cubicBezier(c: Curve, x: number): number {
  'worklet';
  const p = clamp01(x);
  if (p === 0 || p === 1) return p;
  const [x1, y1, x2, y2] = c;
  const bx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t;
  const by = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t;
  // Newton's method on x(t) = p, then bisection if it wanders.
  let t = p;
  for (let i = 0; i < 8; i++) {
    const err = bx(t) - p;
    if (Math.abs(err) < 1e-6) return by(t);
    const d = (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1;
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = p;
  for (let i = 0; i < 30; i++) {
    const v = bx(t);
    if (Math.abs(v - p) < 1e-6) break;
    if (v < p) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

/** The standard curve (arriving or changing) at `x`. */
export function standardEase(x: number): number {
  'worklet';
  return cubicBezier(STANDARD.curve, x);
}

/**
 * A spring's step response, `ms` after it starts: 0 at the start, 1 at rest (an under-damped spring passes 1 first).
 * The same physics as Reanimated's `withSpring` from rest, so a spring can be read off a clock.
 */
export function springStep(ms: number, s: SpringToken): number {
  'worklet';
  if (!(ms > 0)) return 0;
  const t = ms / 1000;
  const w0 = Math.sqrt(s.stiffness / s.mass);
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  const decay = Math.exp(-zeta * w0 * t);
  if (decay < 1e-7) return 1;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

const frac = (x: number) => {
  'worklet';
  return x - Math.floor(x);
};

// ---------------------------------------------------------------- booting and ready (the overlay's own clock)

/**
 * The overlay's clock: `t` is ms since the app-drawn logo went on screen, `readyAt` the value of `t` when the app was
 * ready (negative until then).
 */
export type BootClock = { t: number; readyAt: number };

/** Whether the booting loop runs at `t`: only if the app was not ready `loopAfterMs` after the logo was drawn. */
export function loopRuns(c: BootClock): boolean {
  'worklet';
  if (c.t < OPENING.loopAfterMs) return false;
  return c.readyAt < 0 || (c.readyAt > OPENING.loopAfterMs && c.t < c.readyAt);
}

/** Where the dash was when the app became ready, as a share of a lap: 0 (the top key) after a fast boot. */
export function readyPhase(readyAt: number): number {
  'worklet';
  return readyAt > OPENING.loopAfterMs ? frac((readyAt - OPENING.loopAfterMs) / OPENING.lapMs) : 0;
}

/** The orange dash: where its tail is along the outline (a share, for `strokeDashoffset`) and its opacity. */
export function dashAt(c: BootClock): { phase: number; opacity: number } {
  'worklet';
  if (c.readyAt < 0 || c.t < c.readyAt) {
    return loopRuns(c) ? { phase: frac((c.t - OPENING.loopAfterMs) / OPENING.lapMs), opacity: 1 } : { phase: 0, opacity: 0 };
  }
  // Ready: one last lap from where it was, faster, fading over its end.
  const s = (c.t - c.readyAt) / OPENING.lastLapMs;
  if (s >= 1) return { phase: 0, opacity: 0 };
  const fade = s <= OPENING.lastLapFadeFrom ? 1 : 1 - (s - OPENING.lastLapFadeFrom) / (1 - OPENING.lastLapFadeFrom);
  return { phase: frac(readyPhase(c.readyAt) + s), opacity: fade };
}

/** `strokeDashoffset` of the dash (a dash array of the dash's length, then the rest of the outline). */
export function dashOffset(phase: number, perimeter: number): number {
  'worklet';
  return -phase * perimeter;
}

type Pulse = { scale: number; ringScale: number; ringOpacity: number };
const REST: Pulse = { scale: 1, ringScale: 1, ringOpacity: 0 };

/** A key's swell and ring `local` into a lap after the dash passed it (linear between the board's keyframes). */
export function swellAt(local: number): Pulse {
  'worklet';
  const { swell, swellRing } = OPENING;
  if (!(local >= 0)) return REST;
  const scale =
    local <= swell.peakAt
      ? 1 + (swell.scale - 1) * (local / swell.peakAt)
      : local < swell.endAt
        ? swell.scale - (swell.scale - 1) * ((local - swell.peakAt) / (swell.endAt - swell.peakAt))
        : 1;
  const r = local < swellRing.endAt ? local / swellRing.endAt : 1;
  return { scale, ringScale: 1 + (swellRing.scaleTo - 1) * r, ringOpacity: local < swellRing.endAt ? swellRing.opacityFrom * (1 - r) : 0 };
}

/** A key answering the last lap, `ms` after the dash passes it: a swell to 1.28 and back, and a ring. */
export function answerAt(ms: number): Pulse {
  'worklet';
  const a = OPENING.answer;
  if (!(ms >= 0)) return REST;
  const p = ms / a.ms;
  const scale =
    p >= 1 ? 1 : p <= a.peakShare ? 1 + (a.scale - 1) * standardEase(p / a.peakShare) : a.scale - (a.scale - 1) * standardEase((p - a.peakShare) / (1 - a.peakShare));
  const r = standardEase(share(ms, 0, a.ringMs));
  return { scale, ringScale: 1 + (a.ringScaleTo - 1) * r, ringOpacity: ms >= a.ringMs ? 0 : a.ringOpacityFrom * (1 - r) };
}

/** When the last lap passes `key`, in ms after ready: 160ms apart, in the order the dash meets them. */
export function answerTime(key: OpeningKey, readyAt: number): number {
  'worklet';
  return frac(TRIANGLE.vertexShare[key] - readyPhase(readyAt) + 1) * OPENING.lastLapMs;
}

/**
 * One key while booting and ready: swells as the dash passes, and answers the last lap. A swell under way when the app
 * became ready plays to its end (the larger of the two shows).
 */
export function keyPulse(key: OpeningKey, c: BootClock): Pulse {
  'worklet';
  const vertex = TRIANGLE.vertexShare[key];
  const loopLocal = (t: number) => {
    // How far past this key the dash is, in laps, once it has passed it at least once.
    const laps = (t - OPENING.loopAfterMs) / OPENING.lapMs;
    return laps < vertex ? -1 : frac(laps - vertex);
  };
  if (c.readyAt < 0 || c.t < c.readyAt) return loopRuns(c) ? swellAt(loopLocal(c.t)) : REST;
  // Ready. The swell that was under way, if any, carries on at the loop's pace...
  let carry = REST;
  if (c.readyAt > OPENING.loopAfterMs) {
    const at = loopLocal(c.readyAt);
    if (at >= 0 && at < OPENING.swellRing.endAt) carry = swellAt(at + (c.t - c.readyAt) / OPENING.lapMs);
  }
  // ...and the key answers as the last lap passes it.
  const answer = answerAt(c.t - c.readyAt - answerTime(key, c.readyAt));
  return {
    scale: Math.max(carry.scale, answer.scale),
    ringScale: carry.ringOpacity > answer.ringOpacity ? carry.ringScale : answer.ringScale,
    ringOpacity: Math.max(carry.ringOpacity, answer.ringOpacity),
  };
}

/** How much of the triangle's lines has retracted, 0 to 1 (300ms from 460ms after ready, standard). */
export function retractAt(c: BootClock): number {
  'worklet';
  if (c.readyAt < 0 || c.t < c.readyAt) return 0;
  return standardEase(share(c.t - c.readyAt, OPENING.retractAtMs, OPENING.retractMs));
}

// ---------------------------------------------------------------- landing (one clock for the overlay and Home)

/**
 * The landing's clock, shared by the overlay and Home: ms since the landing started. Before it starts it reads
 * `CLOCK_WAITING` (Home's parts are hidden, waiting); once it is over, or when the opening does not play, `CLOCK_DONE`
 * (everything in place).
 */
export const CLOCK_WAITING = -1e9;
export const CLOCK_DONE = 1e9;

/** Where a key lands: its place on Home (centre offset from the key, size as a scale) and that place's colour. */
export type KeyPlan = { fly: true; dx: number; dy: number; scale: number; color: string } | { fly: false };

/** A place on Home, measured in the window, and its colour. */
export type LandingTarget = { rect: Rect; color: string };

/**
 * Where each key lands. A key flies only to a place that was measured, has a size, and lies wholly on the screen;
 * otherwise it fades where it is (a new wallet has no limit dot, a locked guardian or a recovery shows another line,
 * Recovery Key mode has no limit, an urgent recovery card sits above Send and Receive, the app opened on another
 * screen). `origin` is where the overlay itself is in the window.
 */
export function landingPlan(
  layout: SplashLayout,
  screen: { width: number; height: number },
  targets: Partial<Record<OpeningKey, LandingTarget | null>>,
  origin: Point = { x: 0, y: 0 },
): Record<OpeningKey, KeyPlan> {
  const plan = {} as Record<OpeningKey, KeyPlan>;
  for (const key of OPENING_KEYS) plan[key] = planKey(layout, screen, targets[key], origin, key);
  return plan;
}

function planKey(layout: SplashLayout, screen: { width: number; height: number }, target: LandingTarget | null | undefined, origin: Point, key: OpeningKey): KeyPlan {
  if (!target) return { fly: false };
  const { rect } = target;
  const nums = [rect.x, rect.y, rect.width, rect.height, origin.x, origin.y, screen.width, screen.height, layout.keyDiameter];
  if (!nums.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || layout.keyDiameter <= 0) return { fly: false };
  const x = rect.x - origin.x;
  const y = rect.y - origin.y;
  if (x < 0 || y < 0 || x + rect.width > screen.width + 0.5 || y + rect.height > screen.height + 0.5) return { fly: false };
  const scale = Math.min(rect.width, rect.height) / layout.keyDiameter;
  if (scale > 8) return { fly: false };
  const from = layout.keys[key];
  return { fly: true, dx: x + rect.width / 2 - from.x, dy: y + rect.height / 2 - from.y, scale, color: target.color };
}

/** No key flies: the fallback when Home's places could not be read. */
export const NO_LANDING: Record<OpeningKey, KeyPlan> = { hardware: { fly: false }, phone: { fly: false }, guardian: { fly: false } };

/**
 * One key during the landing, `l` ms in. Flying: x and y on their own curves (so the path bends), the size on the land
 * spring (a small overshoot), the colour turning to its place's (`mix`, 0 to 1), then it fades as the real one takes
 * over. Not flying: it fades where it is.
 */
export function keyLanding(key: OpeningKey, l: number, plan: KeyPlan): { dx: number; dy: number; scale: number; mix: number; opacity: number } {
  'worklet';
  if (!plan.fly) return { dx: 0, dy: 0, scale: 1, mix: 0, opacity: 1 - share(l, 0, OPENING.missingFadeMs) };
  const d = l - OPENING.keyDelayMs[key];
  const s = share(d, 0, OPENING.flyMs);
  return {
    dx: plan.dx * cubicBezier(OPENING.xCurve, s),
    dy: plan.dy * cubicBezier(OPENING.yCurve, s),
    scale: 1 + (plan.scale - 1) * springStep(d, SPRINGS.land),
    mix: share(l, OPENING.colourAtMs[key], OPENING.colourMs),
    opacity: 1 - share(l, OPENING.handOverAtMs[key], OPENING.handOverMs),
  };
}

/** The overlay's backdrop (the splash's background): it fades as the landing starts, uncovering Home. */
export function backdropOpacity(l: number): number {
  'worklet';
  return 1 - share(l, 0, OPENING.backdropFadeMs);
}

/** When Recent's `index`-th item rises: 80ms apart from 740ms, the stagger rule's cap of six applying. */
export function recentAt(index: number): number {
  'worklet';
  const slot = Math.min(Math.max(0, Math.floor(index)), STAGGER.maxItems - 1);
  return OPENING.recentAtMs + slot * OPENING.recentStepMs;
}

/** The parts of Home that fill in. `index`: which button (0 Send, 1 Receive), or which of Recent's items (0 its heading). */
export type HomePart = 'balance' | 'balanceLine' | 'dot' | 'button' | 'label' | 'recent' | 'tabBar';

/** One part of Home `l` ms into the landing: its opacity, how far below its place it is, and its scale. */
export function homePart(part: HomePart, l: number, index = 0): { opacity: number; translateY: number; scale: number } {
  'worklet';
  const O = OPENING;
  switch (part) {
    case 'balance':
    case 'balanceLine': {
      const at = part === 'balance' ? O.balanceAtMs : O.balanceLineAtMs;
      return { opacity: standardEase(share(l, at, O.balanceFadeMs)), translateY: O.balanceRise * (1 - standardEase(share(l, at, O.balanceRiseMs))), scale: 1 };
    }
    case 'dot':
      return { opacity: share(l, O.dotAtMs, O.dotFadeMs), translateY: 0, scale: 1 };
    case 'button': {
      const i = index > 0 ? 1 : 0;
      return {
        opacity: share(l, O.buttonAtMs[i]!, O.buttonFadeMs),
        translateY: 0,
        scale: 1 + (O.buttonLandFrom - 1) * (1 - standardEase(share(l, O.buttonLandAtMs[i]!, O.buttonLandMs))),
      };
    }
    case 'label':
      return { opacity: share(l, O.labelsAtMs, O.labelsFadeMs), translateY: 0, scale: 1 };
    case 'recent': {
      const at = recentAt(index);
      const p = standardEase(share(l, at, O.recentMs));
      return { opacity: p, translateY: O.recentRise * (1 - p), scale: 1 };
    }
    case 'tabBar':
      return { opacity: share(l, O.tabBarAtMs, O.tabBarFadeMs), translateY: O.tabBarFrom * (1 - springStep(l - O.tabBarAtMs, SPRINGS.land)), scale: 1 };
  }
}

/** How much of the limit line's sentence shows, 0 to 1, revealed from its dot left to right (450ms from 620ms, standard). */
export function revealShare(l: number): number {
  'worklet';
  return standardEase(share(l, OPENING.revealAtMs, OPENING.revealMs));
}

// ---------------------------------------------------------------- decisions

/** What the overlay does once the app is ready: the whole sequence, or (Reduce Motion) the logo fading out over Home. */
export type OpeningMode = 'full' | 'fade';

export function openingMode(reduced: boolean): OpeningMode {
  return reduced ? 'fade' : 'full';
}

/**
 * Whether this start of the JavaScript plays the opening. Once per run: never again (a wallet mode switch remounts the
 * screens, not this), and never when returning from the background (the app is not started again then). An iPhone
 * that starts the app in the background (a background task) skips it: nobody sees it, and the next time the app comes
 * to the front it is a return. Android reports "background" until its first screen resumes, even on a normal start,
 * so there it is not asked; Android starts background tasks without any screen.
 */
export function opensWithAnimation(o: { os: string; appState: string | null | undefined; played: boolean }): boolean {
  if (o.played) return false;
  if (o.os === 'ios' && o.appState === 'background') return false;
  return true;
}

/** The app leaves the front while the opening runs: everything goes in place at once, so nothing plays on return. */
export function finishesOnAppState(state: string): boolean {
  return state === 'background';
}

/** How long the overlay stays after the app is ready, at most, whatever happens (it then goes and Home is in place). */
export function openingDeadline(mode: OpeningMode): number {
  return mode === 'fade' ? OPENING.reducedWaitMs + REDUCED_FADE_MS + 250 : OPENING.maxMs;
}
