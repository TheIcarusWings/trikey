/**
 * The app's few moving parts (docs/design/motion.md), built on the tokens in src/theme/motion.ts. Everything here moves
 * only opacity, transform and colour (and one SVG stroke), runs on the UI thread through Reanimated, and picks up a
 * change of state mid-flight. With Reduce Motion on, nothing moves: states swap with a 150ms opacity fade.
 *
 * Animated views here take `style` only, never `className`: NativeWind would flatten an animated style. Classes go on
 * a plain view inside.
 */
import type { LucideIcon } from 'lucide-react-native';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { HardwareWallet, Shield, Smartphone } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { KeyMark, KeyName } from '@/lib/payment-texts';
import { cn } from '@/lib/utils';
import {
  BREATHE,
  BUMP,
  CROSSFADE_MS,
  EXIT,
  NO_BOUNCE,
  NUMBER_SWAP,
  PRESS,
  PULSE_RING,
  REDUCED_FADE_MS,
  SPRINGS,
  STANDARD,
  loopRepeats,
  shakeSteps,
  type Curve,
  type LoopKind,
  type SpringName,
} from '@/theme/motion';
import { useTheme } from '@/theme/use-theme';

// ---------------------------------------------------------------- timing helpers

const bezier = (c: Curve) => Easing.bezier(c[0], c[1], c[2], c[3]);
const STANDARD_EASING = bezier(STANDARD.curve);
const EXIT_EASING = bezier(EXIT.curve);

/** Arriving or changing: 240ms, standard curve (or `ms`). */
export function standard(to: number, ms: number = STANDARD.duration) {
  return withTiming(to, { duration: ms, easing: STANDARD_EASING });
}

/** Leaving: 160ms, exit curve (or `ms`). */
export function exit(to: number, ms: number = EXIT.duration) {
  return withTiming(to, { duration: ms, easing: EXIT_EASING });
}

/** One of the named springs (the settle, toast and pop springs overshoot a little; firm does not). */
export function spring(to: number, name: SpringName) {
  return withSpring(to, { ...SPRINGS[name], overshootClamping: NO_BOUNCE.includes(name) });
}

/**
 * A status dot or key mark that changed: it grows to 1.25 (200ms) and springs back with the pop spring (a small
 * overshoot). Assign to a scale. Reduce Motion: none (the colour and the words say it).
 */
export function bump() {
  return withSequence(withTiming(BUMP.scale, { duration: BUMP.upMs, easing: STANDARD_EASING }), spring(1, 'pop'));
}

/** Reduce Motion's one gesture: a 150ms linear opacity fade, played even though the system asks for less motion. */
export function reducedFade(to: number) {
  return withTiming(to, { duration: REDUCED_FADE_MS, easing: Easing.linear, reduceMotion: ReduceMotion.Never });
}

/** Plain linear fade (crossfades of text and of the hidden balance). */
export function fade(to: number, ms: number = CROSSFADE_MS) {
  return withTiming(to, { duration: ms, easing: Easing.linear });
}

/**
 * Reduce Motion, from Reanimated (the system setting when the app started). Every piece below asks it: when it is on,
 * no piece moves, and a state change is a 150ms fade.
 */
export function useReduceMotion(): boolean {
  return useReducedMotion();
}

/** Hidden from screen readers and touches: a layer on its way out, or not shown. */
export const HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const, pointerEvents: 'none' as const };

/**
 * Says a change out loud to a screen reader. `polite` waits for what is being read; `assertive` interrupts it (only the
 * recovery alert). For a change that has no element of its own to be a live region; never moves focus. Nothing on the web.
 */
export function announce(text: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if (Platform.OS === 'ios' && AccessibilityInfo.announceForAccessibilityWithOptions) {
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: politeness === 'polite' });
    return;
  }
  AccessibilityInfo.announceForAccessibility(text);
}

// ---------------------------------------------------------------- entrances

/**
 * Arrives once, when it mounts: fades in while rising `distance` px, `delay` ms after mount. Reduce Motion: a 150ms
 * fade with no delay and no rise. `play={false}`: in place from the first frame (the same view, so a screen can choose
 * per mount without remounting what is inside).
 */
export function Rise({
  children,
  delay = 0,
  distance = 8,
  duration = STANDARD.duration,
  play = true,
  style,
}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  duration?: number;
  play?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReduceMotion();
  const o = useSharedValue(play ? 0 : 1);
  const y = useSharedValue(reduced || !play ? 0 : distance);
  useEffect(() => {
    if (!play) return;
    if (reduced) {
      o.value = reducedFade(1);
      return;
    }
    o.value = withDelay(delay, standard(1, duration));
    y.value = withDelay(delay, standard(0, duration));
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const animated = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/**
 * Shown or not, by opacity only (the layer stays in place). `dim` is the opacity when not shown (0 hides it from
 * screen readers and touches too). Used for crossfades: two layers, one `shown`.
 */
export function FadeLayer({
  shown,
  children,
  dim = 0,
  ms = CROSSFADE_MS,
  style,
}: {
  shown: boolean;
  children: ReactNode;
  dim?: number;
  ms?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReduceMotion();
  const o = useSharedValue(shown ? 1 : dim);
  useEffect(() => {
    o.value = reduced ? reducedFade(shown ? 1 : dim) : withTiming(shown ? 1 : dim, { duration: ms, easing: shown ? STANDARD_EASING : EXIT_EASING });
  }, [shown, dim, ms, reduced, o]);
  const animated = useAnimatedStyle(() => ({ opacity: o.value }));
  const hidden = !shown && dim === 0;
  return (
    <Animated.View style={[style, animated]} {...(hidden ? HIDDEN : {})}>
      {children}
    </Animated.View>
  );
}

/**
 * A screen's content leaving before the next screen replaces it: `leave(then)` fades it while it lifts `lift` px
 * (160ms, exit curve), then calls `then`. Reduce Motion: a 150ms fade, no lift.
 */
export function useLeave(lift = 12): { style: ReturnType<typeof useAnimatedStyle>; leave: (then: () => void) => void } {
  const reduced = useReduceMotion();
  const o = useSharedValue(1);
  const y = useSharedValue(0);
  const leave = useCallback(
    (then: () => void) => {
      if (reduced) o.value = reducedFade(0);
      else {
        o.value = exit(0);
        y.value = exit(-lift);
      }
      setTimeout(then, reduced ? REDUCED_FADE_MS : EXIT.duration);
    },
    [reduced, lift, o, y],
  );
  const style = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));
  return { style, leave };
}

// ---------------------------------------------------------------- one thing replaced by another

type SwapKind = 'fade' | 'lift';

/**
 * Shows `children`; when `id` changes, the old content leaves and the new arrives in its place, so the place is never
 * empty. `fade`: a plain 160ms crossfade (status text). `lift`: a whole number changing: the old one lifts `lift` px
 * and fades (200ms), the new one rises into place (280ms) `inDelay` ms after (140ms unless given). `animate={false}`
 * swaps at once (the hidden balance). A change while one is under way starts from where things are.
 */
export function Swap({
  id,
  children,
  kind = 'fade',
  lift = NUMBER_SWAP.lift,
  animate = true,
  align = 'center',
  inDelay = NUMBER_SWAP.inDelayMs,
  style,
}: {
  id: string;
  children: ReactNode;
  kind?: SwapKind;
  lift?: number;
  animate?: boolean;
  inDelay?: number;
  /** Where the leaving layer sits over the new one: centred or from the start (with room to be wider), or `fill`: the same width. */
  align?: 'center' | 'start' | 'fill';
  style?: StyleProp<ViewStyle>;
}) {
  const [shown, setShown] = useState<{ id: string; fresh: boolean }>({ id, fresh: false });
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode }[]>([]);
  // What the shown layer drew last time: it is what leaves when the id changes.
  const last = useRef<ReactNode>(children);
  if (shown.id !== id) {
    // Derived from the previous render, as React allows: the shown layer starts leaving, the new one arrives. At most
    // two layers leave at once; an older one simply goes.
    const prev = { key: `${shown.id}>${id}`, node: last.current };
    setLeaving((ls) => (animate ? [...ls.filter((l) => l.key !== prev.key).slice(-1), prev] : []));
    setShown({ id, fresh: animate });
  }
  last.current = children;
  const drop = useCallback((key: string) => setLeaving((ls) => ls.filter((l) => l.key !== key)), []);
  return (
    <View style={style}>
      {leaving.map((l) => (
        <SwapLayer key={`out:${l.key}`} kind={kind} lift={lift} inDelay={inDelay} leaving fresh={false} align={align} onGone={() => drop(l.key)}>
          {l.node}
        </SwapLayer>
      ))}
      <SwapLayer key={`in:${shown.id}`} kind={kind} lift={lift} inDelay={inDelay} leaving={false} fresh={shown.fresh} align={align} onGone={() => {}}>
        {children}
      </SwapLayer>
    </View>
  );
}

function SwapLayer({
  kind,
  lift,
  inDelay,
  leaving,
  fresh,
  align,
  onGone,
  children,
}: {
  kind: SwapKind;
  lift: number;
  inDelay: number;
  leaving: boolean;
  fresh: boolean;
  align: 'center' | 'start' | 'fill';
  onGone: () => void;
  children: ReactNode;
}) {
  const reduced = useReduceMotion();
  const moves = kind === 'lift' && !reduced;
  const o = useSharedValue(fresh ? 0 : 1);
  const y = useSharedValue(fresh && moves ? lift : 0);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (leaving) {
      const ms = reduced ? REDUCED_FADE_MS : kind === 'lift' ? NUMBER_SWAP.outMs : CROSSFADE_MS;
      o.value = reduced ? reducedFade(0) : kind === 'lift' ? exit(0, ms) : fade(0, ms);
      if (moves) y.value = exit(-lift, ms);
      // The layer is invisible by then; dropping it a little late is harmless.
      const t = setTimeout(() => gone.current(), ms + 40);
      return () => clearTimeout(t);
    }
    if (fresh) {
      if (reduced) o.value = reducedFade(1);
      else if (kind === 'lift') {
        o.value = withDelay(inDelay, standard(1, NUMBER_SWAP.inMs));
        y.value = withDelay(inDelay, standard(0, NUMBER_SWAP.inMs));
      } else o.value = fade(1);
    }
    return undefined;
    // Each layer arrives or leaves once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const animated = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));
  // The leaving layer lies over the new one, centred or from the start, with room to be wider than it (or, `fill`, at
  // the same width, so wrapped words wrap the same).
  const over: ViewStyle = !leaving
    ? {}
    : align === 'fill'
      ? { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }
      : { position: 'absolute', top: 0, bottom: 0, left: align === 'center' ? -48 : 0, right: -48, alignItems: align === 'center' ? 'center' : 'flex-start' };
  return (
    <Animated.View style={[over, animated]} {...(leaving ? HIDDEN : {})}>
      {children}
    </Animated.View>
  );
}

// ---------------------------------------------------------------- waiting

/**
 * Waiting only: the content breathes (opacity 1 to 0.35 and back, 2.4s; 1.6s when `small`) for as long as `active`.
 * When the wait ends it settles back to full. Reduce Motion: still; the words say it waits.
 */
export function Breathe({ active, small, children, style }: { active: boolean; small?: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReduceMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (active && !reduced) {
      const half = (small ? BREATHE.smallPeriodMs : BREATHE.periodMs) / 2;
      const ease = Easing.inOut(Easing.ease);
      o.value = withRepeat(withSequence(withTiming(BREATHE.to, { duration: half, easing: ease }), withTiming(BREATHE.from, { duration: half, easing: ease })), loopRepeats('activity', false));
    } else {
      cancelAnimation(o);
      o.value = reduced ? 1 : standard(1);
    }
    return () => cancelAnimation(o);
  }, [active, small, reduced, o]);
  const animated = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/**
 * Drives a ring that spreads from something and fades, `periodMs` apart: the first 70% of each period it grows to
 * `scaleTo` while fading from `opacityFrom`, then it rests. Activity rings run while `active`; status rings play three
 * times, then rest. The first ring leaves `delay` ms after it starts. Reduce Motion: no ring.
 */
export function useRing(active: boolean, kind: LoopKind, ring: { scaleTo: number; opacityFrom: number; periodMs: number; activeShare: number; curve: Curve }, delay = 0) {
  const reduced = useReduceMotion();
  // 0: at the source, fully there; 1: spread out and gone.
  const p = useSharedValue(1);
  const { scaleTo, opacityFrom, periodMs, activeShare, curve } = ring;
  useEffect(() => {
    const repeats = loopRepeats(kind, reduced);
    if (!active || repeats === 0) {
      cancelAnimation(p);
      p.value = reduced ? 1 : fade(1, EXIT.duration);
      return;
    }
    const grow = Math.round(periodMs * activeShare);
    const cycle = withSequence(withTiming(0, { duration: 0 }), withTiming(1, { duration: grow, easing: bezier(curve) }), withDelay(periodMs - grow, withTiming(1, { duration: 0 })));
    p.value = delay > 0 ? withDelay(delay, withRepeat(cycle, repeats)) : withRepeat(cycle, repeats);
    return () => cancelAnimation(p);
  }, [active, kind, reduced, p, periodMs, activeShare, curve, delay]);
  return useAnimatedStyle(() => ({ opacity: opacityFrom * (1 - p.value), transform: [{ scale: 1 + (scaleTo - 1) * p.value }] }));
}

/**
 * A status dot that sends out a ring: three pulses then rest (`status`, e.g. "Unconfirmed"), or for as long as it is
 * `active` (`activity`). The dot itself never moves.
 */
export function PulseDot({ className, size = 8, active = true, kind = 'status' }: { className: string; size?: number; active?: boolean; kind?: LoopKind }) {
  const ring = useRing(active, kind, PULSE_RING);
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, width: size, height: size }, ring]} {...HIDDEN}>
        <View className={cn('size-full rounded-full', className)} />
      </Animated.View>
      <View className={cn('size-full rounded-full', className)} />
    </View>
  );
}

// ---------------------------------------------------------------- success and refusal

const AnimatedPath = Animated.createAnimatedComponent(Path);
/** Lucide's check, drawn from its left end: the same mark the app showed before, now drawn. */
const CHECK_PATH = 'M4 12l5 5L20 6';
const CHECK_LENGTH = 23;

/**
 * The one success gesture: a check drawn with `strokeDashoffset` (320ms standard) `delay` ms after mount. `drawn`: it
 * is there already (a screen shown again, with nothing new to celebrate). Reduce Motion: drawn already (the circle
 * around it fades in).
 */
export function DrawnCheck({
  size = 36,
  color,
  strokeWidth = 2.4,
  delay = 0,
  duration = 320,
  drawn = false,
}: {
  size?: number;
  color: string;
  strokeWidth?: number;
  delay?: number;
  duration?: number;
  drawn?: boolean;
}) {
  const reduced = useReduceMotion();
  // Starts just past the line's start, so its round cap does not show as a dot before it draws.
  const hidden = CHECK_LENGTH + 2;
  const still = reduced || drawn;
  const offset = useSharedValue(still ? 0 : hidden);
  useEffect(() => {
    if (!still) offset.value = withDelay(delay, standard(0, duration));
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const props = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));
  return (
    // Decorative: "Sent" says it. (The accessibility props go on a view: on the web the SVG would pass them to the DOM.)
    <View {...HIDDEN}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <AnimatedPath
          d={CHECK_PATH}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={[CHECK_LENGTH, CHECK_LENGTH + 4]}
          animatedProps={props}
        />
      </Svg>
    </View>
  );
}

/**
 * The success mark of Sent and "You're all set": a 72px green circle that scales 0.6 to 1 with the settle spring (a
 * small overshoot) while it fades in, `at` ms after mount, and the check drawn in it `checkAt` ms after mount. Reduce
 * Motion: the circle fades in with the check already drawn.
 */
export function CheckCircle({ at, checkAt, checkMs = 320, fromScale = 0.6, fadeMs = 200 }: { at: number; checkAt: number; checkMs?: number; fromScale?: number; fadeMs?: number }) {
  const reduced = useReduceMotion();
  const { colors } = useTheme();
  const scale = useSharedValue(reduced ? 1 : fromScale);
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      opacity.value = reducedFade(1);
      return;
    }
    opacity.value = withDelay(at, withTiming(1, { duration: fadeMs, easing: Easing.linear }));
    scale.value = withDelay(at, spring(1, 'settle'));
    // Once, as the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const circle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={circle}>
      <View className="bg-good-soft size-[72px] items-center justify-center rounded-full">
        <DrawnCheck size={36} color={colors.good} strokeWidth={2.4} delay={checkAt} duration={checkMs} />
      </View>
    </Animated.View>
  );
}

/** The one refusal gesture: `shake()` plays a single shake (translateX -6, 6, -4, 3, 0 over 360ms). Reduce Motion: none. */
export function useShake(): { style: ReturnType<typeof useAnimatedStyle>; shake: () => void } {
  const reduced = useReduceMotion();
  const x = useSharedValue(0);
  const shake = useCallback(() => {
    if (reduced) return;
    const [first, ...rest] = shakeSteps().map((s) => withTiming(s.to, { duration: s.ms, easing: STANDARD_EASING }));
    x.value = withSequence(first!, ...rest);
  }, [reduced, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return { style, shake };
}

// ---------------------------------------------------------------- press

/**
 * Press feedback for a button: it shrinks to 0.96 in 90ms and springs back (firm). Spread `handlers` on the Pressable
 * and put `style` on an Animated.View around what shrinks. Reduce Motion: no shrink (the colour change says it).
 */
export function usePressScale(): { style: ReturnType<typeof useAnimatedStyle>; handlers: { onPressIn: () => void; onPressOut: () => void } } {
  const reduced = useReduceMotion();
  const s = useSharedValue(1);
  const handlers = {
    onPressIn: () => {
      if (!reduced) s.value = withTiming(PRESS.scale, { duration: PRESS.inMs, easing: EXIT_EASING });
    },
    onPressOut: () => {
      s.value = reduced ? 1 : spring(1, 'firm');
    },
  };
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return { style, handlers };
}

// ---------------------------------------------------------------- key marks

const KEY_ICON: Record<KeyName, LucideIcon> = { phone: Smartphone, guardian: Shield, hardware: HardwareWallet };

/**
 * The three keys as small round marks: the ones that signed fill green (240ms), and a short line between the first two
 * draws (200ms) once both have; one that is asked breathes (1.6s); one not involved is dimmed to 45%. Decorative: the
 * words next to them say the same.
 */
export function KeyMarks({ marks, linked, size = 26 }: { marks: KeyMark[]; linked: boolean; size?: number }) {
  return (
    <View className="flex-row items-center" {...HIDDEN}>
      {marks.map((m, i) => (
        <Fragment key={m.key}>
          {i === 1 && marks[0]?.state !== 'off' && m.state !== 'off' ? <KeyLink drawn={linked} /> : null}
          <KeyMarkView mark={m} size={size} spaced={m.state === 'off' && i > 0} />
        </Fragment>
      ))}
    </View>
  );
}

function KeyMarkView({ mark, size, spaced }: { mark: KeyMark; size: number; spaced: boolean }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  // `on`: filled (signed, or solid); `tone`: the fill's colour, ink (solid) or green (signed).
  const filledNow = mark.state === 'on' || mark.state === 'solid';
  const toneNow = mark.state === 'solid' ? 0 : 1;
  const on = useSharedValue(filledNow ? 1 : 0);
  const tone = useSharedValue(toneNow);
  useEffect(() => {
    const to = filledNow ? 1 : 0;
    on.value = reduced ? reducedFade(to) : standard(to);
    tone.value = reduced ? reducedFade(toneNow) : standard(toneNow);
  }, [filledNow, toneNow, reduced, on, tone]);
  const circle = useAnimatedStyle(() => {
    const fill = interpolateColor(tone.value, [0, 1], [colors.ink, colors.good]);
    return {
      backgroundColor: interpolateColor(on.value, [0, 1], [colors.screen, fill]),
      borderColor: interpolateColor(on.value, [0, 1], [colors.line, fill]),
    };
  });
  const plain = useAnimatedStyle(() => ({ opacity: 1 - on.value }));
  const filled = useAnimatedStyle(() => ({ opacity: on.value }));
  const icon = Math.round(size * 0.54);
  const inner: ViewStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' };
  return (
    // The dimmed mark's 45% sits outside the breathing, which animates opacity of its own.
    <View style={{ opacity: mark.state === 'off' ? 0.45 : 1, marginLeft: spaced ? 8 : 0 }}>
    <Breathe active={mark.state === 'waiting'} small>
      <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.5 }, circle]}>
        <Animated.View style={[inner, plain]}>
          <Icon as={KEY_ICON[mark.key]} size={icon} strokeWidth={2} className="text-muted-foreground" />
        </Animated.View>
        <Animated.View style={[inner, filled]}>
          <Icon as={KEY_ICON[mark.key]} size={icon} strokeWidth={2} className="text-background" />
        </Animated.View>
      </Animated.View>
    </Breathe>
    </View>
  );
}

function KeyLink({ drawn }: { drawn: boolean }) {
  const reduced = useReduceMotion();
  const x = useSharedValue(drawn ? 1 : 0);
  useEffect(() => {
    const to = drawn ? 1 : 0;
    x.value = reduced ? to : standard(to, 200);
  }, [drawn, reduced, x]);
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: x.value }] }));
  return (
    <View className="bg-border h-0.5 w-3.5 overflow-hidden">
      <Animated.View style={[{ width: '100%', height: '100%', transformOrigin: 'left' }, fill]}>
        <View className="bg-good size-full" />
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------- the shared waiting line

/**
 * "Waiting for your Ledger…": a dot and a sentence, the same wherever the app waits for a device or the guardian. The
 * amber dot breathes while it waits; it turns green once signed and red when refused, and the words crossfade.
 */
export function WaitingStatus({ tone, text, className, textClassName }: { tone: 'waiting' | 'good' | 'bad'; text: string; className?: string; textClassName?: string }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const target = tone === 'good' ? 1 : tone === 'bad' ? 2 : 0;
  const c = useSharedValue(target);
  useEffect(() => {
    c.value = reduced ? target : standard(target);
  }, [target, reduced, c]);
  const dot = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(c.value, [0, 1, 2], [colors.warn, colors.good, colors.bad]) }));
  return (
    <View className={cn('flex-row items-center justify-center gap-2.5', className)} accessibilityLiveRegion="polite">
      <Breathe active={tone === 'waiting'}>
        <Animated.View style={[{ width: 8, height: 8, borderRadius: 4 }, dot]} />
      </Breathe>
      <Swap id={text} align="start" style={{ flexShrink: 1 }}>
        <Text className={cn('text-muted-foreground text-sm leading-5', textClassName)}>{text}</Text>
      </Swap>
    </View>
  );
}

export type { SharedValue };
