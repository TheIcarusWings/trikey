/**
 * Opening the app (docs/design/motion.md, section 9). The native splash (app.json, unchanged) hides over an identical
 * logo drawn here: an SVG triangle and three plain views as the keys. While the wallet opens, an orange dash runs round
 * the triangle; once it is open, the keys answer one last lap, the lines retract, and the keys fly to Home: the two dark
 * ones grow into Send and Receive, the orange one shrinks to the limit line's dot. Home fills in on the same clock.
 *
 * The rules it keeps:
 * - The overlay never takes a touch and is hidden from screen readers: Home works under it from its first frame.
 * - Only opacity, transform, colour and `strokeDashoffset` move, on the UI thread, read off two clocks (the pure frame
 *   functions are in src/lib/opening.ts).
 * - It plays once per start of the app: not on a return from the background, not after a wallet mode switch.
 * - Reduce Motion: nothing moves; the logo fades out over Home (150ms) once the app is ready.
 * - Whatever goes wrong (a place not measured, an error), it falls back to a fade and Home is in place; the overlay is
 *   gone at most `OPENING.maxMs` after the app is ready.
 */
import { useIsFocused } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Component, useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { AppState, Appearance, Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolateColor,
  makeMutable,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { HIDDEN, reducedFade, useReduceMotion } from '@/components/motion';
import {
  CLOCK_DONE,
  CLOCK_WAITING,
  NO_LANDING,
  OPENING_KEYS,
  SPLASH_MARK,
  TRIANGLE,
  backdropOpacity,
  dashAt,
  dashOffset,
  finishesOnAppState,
  homePart,
  keyLanding,
  keyPulse,
  landingPlan,
  openingDeadline,
  openingMode,
  opensWithAnimation,
  retractAt,
  revealShare,
  splashColors,
  splashLayout,
  type HomePart,
  type KeyPlan,
  type LandingTarget,
  type OpeningKey,
  type Rect,
  type SplashLayout,
} from '@/lib/opening';
import { OPENING, REDUCED_FADE_MS } from '@/theme/motion';

// ---------------------------------------------------------------- shared with Home

/**
 * The landing's clock, read by the overlay and by Home's parts (ms since the landing started). It reads `CLOCK_DONE`
 * unless an opening is under way, so a part drawn at any other time is simply in place.
 */
export const landingClock = makeMutable(CLOCK_DONE);

/** This run's opening: not decided yet, playing, or over (played, skipped, or given up). */
let run: 'undecided' | 'playing' | 'over' = 'undecided';

function decide(): boolean {
  if (run === 'undecided') {
    const play = opensWithAnimation({ os: Platform.OS, appState: AppState.currentState, played: false });
    run = play ? 'playing' : 'over';
    if (play) landingClock.value = CLOCK_WAITING;
  }
  return run === 'playing';
}

/** Everything in place at once: Home's parts at rest, and no opening again in this run. */
function settle() {
  run = 'over';
  cancelAnimation(landingClock);
  landingClock.value = CLOCK_DONE;
}

let splashHidden = false;
/** Hides the native splash, once. Safe to call again, and whatever the native side answers. */
export function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  SplashScreen.hideAsync().catch(() => {});
}

type ViewRef = ComponentRef<typeof View>;

/** Home's places the keys can land on, while Home is on screen. The last one registered for a key wins. */
const places = new Map<OpeningKey, { ref: RefObject<ViewRef | null>; color: string }>();

/**
 * Makes a view a place a key can land on: `phone` on Send's circle, `guardian` on Receive's, `hardware` on the limit
 * line's dot. Only while `enabled` and its screen is on top. Put the ref on a plain view with the place's frame (no
 * transform of its own). `color` is what the key turns into.
 */
export function useLandingPlace(key: OpeningKey, color: string, enabled = true): RefObject<ViewRef | null> {
  const ref = useRef<ViewRef | null>(null);
  const focused = useIsFocused();
  useEffect(() => {
    if (!enabled || !focused) return;
    const entry = { ref, color };
    places.set(key, entry);
    return () => {
      if (places.get(key) === entry) places.delete(key);
    };
  }, [key, color, enabled, focused]);
  return ref;
}

/** A view's frame in the window, or null if it cannot be read. */
function measure(view: ViewRef | null | undefined): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!view || typeof view.measureInWindow !== 'function') return resolve(null);
    try {
      view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
    } catch {
      resolve(null);
    }
  });
}

/** A view's frame in the window, or null if it is not read within `measureWaitMs`. */
function measureSoon(view: ViewRef | null | undefined): Promise<Rect | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), OPENING.measureWaitMs));
  return Promise.race([measure(view), timeout]);
}

/** Every place registered now, measured; a place not measured in time is missing. */
async function measurePlaces(): Promise<Partial<Record<OpeningKey, LandingTarget | null>>> {
  const entries = [...places.entries()];
  const measured = await Promise.all(entries.map(([, p]) => measureSoon(p.ref.current)));
  const out: Partial<Record<OpeningKey, LandingTarget | null>> = {};
  entries.forEach(([key, p], i) => {
    const rect = measured[i];
    out[key] = rect ? { rect, color: p.color } : null;
  });
  return out;
}

/** One part of Home on the landing's clock (see `homePart`): in place whenever no opening is under way. */
export function useOpeningPart(part: HomePart, index = 0) {
  return useAnimatedStyle(() => {
    const p = homePart(part, landingClock.value, index);
    return { opacity: p.opacity, transform: [{ translateY: p.translateY }, { scale: p.scale }] };
  });
}

/** A part of Home that fills in during the opening. `play={false}`: a plain view (the same component used elsewhere). */
export function OpeningPart({ part, index = 0, play = true, style, children }: { part: HomePart; index?: number; play?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  if (!play) return <View style={style}>{children}</View>;
  return (
    <OpeningPartView part={part} index={index} style={style}>
      {children}
    </OpeningPartView>
  );
}

function OpeningPartView({ part, index, style, children }: { part: HomePart; index: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const animated = useOpeningPart(part, index);
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/**
 * The limit line's sentence, revealed from its dot, left to right, during the opening: the view's window slides open
 * over the words while the words stay still (two opposite translations, one clipping). Before its width is known it
 * stays hidden; once the opening is over it is simply there. `play={false}`: just the children.
 */
export function OpeningReveal({ play = true, children }: { play?: boolean; children: ReactNode }) {
  if (!play) return <>{children}</>;
  return <Reveal>{children}</Reveal>;
}

function Reveal({ children }: { children: ReactNode }) {
  const width = useSharedValue(0);
  const window = useAnimatedStyle(() => {
    const s = revealShare(landingClock.value);
    return { opacity: s >= 1 || width.value > 0 ? 1 : 0, transform: [{ translateX: -(1 - s) * width.value }] };
  });
  const words = useAnimatedStyle(() => ({ transform: [{ translateX: (1 - revealShare(landingClock.value)) * width.value }] }));
  return (
    <Animated.View style={[{ overflow: 'hidden', flexShrink: 1 }, window]} onLayout={(e: LayoutChangeEvent) => (width.value = e.nativeEvent.layout.width)}>
      <Animated.View style={words}>{children}</Animated.View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------- the overlay

/**
 * The opening, over everything. Render it once, last, at the root, from the app's first render (before fonts and the
 * wallet): it hides the native splash once its own logo is on screen. `ready`: the wallet is open (or failed to) and
 * the fonts are in. When the opening does not play this run, it only hides the splash once ready.
 */
export function OpeningOverlay({ ready }: { ready: boolean }) {
  const [play] = useState(decide);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready && (!play || failed)) hideSplash();
  }, [ready, play, failed]);
  const onError = useCallback(() => {
    settle();
    hideSplash();
    setFailed(true);
  }, []);
  if (!play) return null;
  if (failed) return <FallbackFade />;
  return (
    <OpeningBoundary onError={onError}>
      <Overlay ready={ready} />
    </OpeningBoundary>
  );
}

/** Anything thrown while drawing the opening: Home in place, the splash hidden, and the simple fade instead. */
class OpeningBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The fallback: the splash's background, plain, fading out over Home (150ms), then nothing. Never takes a touch. */
function FallbackFade() {
  const [backdrop] = useState(() => splashColors(Appearance.getColorScheme() === 'dark' ? 'dark' : 'light').backdrop);
  const [gone, setGone] = useState(false);
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = reducedFade(0);
    const t = setTimeout(() => setGone(true), REDUCED_FADE_MS + 50);
    return () => clearTimeout(t);
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  if (gone) return null;
  return <Animated.View {...HIDDEN} style={[StyleSheet.absoluteFill, { zIndex: 1000, backgroundColor: backdrop }, style]} />;
}

const AnimatedPath = Animated.createAnimatedComponent(Path);
/** Long enough for any boot: the booting clock runs at 1ms per ms until the overlay goes. */
const BOOT_CLOCK_MS = 60 * 60 * 1000;

type Stage = 'boot' | 'ready' | 'landing' | 'gone';

function Overlay({ ready }: { ready: boolean }) {
  const reduced = useReduceMotion();
  const mode = openingMode(reduced);
  // The native splash follows the system's appearance, not the app's setting: so does its copy. Read once, before the
  // app applies its own setting.
  const [colors] = useState(() => splashColors(Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'));
  const [layout, setLayout] = useState<{ width: number; height: number; logo: SplashLayout } | null>(null);
  const [stage, setStage] = useState<Stage>('boot');
  // The booting clock (ms since the logo was drawn), the moment the app was ready on it, and where the keys land.
  const t = useSharedValue(0);
  const readyFlag = useSharedValue(0);
  const readyAt = useSharedValue(-1);
  const plan = useSharedValue<Record<OpeningKey, KeyPlan>>(NO_LANDING);
  // 1 once this overlay's landing has started: until then its keys and backdrop stay as they are, whatever the shared
  // clock says (Reduce Motion's fade puts Home in place while the logo is still whole).
  const landed = useSharedValue(0);
  // The whole overlay's opacity: Reduce Motion's fade.
  const shown = useSharedValue(1);
  const root = useRef<ViewRef>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const started = useRef(false);
  const later = useCallback((ms: number, fn: () => void) => void timers.current.push(setTimeout(fn, ms)), []);

  // The moment the app was ready, on the booting clock, taken on the UI thread so the last lap starts where the dash is.
  useAnimatedReaction(
    () => readyFlag.value,
    (r, prev) => {
      if (r === 1 && prev !== 1 && readyAt.value < 0) readyAt.value = t.value;
    },
  );

  /** Gone at once: Home in place (the app left the front, or the deadline passed). */
  const finish = useCallback(() => {
    settle();
    hideSplash();
    setStage('gone');
  }, []);

  /**
   * Reduce Motion's fade: once Home is there (its places registered, or `reducedWaitMs` at most), Home goes in place
   * under the logo, which fades out as it is (150ms), then goes.
   */
  const fadeOut = useCallback(() => {
    hideSplash();
    const since = Date.now();
    const fade = () => {
      settle();
      shown.value = reducedFade(0);
      later(REDUCED_FADE_MS + 50, () => setStage('gone'));
    };
    const wait = () => (places.size > 0 || Date.now() - since >= OPENING.reducedWaitMs ? fade() : later(50, wait));
    wait();
  }, [shown, later]);

  const land = useCallback(async () => {
    let next: Record<OpeningKey, KeyPlan> = NO_LANDING;
    try {
      // Home not drawn yet (no place registered): wait a little for it; another screen simply never registers one.
      const since = Date.now();
      const pause = () => new Promise((r) => setTimeout(r, 50));
      while (places.size === 0 && Date.now() - since < OPENING.homeWaitMs && run === 'playing') await pause();
      // Just registered: let it be laid out before it is measured.
      if (Date.now() > since + 1) await pause();
      const [targets, origin] = await Promise.all([measurePlaces(), measureSoon(root.current)]);
      if (layout) next = landingPlan(layout.logo, layout, targets, origin ?? { x: 0, y: 0 });
    } catch {
      next = NO_LANDING;
    }
    if (run !== 'playing') return;
    plan.value = next;
    landed.value = 1;
    landingClock.value = 0;
    landingClock.value = withTiming(OPENING.landingMs, { duration: OPENING.landingMs, easing: Easing.linear });
    setStage('landing');
    // The keys have handed over (or faded) by then: the overlay goes; Home's parts finish on the clock.
    const keysGone = Math.max(OPENING.handOverAtMs.guardian + OPENING.handOverMs, OPENING.missingFadeMs, OPENING.backdropFadeMs);
    later(keysGone + 40, () => setStage('gone'));
    later(OPENING.landingMs + 40, settle);
  }, [layout, plan, landed, later]);

  // The logo is on screen: hide the native splash over it (a frame later, so this one has been drawn), and start the
  // booting clock (it drives the loop, if the boot is slow enough to need one).
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (layout && layout.width === width && layout.height === height) return;
    setLayout({ width, height, logo: splashLayout(width, height) });
    if (started.current) return;
    started.current = true;
    requestAnimationFrame(() => hideSplash());
    if (mode === 'full') t.value = withTiming(BOOT_CLOCK_MS, { duration: BOOT_CLOCK_MS, easing: Easing.linear });
  };

  // Ready (and drawn): the last lap and the landing, or Reduce Motion's fade. Whatever happens, gone by the deadline.
  const go = ready && layout !== null;
  useEffect(() => {
    if (!go || stage !== 'boot') return;
    setStage('ready');
    later(openingDeadline(mode), finish);
    if (mode === 'fade') {
      fadeOut();
      return;
    }
    readyFlag.value = 1;
    later(OPENING.readyMs, () => void land());
  }, [go, stage, mode, readyFlag, later, finish, fadeOut, land]);

  // Leaving the front during the opening: everything in place now, so nothing plays on the way back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (finishesOnAppState(s)) finish();
    });
    return () => sub.remove();
  }, [finish]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      cancelAnimation(t);
      // Never leave Home waiting for an opening that is no longer drawn.
      if (run === 'playing') settle();
    },
    [t],
  );

  const backdrop = useAnimatedStyle(() => ({ opacity: landed.value ? backdropOpacity(landingClock.value) : 1 }));
  const whole = useAnimatedStyle(() => ({ opacity: shown.value }));
  const perimeter = TRIANGLE.perimeter;
  const dashLength = perimeter * OPENING.dashShare;
  const lines = useAnimatedProps(() => ({ strokeDashoffset: perimeter * retractAt({ t: t.value, readyAt: readyAt.value }) }));
  const dash = useAnimatedProps(() => {
    const d = dashAt({ t: t.value, readyAt: readyAt.value });
    return { strokeDashoffset: dashOffset(d.phase, perimeter), strokeOpacity: d.opacity };
  });

  if (stage === 'gone') return null;
  const logo = layout?.logo;
  return (
    <Animated.View onLayout={onLayout} {...HIDDEN} style={[StyleSheet.absoluteFill, { zIndex: 1000 }, whole]}>
      {/* Where the overlay is in the window: Home's places are measured there too. */}
      <View ref={root} collapsable={false} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, backdrop]} />
      {logo ? (
        <>
          <Svg width={logo.size} height={logo.size} viewBox={`0 0 ${SPLASH_MARK.units} ${SPLASH_MARK.units}`} style={{ position: 'absolute', left: logo.left, top: logo.top }}>
            <AnimatedPath d={TRIANGLE.path} fill="none" stroke={colors.ink} strokeWidth={SPLASH_MARK.stroke} strokeLinejoin="round" strokeDasharray={[perimeter, perimeter]} animatedProps={lines} />
            <AnimatedPath
              d={TRIANGLE.path}
              fill="none"
              stroke={colors.brand}
              strokeWidth={SPLASH_MARK.stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={[dashLength, perimeter - dashLength]}
              strokeOpacity={0}
              animatedProps={dash}
            />
          </Svg>
          {OPENING_KEYS.map((k) => (
            <Key key={k} name={k} logo={logo} color={k === 'hardware' ? colors.brand : colors.ink} t={t} readyAt={readyAt} plan={plan} landed={landed} />
          ))}
        </>
      ) : null}
    </Animated.View>
  );
}

/** One key: a plain disc (and the ring it sends out), where the native splash draws it. */
function Key({
  name,
  logo,
  color,
  t,
  readyAt,
  plan,
  landed,
}: {
  name: OpeningKey;
  logo: SplashLayout;
  color: string;
  t: SharedValue<number>;
  readyAt: SharedValue<number>;
  plan: SharedValue<Record<OpeningKey, KeyPlan>>;
  landed: SharedValue<number>;
}) {
  const d = logo.keyDiameter;
  const at = logo.keys[name];
  const box: ViewStyle = { position: 'absolute', left: at.x - d / 2, top: at.y - d / 2, width: d, height: d, borderRadius: d / 2 };
  const disc = useAnimatedStyle(() => {
    const l = landed.value ? landingClock.value : CLOCK_WAITING;
    if (l >= 0) {
      const p = plan.value[name];
      const k = keyLanding(name, l, p);
      return {
        opacity: k.opacity,
        backgroundColor: p.fly ? interpolateColor(k.mix, [0, 1], [color, p.color]) : color,
        transform: [{ translateX: k.dx }, { translateY: k.dy }, { scale: k.scale }],
      };
    }
    const p = keyPulse(name, { t: t.value, readyAt: readyAt.value });
    return { opacity: 1, backgroundColor: color, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: p.scale }] };
  });
  const ring = useAnimatedStyle(() => {
    if (landed.value && landingClock.value >= 0) return { opacity: 0, transform: [{ scale: 1 }] };
    const p = keyPulse(name, { t: t.value, readyAt: readyAt.value });
    return { opacity: p.ringOpacity, transform: [{ scale: p.ringScale }] };
  });
  return (
    <>
      <Animated.View style={[box, { backgroundColor: color }, ring]} />
      <Animated.View style={[box, disc]} />
    </>
  );
}
