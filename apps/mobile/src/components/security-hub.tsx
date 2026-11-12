/**
 * The Security tab's banner and tiles (docs/design/motion.md, section 8), drawn from src/lib/security-view.ts and moved
 * with the pieces in src/components/motion.tsx. Only opacity, transform and colour move, plus the links' and rings'
 * `strokeDashoffset`; everything runs on the UI thread, and a change mid-flight starts from where things are.
 *
 * `play`: this mount is the tab's entrance (the first visit after launch, or the first after a change made while the
 * tab was out of view). Otherwise everything is in place from the first frame and only changes move. Reduce Motion:
 * nothing moves; the entrance and every change are a 150ms fade.
 */
import type { LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, interpolateColor, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Bell, ChevronRight, Clock, Coins, Gauge, HardwareWallet, KeyRound, PhoneCheck, RefreshCw, RotateCcwKey, Shield, Smartphone } from '@/components/icons';
import { Breathe, DrawnCheck, HIDDEN, Rise, Swap, announce, bump, exit, fade, reducedFade, spring, standard, usePressScale, useReduceMotion, useRing } from '@/components/motion';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { haptic } from '@/lib/haptics';
import { bannerChange, bannerSpeech, tileLabel, type SecurityBanner, type SecurityKey, type SecurityTile, type TileIcon, type TileTone } from '@/lib/security-view';
import { cn } from '@/lib/utils';
import { PULSE_RING, SECURITY_ENTRANCE as IN, SECURITY_FIX as FIX, SECURITY_HALO as HALO, SECURITY_LINKS as LINKS, SYNC_RING, securityTileTimes } from '@/theme/motion';
import { useTheme } from '@/theme/use-theme';

// ---------------------------------------------------------------- the banner's mark: three keys, joined

/** The mark is drawn in the board's 72 x 64 units, shown 76px wide. */
const UNITS = { w: 72, h: 64 };
const WIDTH = 76;
const SCALE = WIDTH / UNITS.w;
const HEIGHT = UNITS.h * SCALE;
const NODE: Record<SecurityKey, { x: number; y: number }> = { hardware: { x: 36, y: 13 }, phone: { x: 14, y: 51 }, guardian: { x: 58, y: 51 } };
const NODE_R = 11;
const CENTRE = { x: 36, y: 39 };
const LINK_PAIRS: { a: SecurityKey; b: SecurityKey }[] = [
  { a: 'phone', b: 'hardware' },
  { a: 'hardware', b: 'guardian' },
  { a: 'phone', b: 'guardian' },
];
/** A little longer than the longest link (44 units), so a hidden link shows nothing. */
const LINK_LEN = 46;
/** The green ring drawn round a fixed key, from the top, clockwise. */
const RING_LEN = 2 * Math.PI * NODE_R;
const NODE_BOX = NODE_R * 2 + 4;
const RING_PATH = `M${NODE_BOX / 2} 2 A${NODE_R} ${NODE_R} 0 1 1 ${NODE_BOX / 2} ${NODE_BOX - 2} A${NODE_R} ${NODE_R} 0 1 1 ${NODE_BOX / 2} 2`;

const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const px = (u: number) => u * SCALE;

/**
 * One link between two keys: a solid green line that draws from one end (`strokeDashoffset`), and over it a dashed
 * amber one while either key needs the person. Entrance: solid links draw for 450ms from 450ms; dashed ones fade in
 * at 900ms. Fixed: the dashed line fades from 300ms (250ms) and the solid one draws from 350ms (400ms).
 */
function KeyLink({ a, b, amber, play }: { a: SecurityKey; b: SecurityKey; amber: boolean; play: boolean }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const animateIn = play && !reduced;
  // drawn: how much of the solid line shows (0 to 1). op: its opacity (Reduce Motion fades it instead of drawing).
  const drawn = useSharedValue(amber || animateIn ? 0 : 1);
  const op = useSharedValue(reduced && amber ? 0 : 1);
  const dashed = useSharedValue(amber && !animateIn ? LINKS.dashedOpacity : 0);
  const was = useRef(amber);
  useEffect(() => {
    if (!animateIn) return;
    if (amber) dashed.value = withDelay(IN.dashedAtMs, withTiming(LINKS.dashedOpacity, { duration: IN.dashedMs, easing: Easing.linear }));
    else drawn.value = withDelay(IN.linksAtMs, standard(1, IN.linksMs));
    // The entrance plays once, as the tab shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (was.current === amber) return;
    was.current = amber;
    if (reduced) {
      drawn.value = 1;
      op.value = reducedFade(amber ? 0 : 1);
      dashed.value = reducedFade(amber ? LINKS.dashedOpacity : 0);
    } else if (amber) {
      drawn.value = standard(0);
      dashed.value = standard(LINKS.dashedOpacity);
    } else {
      op.value = 1;
      dashed.value = withDelay(FIX.dashedOutAtMs, withTiming(0, { duration: FIX.dashedOutMs, easing: Easing.linear }));
      drawn.value = withDelay(FIX.linksAtMs, standard(1, FIX.linksMs));
    }
  }, [amber, reduced, drawn, op, dashed]);
  const solid = useAnimatedProps(() => ({ strokeDashoffset: LINK_LEN * (1 - drawn.value), strokeOpacity: LINKS.solidOpacity * op.value }));
  const dash = useAnimatedProps(() => ({ strokeOpacity: dashed.value }));
  const from = NODE[a];
  const to = NODE[b];
  return (
    <>
      <AnimatedLine x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colors.good} strokeWidth={2} strokeDasharray={[LINK_LEN, LINK_LEN]} animatedProps={solid} />
      <AnimatedLine x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colors.warn} strokeWidth={2} strokeDasharray={[3, 4]} animatedProps={dash} />
    </>
  );
}

const MARK_ICON: Record<SecurityKey | 'recoveryKey', LucideIcon> = { hardware: HardwareWallet, phone: Smartphone, guardian: Shield, recoveryKey: KeyRound };

/**
 * One key of the mark: a round mark with the key's icon, its ring green (working) or amber and dashed (needs the
 * person). Entrance: it pops (pop spring) at its time. Fixed: a green ring draws round it clockwise (500ms), its own
 * ring turns green as that closes, and it bumps. Being asked (the guardian syncing): it breathes, and bumps when the
 * answer comes.
 */
function KeyNode({ k, icon, needs, checking, play }: { k: SecurityKey; icon: LucideIcon; needs: boolean; checking: boolean; play: boolean }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const animateIn = play && !reduced;
  const scale = useSharedValue(animateIn ? 0 : 1);
  const ok = useSharedValue(needs ? 0 : 1);
  // The fixing ring: 0 not drawn, 1 drawn all round.
  const ring = useSharedValue(0);
  const was = useRef({ needs, checking });
  useEffect(() => {
    if (animateIn) scale.value = withDelay(IN.markAtMs[k], spring(1, 'pop'));
    // The entrance plays once, as the tab shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const before = was.current;
    was.current = { needs, checking };
    if (before.needs !== needs) {
      if (reduced) {
        ring.value = 0;
        ok.value = reducedFade(needs ? 0 : 1);
      } else if (needs) {
        ring.value = exit(0);
        ok.value = standard(0);
      } else {
        ring.value = withSequence(withTiming(0, { duration: 0 }), standard(1, FIX.ringMs));
        ok.value = withDelay(FIX.markOkAtMs, withTiming(1, { duration: 100, easing: Easing.linear }));
        scale.value = bump();
      }
    } else if (before.checking && !checking && !reduced) scale.value = bump();
  }, [needs, checking, reduced, scale, ok, ring]);
  const node = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const good = useAnimatedProps(() => ({ strokeOpacity: ok.value }));
  const warn = useAnimatedProps(() => ({ strokeOpacity: 1 - ok.value }));
  const fixing = useAnimatedProps(() => ({ strokeDashoffset: RING_LEN * (1 - ring.value), strokeOpacity: ring.value > 0.001 ? 1 : 0 }));
  const c = NODE_BOX / 2;
  const at = NODE[k];
  return (
    <Animated.View style={[{ position: 'absolute', left: px(at.x - c), top: px(at.y - c), width: px(NODE_BOX), height: px(NODE_BOX) }, node]}>
      <Breathe active={checking} small style={{ width: '100%', height: '100%' }}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${NODE_BOX} ${NODE_BOX}`}>
          <AnimatedCircle cx={c} cy={c} r={NODE_R} fill={colors.screen} stroke={colors.good} strokeWidth={2} animatedProps={good} />
          <AnimatedCircle cx={c} cy={c} r={NODE_R} fill="none" stroke={colors.warn} strokeWidth={2} strokeDasharray={[3, 2.76]} animatedProps={warn} />
          <AnimatedPath d={RING_PATH} fill="none" stroke={colors.good} strokeWidth={2.4} strokeDasharray={[RING_LEN, RING_LEN]} animatedProps={fixing} />
        </Svg>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <Icon as={icon} size={13} strokeWidth={2} className="text-foreground" />
        </View>
      </Breathe>
    </Animated.View>
  );
}

/**
 * The mark's centre: the drawn check and one soft ring when all is set, the alert mark when something needs the
 * person. Entrance: the check draws at 1.35s and the ring spreads at 1.45s (or the alert mark fades in at 1.3s).
 * All set: the alert mark fades at 550ms, the check draws at 750ms, the ring spreads at 850ms.
 */
function MarkCentre({ ok, play }: { ok: boolean; play: boolean }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const animateIn = play && !reduced;
  const alert = useSharedValue(ok || animateIn ? 0 : 1);
  const checkShown = useSharedValue(ok ? 1 : 0);
  // The soft ring: 0 at the centre, 1 spread out and gone.
  const halo = useSharedValue(1);
  // A new check for each time all is set: it draws once, as it mounts.
  const [check, setCheck] = useState<{ n: number; delay: number; drawn: boolean } | null>(ok ? { n: 0, delay: IN.checkAtMs, drawn: !animateIn } : null);
  const was = useRef(ok);
  const spread = (at: number, ms: number) => withDelay(at, withSequence(withTiming(0, { duration: 0 }), standard(1, ms)));
  useEffect(() => {
    if (!animateIn) return;
    if (ok) halo.value = spread(IN.haloAtMs, IN.haloMs);
    else alert.value = withDelay(IN.alertAtMs, fade(1, IN.alertMs));
    // The entrance plays once, as the tab shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (was.current === ok) return;
    was.current = ok;
    if (ok) {
      alert.value = reduced ? reducedFade(0) : withDelay(FIX.alertOutAtMs, fade(0, FIX.alertOutMs));
      checkShown.value = reduced ? reducedFade(1) : 1;
      setCheck((c) => ({ n: (c?.n ?? 0) + 1, delay: FIX.checkAtMs, drawn: false }));
      if (!reduced) halo.value = spread(FIX.haloAtMs, FIX.haloMs);
    } else {
      alert.value = reduced ? reducedFade(1) : standard(1);
      checkShown.value = reduced ? reducedFade(0) : exit(0);
      halo.value = 1;
    }
  }, [ok, reduced, alert, checkShown, halo]);
  const alertProps = useAnimatedProps(() => ({ strokeOpacity: alert.value }));
  const checkStyle = useAnimatedStyle(() => ({ opacity: checkShown.value }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: HALO.opacityFrom * (1 - halo.value),
    transform: [{ scale: HALO.fromScale + (HALO.toScale - HALO.fromScale) * halo.value }],
  }));
  const r = px(9);
  const size = 14;
  return (
    <>
      <Animated.View
        style={[{ position: 'absolute', left: px(CENTRE.x) - r, top: px(CENTRE.y) - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: colors.good }, haloStyle]}
      />
      <Svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${UNITS.w} ${UNITS.h}`} style={{ position: 'absolute', left: 0, top: 0 }}>
        <AnimatedPath d="M36 34v5.5M36 43v.4" fill="none" stroke={colors.warn} strokeWidth={2.8} strokeLinecap="round" animatedProps={alertProps} />
      </Svg>
      <Animated.View style={[{ position: 'absolute', left: px(CENTRE.x) - size / 2, top: px(CENTRE.y) - size / 2 }, checkStyle]}>
        {check ? <DrawnCheck key={check.n} size={size} color={colors.good} strokeWidth={4.8} delay={check.delay} drawn={check.drawn} /> : null}
      </Animated.View>
    </>
  );
}

/**
 * The three keys drawn as the Trikey mark: the hardware wallet on top, this phone bottom left, the guardian (or, in
 * Recovery Key mode, the Recovery Key) bottom right, joined. Decorative: the banner's words say the same.
 */
function KeyMark({ needing, ok, checking, third, play }: { needing: SecurityKey[]; ok: boolean; checking: boolean; third: 'guardian' | 'recoveryKey'; play: boolean }) {
  const needs = (k: SecurityKey) => needing.includes(k);
  return (
    <View style={{ width: WIDTH, height: HEIGHT }} {...HIDDEN}>
      <Svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${UNITS.w} ${UNITS.h}`} style={{ position: 'absolute', left: 0, top: 0 }}>
        {LINK_PAIRS.map((l) => (
          <KeyLink key={`${l.a}-${l.b}`} a={l.a} b={l.b} amber={needs(l.a) || needs(l.b)} play={play} />
        ))}
      </Svg>
      <MarkCentre ok={ok} play={play} />
      <KeyNode k="hardware" icon={MARK_ICON.hardware} needs={needs('hardware')} checking={false} play={play} />
      <KeyNode k="phone" icon={MARK_ICON.phone} needs={needs('phone')} checking={false} play={play} />
      <KeyNode k="guardian" icon={MARK_ICON[third]} needs={needs('guardian')} checking={checking} play={play} />
    </View>
  );
}

// ---------------------------------------------------------------- the banner

/**
 * "You're all set / All three keys are working." or "1 thing needs you / <the first issue>" with a chevron to its fix,
 * beside the keys' mark. When it turns from "needs you" to all set while in view, it plays the spec's 1.2s sequence and
 * `success` is felt as the check draws; the banner is never empty (the new words rise in as the old lift out). Each
 * change is said politely to a screen reader while the tab is in view.
 */
export function SecurityBannerView({
  banner,
  checking,
  third,
  play,
  focused,
  onFix,
}: {
  banner: SecurityBanner;
  /** The guardian is being asked: its mark breathes. */
  checking: boolean;
  third: 'guardian' | 'recoveryKey';
  play: boolean;
  /** The tab is in view: only then is a change felt or said. */
  focused: boolean;
  onFix: () => void;
}) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const tone = useSharedValue(banner.ok ? 1 : 0);
  const chevron = useSharedValue(banner.fix ? 1 : 0);
  const [shown, setShown] = useState({ title: banner.title, detail: banner.detail });
  const was = useRef(banner);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const live = useRef({ focused, reduced });
  live.current = { focused, reduced };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const before = was.current;
    was.current = banner;
    if (before.ok === banner.ok && before.title === banner.title && before.detail === banner.detail && before.needing.join() === banner.needing.join()) return;
    // What was under way (the words waiting to change, the haptic) gives way to the new change.
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const later = (ms: number, then: () => void) => void timers.current.push(setTimeout(then, ms));
    const words = { title: banner.title, detail: banner.detail };
    const { focused: inView, reduced: still } = live.current;
    if (bannerChange(before, banner).allSet && !still) {
      tone.value = withDelay(FIX.colourAtMs, standard(1, FIX.colourMs));
      chevron.value = withDelay(FIX.textOutAtMs, fade(0, 200));
      later(FIX.textOutAtMs, () => setShown(words));
      if (inView) later(FIX.checkAtMs, () => haptic('success'));
    } else {
      const toTone = banner.ok ? 1 : 0;
      const toChevron = banner.fix ? 1 : 0;
      tone.value = still ? reducedFade(toTone) : standard(toTone);
      chevron.value = still ? reducedFade(toChevron) : standard(toChevron);
      setShown(words);
      if (inView && still && !before.ok && banner.ok) haptic('success');
    }
    if (inView && (before.title !== banner.title || before.detail !== banner.detail)) announce(bannerSpeech(banner));
  }, [banner, tone, chevron]);
  const bg = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(tone.value, [0, 1], [colors.warnSoft, colors.goodSoft]) }));
  const chev = useAnimatedStyle(() => ({ opacity: chevron.value }));

  const body = (
    <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, minHeight: 44 }, bg]}>
      <KeyMark needing={banner.needing} ok={banner.ok} checking={checking} third={third} play={play} />
      <Swap id={`${shown.title}\n${shown.detail}`} kind="lift" lift={LINKS.textLift} inDelay={FIX.textInAtMs - FIX.textOutAtMs} align="fill" style={{ flex: 1 }}>
        <View className="gap-0.5">
          <Text className="text-[15px] font-semibold leading-5">{shown.title}</Text>
          <Text className="text-[13px] leading-[18px]">{shown.detail}</Text>
        </View>
      </Swap>
      <Animated.View style={chev} {...HIDDEN}>
        <Icon as={ChevronRight} size={18} strokeWidth={2} className="text-warn" />
      </Animated.View>
    </Animated.View>
  );
  // One element whether or not there is a fix, so the mark is never remounted (it would play its entrance again).
  const fix = !!banner.fix;
  return (
    <Rise play={play} distance={0} duration={IN.bannerFadeMs}>
      <Pressable
        accessible
        role={fix ? 'link' : undefined}
        accessibilityLabel={bannerSpeech(banner)}
        accessibilityHint={fix ? 'Opens where to put it right' : undefined}
        onPress={fix ? onFix : undefined}
        className={fix ? 'active:opacity-70' : undefined}>
        {body}
      </Pressable>
    </Rise>
  );
}

// ---------------------------------------------------------------- the tiles

const TILE_ICON: Record<TileIcon, LucideIcon> = {
  hardware: HardwareWallet,
  phone: Smartphone,
  guardian: Shield,
  recoveryKey: KeyRound,
  lost: RotateCcwKey,
  limit: Gauge,
  delay: Clock,
  contacts: Bell,
  phoneSafety: PhoneCheck,
  refills: RefreshCw,
  refillAmount: Coins,
};

const TONE_INDEX: Record<TileTone, number> = { good: 0, checking: 0, none: 0, warn: 1, bad: 2 };
const DOT = 10;
const alarming = (t: TileTone) => t === 'warn' || t === 'bad';

/**
 * A tile's 10px status dot. Entrance: it pops at its time. A change: the colour turns (300ms) with a bump from 100ms.
 * Needs the person (amber, or red for an offline guardian): it pulses 3 times, then rests. Being asked: a ring leaves it
 * every 1.2s for as long as it lasts. Decorative: the tile's words say the state.
 */
function StatusDot({ tone, play, at }: { tone: TileTone; play: boolean; at: number }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const animateIn = play && !reduced;
  const c = useSharedValue(TONE_INDEX[tone]);
  const scale = useSharedValue(animateIn || tone === 'none' ? 0 : 1);
  const [pulse, setPulse] = useState({ on: animateIn && alarming(tone), delay: at });
  const was = useRef(tone);
  useEffect(() => {
    if (animateIn && tone !== 'none') scale.value = withDelay(at, spring(1, 'pop'));
    // The entrance plays once, as the tab shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const before = was.current;
    was.current = tone;
    if (before === tone) return;
    const idx = TONE_INDEX[tone];
    if (reduced) {
      c.value = reducedFade(idx);
      scale.value = tone === 'none' ? 0 : 1;
      return;
    }
    c.value = withDelay(FIX.tileAtMs, standard(idx, FIX.tileColourMs));
    scale.value = tone === 'none' ? exit(0) : before === 'none' ? withDelay(FIX.tileAtMs, spring(1, 'pop')) : withDelay(FIX.tileAtMs, bump());
    setPulse({ on: alarming(tone), delay: FIX.tileAtMs });
  }, [tone, reduced, c, scale]);
  const warnRing = useRing(pulse.on && alarming(tone), 'status', PULSE_RING, pulse.delay);
  const syncRing = useRing(tone === 'checking', 'activity', SYNC_RING);
  const dot = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(c.value, [0, 1, 2], [colors.good, colors.warn, colors.bad]), transform: [{ scale: scale.value }] }));
  const fill = { position: 'absolute', top: 0, left: 0, width: DOT, height: DOT } as const;
  return (
    <View style={{ width: DOT, height: DOT }} {...HIDDEN}>
      <Animated.View style={[fill, warnRing]}>
        <View className={cn('size-full rounded-full', tone === 'bad' ? 'bg-destructive' : 'bg-warn')} />
      </Animated.View>
      <Animated.View style={[fill, syncRing]}>
        <View className="bg-good size-full rounded-full" />
      </Animated.View>
      <Animated.View style={[{ width: DOT, height: DOT, borderRadius: DOT / 2 }, dot]} />
    </View>
  );
}

/**
 * One tile: its icon, a status dot top right, the title and the value line under it. A button with its title, value
 * and state as its label; a tile with nowhere to go (the hardware wallet) is read the same way but is not a button.
 * Entrance: it rises 8px, 50ms after the one before. The value line crossfades when it changes.
 */
function SecurityTileView({ tile, index, play, onPress }: { tile: SecurityTile; index: number; play: boolean; onPress: (tile: SecurityTile) => void }) {
  const { riseAt, dotAt } = securityTileTimes(index);
  const press = usePressScale();
  const inner = (
    // 112px holds a two-line title or a two-line value without growing, so "Checking…" and back never moves the page.
    <View className="bg-secondary min-h-[112px] flex-1 rounded-[14px] p-3.5">
      <Icon as={TILE_ICON[tile.icon]} size={24} strokeWidth={1.8} className="text-foreground" />
      <View style={{ position: 'absolute', top: 14, right: 14 }}>
        <StatusDot tone={tile.tone} play={play} at={dotAt} />
      </View>
      <View className="mt-auto pt-1">
        <Text className="text-[15px] font-medium leading-[19px]">{tile.title}</Text>
        <Swap id={tile.value} align="fill">
          <Text numberOfLines={2} className={cn('text-[13px] leading-[18px] tabular-nums', tile.alert ? 'text-warn font-medium' : 'text-muted-strong')}>
            {tile.value}
          </Text>
        </Swap>
      </View>
    </View>
  );
  const label = tileLabel(tile);
  const content = tile.action ? (
    <Pressable role="button" accessibilityLabel={label} onPress={() => onPress(tile)} {...press.handlers} style={{ flex: 1 }}>
      <Animated.View style={[{ flex: 1 }, press.style]}>{inner}</Animated.View>
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={label} style={{ flex: 1 }}>
      {inner}
    </View>
  );
  return (
    <Rise play={play} delay={riseAt} distance={IN.tileRise} style={{ flex: 1 }}>
      {content}
    </Rise>
  );
}

/** Tiles two across. `first`: the first tile's place in the whole tab's stagger. */
export function TileGrid({ tiles, first, play, onPress }: { tiles: SecurityTile[]; first: number; play: boolean; onPress: (tile: SecurityTile) => void }) {
  const rows: SecurityTile[][] = [];
  for (let i = 0; i < tiles.length; i += 2) rows.push(tiles.slice(i, i + 2));
  return (
    <View className="gap-2">
      {rows.map((row, r) => (
        <View key={row.map((t) => t.id).join()} className="flex-row gap-2">
          {row.map((t, i) => (
            <SecurityTileView key={t.id} tile={t} index={first + r * 2 + i} play={play} onPress={onPress} />
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

