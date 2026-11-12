/**
 * Motion tokens: the numbers of docs/design/motion.md ("Shared tokens"), and the small pure choices built on them.
 * Plain numbers only, so they can be tested: src/components/motion.tsx turns them into Reanimated animations.
 *
 * Rules the pieces follow: only opacity, transform and colour move (plus an SVG stroke), on the UI thread; motion never
 * delays a button, hides a warning or plays on Cancel; every state also says itself in words or an icon; and with
 * Reduce Motion on nothing moves: states swap with a short opacity fade.
 */

/** A cubic bezier's control points, as CSS writes them. */
export type Curve = readonly [number, number, number, number];

/** A physical spring. Reanimated's `withSpring` takes these three as they are. */
export type SpringToken = { readonly damping: number; readonly stiffness: number; readonly mass: number };

/** Arriving or changing. */
export const STANDARD = { duration: 240, curve: [0.2, 0, 0, 1] as Curve } as const;
/** Leaving: always shorter than arriving. */
export const EXIT = { duration: 160, curve: [0.4, 0, 1, 1] as Curve } as const;
/** Reduce Motion: no movement, the new state fades in over this long (linear). */
export const REDUCED_FADE_MS = 150;

export const SPRINGS = {
  /** The success check only: a small overshoot. */
  settle: { damping: 14, stiffness: 180, mass: 1 },
  /** Layout and the tab pill: no bounce. */
  firm: { damping: 26, stiffness: 300, mass: 1 },
  /** Status dots and key marks. */
  pop: { damping: 12, stiffness: 220, mass: 1 },
  /** The incoming-payment toast. */
  toast: { damping: 16, stiffness: 200, mass: 1 },
  /** The guardian pairing frame. */
  scanFrame: { damping: 20, stiffness: 260, mass: 1 },
  /**
   * Opening the app: the keys landing on Home and the tab bar springing up. It stands in for the board's 600ms overshoot
   * curve, `cubic-bezier(.3, 1.45, .5, 1)`: about 6% past the target at about 400ms, settled by about 650ms.
   */
  land: { damping: 14, stiffness: 112, mass: 1 },
} as const satisfies Record<string, SpringToken>;

export type SpringName = keyof typeof SPRINGS;

/**
 * Springs that must not bounce. Damping 26 at stiffness 300 is a damping ratio of 0.75, which would overshoot by about
 * 3%: the firm spring is clamped at its target so it settles without passing it.
 */
export const NO_BOUNCE: readonly SpringName[] = ['firm'];

/** Waiting only: opacity 1 to 0.35 and back, ease-in-out, for as long as the wait lasts. Small key marks breathe faster. */
export const BREATHE = { from: 1, to: 0.35, periodMs: 2400, smallPeriodMs: 1600 } as const;

/** A ring that leaves a status dot: scale 1 to 2.6 while it fades from 0.55, then rests for the rest of the period. */
export const PULSE_RING = { scaleTo: 2.6, opacityFrom: 0.55, periodMs: 1800, activeShare: 0.7, curve: [0.2, 0, 0.3, 1] as Curve } as const;

/** Status loops stop (WCAG 2.2.2): the "Unconfirmed" dot pulses this many times, then rests still. */
export const STATUS_PULSES = 3;

/** The hardware wallet's waiting ring: one every 2.4s, from the device's outline (scale 1 to 1.12, opacity 0.5 to 0). */
export const DEVICE_RING = { scaleTo: 1.12, opacityFrom: 0.5, periodMs: 2400, activeShare: 0.7, curve: [0.3, 0, 0.3, 1] as Curve } as const;

/** Staged entrances: 50-80ms between items, and at most six items are staggered (the rest arrive with the sixth). */
export const STAGGER = { minMs: 50, maxMs: 80, maxItems: 6 } as const;

/** Buttons shrink a little while pressed, then spring back (firm). List rows dim instead. */
export const PRESS = { scale: 0.96, inMs: 90 } as const;

/** One refusal gesture: a single shake, these offsets (px) over 360ms. */
export const SHAKE = { offsets: [-6, 6, -4, 3, 0] as readonly number[], durationMs: 360 } as const;

/**
 * A number changed as a whole (never digit by digit): the old one lifts and fades, the new one rises into place,
 * starting a little before the old has gone so the place is never empty.
 */
export const NUMBER_SWAP = { outMs: 200, inMs: 280, inDelayMs: 140, lift: 12 } as const;

/** Hide or show the balance, and switch tabs: a plain crossfade, no blur. */
export const CROSSFADE_MS = 160;

/** Section 1, Payment sent: the Sent screen's timeline, in ms from when it opens. */
export const SENT = {
  /** The 72px circle scales 0.6 to 1 (settle spring) and fades in. */
  circleAtMs: 100,
  circleFromScale: 0.6,
  circleFadeMs: 200,
  /** The check draws 140ms after the circle; `success` is felt as it starts. */
  checkAtMs: 240,
  checkDrawMs: 320,
  /** Title, amount line, confirm line, signed-by row, limit card and the buttons rise 8px, 60ms apart, from here. */
  firstItemAtMs: 300,
  itemStepMs: 60,
  itemRise: 8,
  /** The limit card's number changes, and its bar shortens over 600ms, about a second in. */
  limitAtMs: 1000,
  limitBarMs: 600,
} as const;

/** Section 1, Review: the Send button becomes a status strip; the rest dims; on success the content leaves upward. */
export const REVIEW = { dimTo: 0.45, exitLift: 12, linkDrawMs: 200, textSwapMs: 160 } as const;

/** Section 3, Money received: the new row in Recent. */
export const NEW_ROW = { heightDelayMs: 100, heightMs: 280, contentDelayMs: 240, contentMs: 240, drop: 6 } as const;

/** Section 3: the toast drops from above (toast spring) and leaves upward. */
export const TOAST = { fromY: -80, fadeInMs: 120, exitMs: 160 } as const;

/** Section 2: the device's lines appear one after another. */
export const DEVICE_LINES = { stepMs: 80, durationMs: 240, rise: 6 } as const;

/**
 * Section 6, the recovery alert: the red mark scales 0.85 to 1 in 240ms with no bounce (fading in over 160ms), then the
 * heading, the sentence and the details rise 8px, 50ms apart. The two buttons never move. No loop.
 */
export const RECOVERY_ALERT = { markFromScale: 0.85, markMs: 240, markFadeMs: 160, textAtMs: 50, textStepMs: 50, rise: 8 } as const;

/**
 * Section 6, the countdown, in ms from when the screen opens: the ring sweeps from empty to its value once (900ms
 * standard, from 300ms) and then stays still until a new time is read; the time left rises in at 500ms, the sentence
 * under it at 1s, the steps 80ms apart from 1.08s, each done step drawing its check 120ms after it arrives.
 * Cancelled: the ring empties in 400ms.
 */
export const COUNTDOWN = {
  sweepAtMs: 300,
  sweepMs: 900,
  labelAtMs: 500,
  noteAtMs: 1000,
  stepsAtMs: 1080,
  stepMs: 80,
  checkAfterMs: 120,
  checkMs: 240,
  rise: 8,
  emptyMs: 400,
  /** Even at the very start a sliver of the ring shows, so it reads as a ring that fills. */
  minShare: 0.02,
} as const;

/**
 * Section 5, Home's guardian notice. Unlocked: the padlock's shackle opens (240ms), the notice turns from amber to green
 * while it shrinks to one line (280ms) and its words crossfade (160ms); it holds 1.4s, then collapses (280ms). Locking
 * is the reverse: the notice opens (280ms). Its two height changes are the only layout animations here.
 */
export const GUARDIAN_NOTICE = { shackleMs: 240, turnMs: 280, wordsMs: 160, holdMs: 1400, closeMs: 280, openMs: 280, shackleDeg: 28, shackleLift: 2 } as const;

/**
 * Section 4, pairing: once the code is read the corner frame closes onto it (scan-frame spring) to 68% of its side and
 * the camera picture dims to 55%; the status row under it fades in (200ms). Paired: the next step opens 700ms later.
 */
export const PAIRING = { closeTo: 0.68, dimTo: 0.45, statusFadeMs: 200, nextStepMs: 700 } as const;

/**
 * Section 4, "You're all set", in ms from when it opens: the same circle and drawn check as Sent, the title at 200ms,
 * the list's outline at 280ms (200ms fade) and its six rows 70ms apart from 340ms. The buttons are there from the first
 * frame.
 */
export const ALL_SET = { circleFromScale: 0.6, circleFadeMs: 200, checkAtMs: 140, checkDrawMs: 320, titleAtMs: 200, listAtMs: 280, listFadeMs: 200, firstRowAtMs: 340, rowStepMs: 70, rise: 8 } as const;

/**
 * Section 8, the Security tab's entrance (about 1.8s), in ms from when the tab shows: the banner fades in (240ms); the
 * hardware mark pops at 150ms; the links draw for 450ms from 450ms; the phone mark at 700ms; the guardian mark at
 * 900ms; the check draws at 1.35s; one soft ring spreads from the centre at 1.45s. When something needs the person, its
 * dashed links fade in at 900ms (300ms) and the alert mark at 1.3s (200ms) instead of the check and the ring. The tiles
 * rise 8px, 50ms apart, and their dots pop from 300ms, 60ms apart.
 */
export const SECURITY_ENTRANCE = {
  bannerFadeMs: 240,
  markAtMs: { hardware: 150, phone: 700, guardian: 900 },
  linksAtMs: 450,
  linksMs: 450,
  checkAtMs: 1350,
  checkMs: 320,
  haloAtMs: 1450,
  haloMs: 700,
  dashedAtMs: 900,
  dashedMs: 300,
  alertAtMs: 1300,
  alertMs: 200,
  tileStepMs: 50,
  tileRise: 8,
  dotsAtMs: 300,
  dotStepMs: 60,
} as const;

/**
 * Section 8, "not set" to "all set" (about 1.2s, haptic `success`), in ms from the change: a green ring draws clockwise
 * round the fixed key (500ms), whose own ring turns green as it closes; the banner's colour crossfades from amber to
 * green from 200ms (500ms); the dashed links fade from 300ms (250ms); the solid links draw from 350ms (400ms); the old
 * text lifts out at 450ms and the new rises in at 540ms (the banner is never empty); the alert mark fades at 550ms
 * (150ms); the check draws at 750ms, with `success`; one soft ring spreads from the centre at 850ms (800ms). On the
 * tile, the dot turns green with a bump from 100ms (its colour over 300ms) and the value line crossfades.
 */
export const SECURITY_FIX = {
  ringMs: 500,
  markOkAtMs: 500,
  colourAtMs: 200,
  colourMs: 500,
  dashedOutAtMs: 300,
  dashedOutMs: 250,
  linksAtMs: 350,
  linksMs: 400,
  textOutAtMs: 450,
  textInAtMs: 540,
  alertOutAtMs: 550,
  alertOutMs: 150,
  checkAtMs: 750,
  checkMs: 320,
  haloAtMs: 850,
  haloMs: 800,
  tileAtMs: 100,
  tileColourMs: 300,
} as const;

/** The soft ring from the banner mark's centre: scale 0.6 to 2.4 while it fades from 0.4. */
export const SECURITY_HALO = { fromScale: 0.6, toScale: 2.4, opacityFrom: 0.4 } as const;

/** The banner's links: solid ones at half strength, dashed (amber) ones at 0.8. The old text lifts 5px. */
export const SECURITY_LINKS = { solidOpacity: 0.5, dashedOpacity: 0.8, textLift: 5 } as const;

/** The guardian tile's dot while it is being asked: a ring every 1.2s, for as long as it lasts. */
export const SYNC_RING = { ...PULSE_RING, periodMs: 1200 } as const;

/** A status dot or key mark that changes: it grows to 1.25 (200ms) and springs back (pop). */
export const BUMP = { scale: 1.25, upMs: 200 } as const;

/** Section 8: when the `index`-th tile rises and when its dot pops (the stagger rule's cap of six applies to both). */
export function securityTileTimes(index: number): { riseAt: number; dotAt: number } {
  return {
    riseAt: staggerDelay(index, SECURITY_ENTRANCE.tileStepMs),
    dotAt: staggerDelay(index, SECURITY_ENTRANCE.dotStepMs, SECURITY_ENTRANCE.dotsAtMs),
  };
}

/**
 * The countdown ring's `strokeDashoffset` for a share of the waiting period that has passed: the whole circumference is
 * an empty ring, 0 a full one. The share is held between `COUNTDOWN.minShare` and 1.
 */
export function ringOffset(share: number, circumference: number): number {
  const s = Number.isFinite(share) ? Math.min(Math.max(share, COUNTDOWN.minShare), 1) : COUNTDOWN.minShare;
  return circumference * (1 - s);
}

/** What Home's guardian notice shows: the guardian locked or offline, "Guardian unlocked" for a moment, or nothing. */
export type GuardianNoticeLook = 'locked' | 'offline' | 'unlocked' | null;
type GuardianStatusLike = 'online' | 'locked' | 'offline';

/**
 * How Home's guardian notice changes when the guardian's status does (section 5).
 * - `open`: it was online and is now locked or offline: the notice opens (280ms). No haptic: the wallet state does not
 *   say whether this phone locked it.
 * - `unlocked`: locked, now online: the shackle opens, the notice turns green and says "Guardian unlocked", `success`
 *   is felt, and it collapses 1.4s later.
 * - `close`: offline, now online: the notice collapses at once (no padlock, no haptic).
 * - `swap`: locked and offline trade places: the words change in place.
 * - `none`: no change.
 */
export type GuardianNoticeMove = { kind: 'none' | 'open' | 'unlocked' | 'close' | 'swap'; haptic?: 'success' };

export function guardianNoticeMove(from: GuardianStatusLike, to: GuardianStatusLike): GuardianNoticeMove {
  if (from === to) return { kind: 'none' };
  if (from === 'online') return { kind: 'open' };
  if (to === 'online') return from === 'locked' ? { kind: 'unlocked', haptic: 'success' } : { kind: 'close' };
  return { kind: 'swap' };
}

/**
 * When the `index`-th item of a staged entrance starts: `start` plus one step per item, the step held within 50-80ms
 * and items past the sixth arriving with the sixth.
 */
export function staggerDelay(index: number, stepMs: number = STAGGER.minMs, start = 0): number {
  const step = Math.min(STAGGER.maxMs, Math.max(STAGGER.minMs, stepMs));
  const slot = Math.min(Math.max(0, Math.floor(index)), STAGGER.maxItems - 1);
  return start + slot * step;
}

/** The shake as (offset, duration) steps: the five offsets share the 360ms evenly. */
export function shakeSteps(): { to: number; ms: number }[] {
  const ms = SHAKE.durationMs / SHAKE.offsets.length;
  return SHAKE.offsets.map((to) => ({ to, ms }));
}

/** How a loop repeats: activity loops (waiting, signing) run for as long as the wait lasts; status loops stop. */
export type LoopKind = 'activity' | 'status';

/** How many times a loop plays: `-1` is Reanimated's "until stopped". With Reduce Motion, none. */
export function loopRepeats(kind: LoopKind, reduced: boolean): number {
  if (reduced) return 0;
  return kind === 'activity' ? -1 : STATUS_PULSES;
}

/**
 * What a state change looks like. With Reduce Motion on: no movement at all, a 150ms linear opacity fade, no delay.
 * Otherwise the token's own duration, curve, distance and delay.
 */
export type MotionPlan = { duration: number; curve: Curve | 'linear'; distance: number; delay: number };

export function motionPlan(reduced: boolean, token: { duration: number; curve: Curve }, distance = 0, delay = 0): MotionPlan {
  if (reduced) return { duration: REDUCED_FADE_MS, curve: 'linear', distance: 0, delay: 0 };
  return { duration: token.duration, curve: token.curve, distance, delay };
}

/** The limit bar's fill, 0 to 1: what is left of today's limit. */
export function limitShare(leftSats: number, limitSats: number): number {
  if (!(limitSats > 0)) return 0;
  return Math.min(1, Math.max(0, leftSats / limitSats));
}

/**
 * Section 9, opening the app (board `Open.dc.html`, about 2s). Three stages, each with its own clock:
 *
 * - Booting, from when the app-drawn logo is on screen: still at first; if the app is not ready `loopAfterMs` later, an
 *   orange dash runs round the triangle (a lap in 1.4s, linear) and each key swells to 1.24 and sends out a ring as the
 *   dash passes it. A fast boot never starts the loop.
 * - Ready (`readyMs`), from when the wallet is open: one last lap in 480ms, the keys answer as it passes them (160ms
 *   apart), and the triangle's lines retract (300ms from 460ms).
 * - Landing, from when Home's places are measured: the backdrop fades (200ms) while the keys fly to Home (560ms, x and
 *   y on their own curves, so the path bends), the two dark keys grow into Send and Receive and the orange key shrinks
 *   to the limit line's dot; the real ones take over at 580ms. Home fills in on the same clock.
 *
 * The board's overshoot curves are the `land` spring here. Times are ms from the start of their stage.
 */
export const OPENING = {
  /** Booting: the loop starts only if the app is still not ready this long after the logo is drawn. */
  loopAfterMs: 400,
  lapMs: 1400,
  /** As the dash passes a key (shares of a lap, linear between): it swells to 1.24 by 8% and is back by 24%... */
  swell: { scale: 1.24, peakAt: 0.08, endAt: 0.24 },
  /** ...and its ring grows to 2.1 while fading from 0.55, by 36%. */
  swellRing: { scaleTo: 2.1, opacityFrom: 0.55, endAt: 0.36 },
  /** The dash's length, as a share of the triangle's outline (the board's 26 of 167.2). */
  dashShare: 26 / 167.2,

  /** Ready: one last lap, fading over its last 10%. */
  lastLapMs: 480,
  lastLapFadeFrom: 0.9,
  /**
   * Each key answers as the last lap passes it: it grows to 1.28 by 40% of 320ms and comes back (standard curve each
   * way), and sends a ring to 2.3 from 0.6 opacity in 500ms (standard).
   */
  answer: { scale: 1.28, peakShare: 0.4, ms: 320, ringScaleTo: 2.3, ringOpacityFrom: 0.6, ringMs: 500 },
  /** The triangle's lines retract. */
  retractAtMs: 460,
  retractMs: 300,
  /** The ready stage's length: the landing starts after it (once Home's places are measured). */
  readyMs: 780,
  /** How long the landing waits for Home's places to be measured; a place not measured by then is missing. */
  measureWaitMs: 120,
  /** Home not drawn yet when the ready stage ends (no place registered): the landing waits this long at most for it. */
  homeWaitMs: 300,

  /** Landing: the overlay's backdrop fades (linear), uncovering Home. */
  backdropFadeMs: 200,
  /** The keys fly for 560ms: x on one curve, y on another, so the path bends. */
  flyMs: 560,
  xCurve: [0.3, 0, 0.2, 1] as Curve,
  yCurve: [0.55, 0, 0.15, 1] as Curve,
  /** Each key's start: the orange key (to the limit line's dot), the left key (to Send), the right key (to Receive). */
  keyDelayMs: { hardware: 0, phone: 0, guardian: 60 },
  /** Each key's colour turns to its place's (400ms, linear) from here... */
  colourAtMs: { hardware: 100, phone: 100, guardian: 160 },
  colourMs: 400,
  /** ...and it fades out (120ms, linear) as the real one takes over. */
  handOverAtMs: { hardware: 580, phone: 580, guardian: 640 },
  handOverMs: 120,
  /** A key with no place on screen fades where it is. */
  missingFadeMs: 200,

  /** Home fills in. The balance rises 18px (fade 400ms, rise 500ms, standard), the line under it 80ms later. */
  balanceAtMs: 300,
  balanceLineAtMs: 380,
  balanceFadeMs: 400,
  balanceRiseMs: 500,
  balanceRise: 18,
  /** The limit line's dot shows as the orange key arrives; its sentence is revealed from the dot, left to right. */
  dotAtMs: 560,
  dotFadeMs: 100,
  revealAtMs: 620,
  revealMs: 450,
  /** Send, then Receive: the circle and its arrow show at 1.1 and settle to 1 (standard); the labels follow. */
  buttonAtMs: [560, 620] as readonly number[],
  buttonFadeMs: 100,
  buttonLandAtMs: [580, 640] as readonly number[],
  buttonLandMs: 400,
  buttonLandFrom: 1.1,
  labelsAtMs: 700,
  labelsFadeMs: 240,
  /** Recent: its heading, then its rows, 80ms apart; each rises 14px (320ms, standard). */
  recentAtMs: 740,
  recentStepMs: 80,
  recentMs: 320,
  recentRise: 14,
  /** The tab bar springs up from 70px below (land spring) while it fades in (200ms, linear). */
  tabBarAtMs: 660,
  tabBarFadeMs: 200,
  tabBarFrom: 70,
  /** The landing's clock runs this long: the last Recent row and the tab bar are in place by then. */
  landingMs: 1400,
  /** Whatever happens, everything is in place and the overlay gone this long after the app is ready. */
  maxMs: 2800,
  /** Reduce Motion: the logo fades once Home is there, waiting this long at most for it after the app is ready. */
  reducedWaitMs: 700,
} as const;
