import { useIsFocused, useRouter } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withDelay, type SharedValue } from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';
import { ActivityRow } from '@/components/activity-row';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Clock, Eye, EyeOff, HardwareWallet, Lock, Settings, TriangleAlert } from '@/components/icons';
import { FadeLayer, HIDDEN, Swap, announce, exit, fade, reducedFade, standard, usePressScale, useReduceMotion } from '@/components/motion';
import { Notice } from '@/components/panels';
import { Sheet } from '@/components/sheet';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  formatAmount,
  formatBtc,
  formatCountdown,
  formatSats,
  guardianLockedLine,
  hostLockedLine,
  walletPausedLine,
  LIMIT_OFF_LINE,
  limitIsOff,
  remainingToday,
  useActivity,
  useNow,
  useWallet,
  useWalletService,
  type ActivityItem,
  type Sats,
} from '@/data';
import { guardianBox } from '@/lib/labels';
import { incomingLine } from '@/lib/payment-texts';
import { GUARDIAN_NOTICE, NEW_ROW, REDUCED_FADE_MS, guardianNoticeMove, type GuardianNoticeLook } from '@/theme/motion';
import { useTheme } from '@/theme/use-theme';
import { haptic } from '@/lib/haptics';
import { useAction } from '@/lib/use-action';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** A layer over another, centred on it, with room to be wider. */
const OVER_CENTRED = { position: 'absolute', top: 0, bottom: 0, left: -64, right: -64, alignItems: 'center' } as const;

/** Tap-to-hide for the balance: remembered while the app runs, so Home and its states agree. */
let balanceHidden = false;
const hiddenListeners = new Set<() => void>();
function useBalanceHidden(): [boolean, () => void] {
  const hidden = useSyncExternalStore(
    (listener) => {
      hiddenListeners.add(listener);
      return () => hiddenListeners.delete(listener);
    },
    () => balanceHidden
  );
  const toggle = () => {
    balanceHidden = !balanceHidden;
    hiddenListeners.forEach((listener) => listener());
  };
  return [hidden, toggle];
}

/** The top of a tab root: the way to Settings (iOS in the content, Android in the top bar). The network is the strip above. */
export function HomeTopActions() {
  const router = useRouter();
  return (
    <View className={cn('flex-row items-center', IS_IOS ? 'h-11 justify-end' : 'gap-1')}>
      <Pressable
        role="link"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        className="size-11 items-center justify-center rounded-full active:bg-accent">
        <Icon as={Settings} size={22} strokeWidth={1.8} className="text-foreground" />
      </Pressable>
    </View>
  );
}

/**
 * The big number, centred. Sats by default, BTC when the user switched units; tap it to hide it. Hiding and showing
 * crossfade (160ms, no blur). A new balance changes as a whole number (the old one lifts away, the new one rises), never
 * while hidden. With `showIncoming`, the line under it reads "+21,000 sats · unconfirmed" while the incoming toast is up.
 */
export function BalanceHeader({
  label,
  sats,
  caption,
  showIncoming = false,
}: {
  label: string;
  sats: Sats;
  /** Replaces the BTC line, e.g. "Spend with Face ID, no Ledger needed". */
  caption?: string;
  /** The wallet's main balance: an incoming payment's toast also shows under it. */
  showIncoming?: boolean;
}) {
  const { unit, synced, syncing, guardianSlow, backing, toast } = useWallet();
  const [hidden, toggle] = useBalanceHidden();
  const incoming = showIncoming && !hidden ? incomingLine(toast) : null;
  const waiting =
    backing !== 'demo' && !synced
      ? syncing
        ? 'Syncing with your guardian…'
        : guardianSlow
          ? 'Your guardian is slow to answer. Pull down to try again.'
          : 'Not synced yet. Pull down to refresh.'
      : undefined;
  const main = formatAmount(sats, unit);
  const unitText = unit === 'btc' ? 'BTC' : 'sats';
  const secondary = unit === 'btc' ? `BTC · ${formatSats(sats)} sats` : `sats · ${formatBtc(sats)} BTC`;
  const big = cn('tabular-nums', pick('text-[56px] font-semibold leading-[64px] tracking-[-2.2px]', 'text-[56px] font-normal leading-[64px] tracking-[-1.1px]'));
  const line = cn('tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'));
  const under = hidden ? 'Balance hidden' : (incoming ?? waiting ?? secondary);
  return (
    <Pressable
      role="button"
      testID="home-balance"
      onPress={toggle}
      accessibilityLabel={hidden ? `${label} hidden. Tap to show` : `${label}: ${main} ${unitText}${incoming ? `, ${incoming}` : ''}. Tap to hide`}
      className="items-center gap-0.5 pt-2">
      <View>
        <FadeLayer shown={!hidden}>
          <Swap id={main} kind="lift" animate={!hidden}>
            <Text className={big}>{main}</Text>
          </Swap>
        </FadeLayer>
        <FadeLayer shown={hidden} style={OVER_CENTRED}>
          <Text className={big}>••••••</Text>
        </FadeLayer>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Swap id={under} align="center">
          <Text className={cn(line, incoming ? 'text-good font-medium' : 'text-muted-foreground')}>{under}</Text>
        </Swap>
        <Icon as={hidden ? EyeOff : Eye} size={16} strokeWidth={2} className="text-muted-foreground" />
      </View>
      {caption ? <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{caption}</Text> : null}
    </Pressable>
  );
}

/**
 * A wallet that has never had bitcoin: nothing in it, no payment in its history (one still arriving counts as a payment)
 * and no silent payment waiting. Home then leads with Receive; it all goes back to normal with the first payment.
 */
export function useNewWallet(): boolean {
  const state = useWallet();
  const hasPayment = useActivity().some((item) => item.type === 'payment');
  const sp = state.silentPayments.balance;
  return state.balanceSats === 0 && !hasPayment && sp.sats + sp.unconfirmedSats === 0;
}

/**
 * Send and Receive as two round buttons with their names under them. In a new wallet Receive leads and Send is greyed,
 * but still a button: it explains there is nothing to send yet and offers the address.
 */
export function SendReceiveButtons({ sendEmphasis = true, newWallet = false }: { sendEmphasis?: boolean; newWallet?: boolean }) {
  const router = useRouter();
  const [nothingToSend, setNothingToSend] = useState(false);
  const button = (title: string, icon: typeof ArrowUpRight, look: 'primary' | 'secondary' | 'quiet', onPress: () => void, hint?: string) => (
    <RoundButton title={title} icon={icon} look={look} onPress={onPress} hint={hint} />
  );
  const showAddress = () => {
    setNothingToSend(false);
    router.push('/receive');
  };
  return (
    <View className="flex-row justify-center gap-12">
      {newWallet
        ? button('Send', ArrowUpRight, 'quiet', () => setNothingToSend(true), 'Nothing to send yet. Shows how to receive bitcoin.')
        : button('Send', ArrowUpRight, sendEmphasis ? 'primary' : 'secondary', () => router.push('/send/to'))}
      {button('Receive', ArrowDownLeft, newWallet ? 'primary' : 'secondary', () => router.push('/receive'))}
      <Sheet visible={nothingToSend} title="Nothing to send yet" onClose={() => setNothingToSend(false)}>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[22px]', 'text-sm leading-5'))}>
          Your wallet is empty. Once bitcoin arrives, Send works from here.
        </Text>
        <AppButton title="Show my address" onPress={showAddress} />
        <AppButton title="Close" variant="ghost" onPress={() => setNothingToSend(false)} />
      </Sheet>
    </View>
  );
}

/** Send or Receive: a round button with its name under it. Pressed, the circle shrinks a little and springs back. */
function RoundButton({ title, icon, look, onPress, hint }: { title: string; icon: typeof ArrowUpRight; look: 'primary' | 'secondary' | 'quiet'; onPress: () => void; hint?: string }) {
  const press = usePressScale();
  return (
    <Pressable role="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} {...press.handlers} className="items-center gap-2 active:opacity-70">
      <Animated.View style={press.style}>
        <View className={cn('size-16 items-center justify-center rounded-full', look === 'primary' ? 'bg-primary' : 'bg-secondary')}>
          <Icon
            as={icon}
            size={26}
            strokeWidth={2}
            className={look === 'primary' ? 'text-primary-foreground' : look === 'quiet' ? 'text-muted-foreground' : 'text-foreground'}
          />
        </View>
      </Animated.View>
      <Text className={cn('text-sm font-medium leading-5', look === 'quiet' && 'text-muted-foreground')}>{title}</Text>
    </Pressable>
  );
}

/** One line under the balance: what the phone can still pay today without the hardware wallet. Opens the limit. */
export function LimitLine({ newWallet = false }: { newWallet?: boolean }) {
  const router = useRouter();
  const state = useWallet();
  const left = remainingToday(state);
  const { limitSats } = state.dailyLimit;
  const brand = state.hardware.brand;
  // No daily limit: say so, in the warning tone, whatever has been sent.
  if (limitIsOff(state)) return <StatusLine tone="warn" text={LIMIT_OFF_LINE} onPress={() => router.push('/settings/limit')} />;
  // Nothing to count yet: say what the limit is, not how much of it is left.
  if (newWallet) return <StatusLine text={`Daily limit ${formatSats(limitSats)} sats, without your ${brand}`} onPress={() => router.push('/settings/limit')} />;
  const low = limitSats > 0 && left < limitSats * 0.1;
  const text = low ? `${formatSats(left)} sats left today. Bigger payments need your ${brand}.` : `${formatSats(left)} sats left today without your ${brand}`;
  return <StatusLine tone={low ? 'warn' : 'good'} text={text} onPress={() => router.push('/settings/limit')} />;
}

/** A dot and a short sentence, centred under the balance. */
export function StatusLine({ tone, text, onPress }: { tone?: 'good' | 'warn'; text: string; onPress?: () => void }) {
  const body = (
    <View className="min-h-11 flex-row items-center justify-center gap-2 px-2">
      {tone ? <View className={cn('size-2 rounded-full', tone === 'good' ? 'bg-good' : 'bg-warn')} /> : null}
      <Text className={cn('text-muted-foreground shrink text-center tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{text}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable role="link" accessibilityLabel={text} onPress={onPress} className="-mt-3 active:opacity-70">
      {body}
    </Pressable>
  );
}

/**
 * Received silent payments wait in their own balance (single-key coins of this phone) until they are moved into the vault. A
 * small row appears while there is something to move; the move itself is one tap on the next screen, with its fees shown.
 */
export function SilentPaymentsRow() {
  const router = useRouter();
  const { silentPayments: sp, mode, unit } = useWallet();
  if (mode === 'recoveryKey' || sp.balance.sats <= 0) return null;
  const count = sp.coins.length;
  return (
    <Card className="gap-3 px-4 py-3.5">
      <View className="flex-row items-center justify-between gap-3" accessible accessibilityLabel={`Silent payments: ${formatAmount(sp.balance.sats, unit)} ${unit === 'btc' ? 'bitcoin' : 'sats'} waiting`}>
        <View className="flex-1">
          <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>Silent payments</Text>
          <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
            {count} {count === 1 ? 'payment' : 'payments'} waiting{sp.balance.unconfirmedSats > 0 ? ', some unconfirmed' : ''}
          </Text>
        </View>
        <Text className={cn('tabular-nums', pick('text-[17px] font-semibold', 'text-base font-medium'))}>
          {formatAmount(sp.balance.sats, unit)} <Text className="text-muted-foreground text-sm font-normal">{unit === 'btc' ? 'BTC' : 'sats'}</Text>
        </Text>
      </View>
      <AppButton title="Move into your vault" variant="secondary" onPress={() => router.push('/silent/move')} />
    </Card>
  );
}

/**
 * What Home's guardian notice shows (docs/design/motion.md, section 5): `look` is the guardian locked or offline,
 * "Guardian unlocked" for a moment, or nothing; `closing` while it collapses; `opening` while it opens.
 */
export type GuardianNotice = { look: GuardianNoticeLook; closing: boolean; opening: boolean };

/**
 * Follows the guardian's status for Home's notice. Locked to online: "Guardian unlocked" (`success` felt, said politely),
 * held 1.4s, then it collapses. Offline to online: it collapses at once. Online to locked or offline: it opens, with no
 * haptic (the wallet state does not say whether this phone locked it). A change that happens while Home is not on screen
 * (unlocked on Settings > Guardian) plays when Home is back, so it is seen.
 */
export function useGuardianNotice(shown = true): GuardianNotice {
  const status = useWallet().guardian.status;
  const focused = useIsFocused();
  const reduced = useReduceMotion();
  const [notice, setNotice] = useState<GuardianNotice>({ look: status === 'online' ? null : status, closing: false, opening: false });
  // The status the notice last followed.
  const [followed, setFollowed] = useState(status);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (followed === status || (shown && !focused)) return;
    // What was under way (a hold, a collapse) gives way to the new change, from where things are.
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setFollowed(status);
    // Not on Home's face (Recovery Key mode): follow quietly, with no motion and no haptic.
    if (!shown) {
      setNotice({ look: status === 'online' ? null : status, closing: false, opening: false });
      return;
    }
    const move = guardianNoticeMove(followed, status);
    const later = (ms: number, then: () => void) => void timers.current.push(setTimeout(then, ms));
    const closeMs = reduced ? REDUCED_FADE_MS : GUARDIAN_NOTICE.closeMs;
    const gone = () => setNotice({ look: null, closing: false, opening: false });
    if (move.kind === 'open' || move.kind === 'swap') {
      // From nothing, or back from "unlocked" or a collapse under way: it opens (or turns back) into the new status.
      setNotice({ look: status === 'online' ? null : status, closing: false, opening: true });
      later(reduced ? REDUCED_FADE_MS : GUARDIAN_NOTICE.openMs, () => setNotice((n) => ({ ...n, opening: false })));
    } else if (move.kind === 'unlocked') {
      if (move.haptic) haptic(move.haptic);
      announce('Guardian unlocked. Phone payments work again.');
      setNotice({ look: 'unlocked', closing: false, opening: false });
      later(GUARDIAN_NOTICE.holdMs, () => {
        setNotice((n) => ({ ...n, closing: true }));
        later(closeMs, gone);
      });
    } else if (move.kind === 'close') {
      setNotice((n) => ({ ...n, closing: true }));
      later(closeMs, gone);
    }
  }, [shown, focused, status, followed, reduced]);
  return notice;
}

/**
 * Guardian locked (after a restart) or offline: phone-only payments wait, the hardware wallet can still pay. A locked
 * guardian is unlocked on the guardian's page: with its passphrase, or the hardware wallet when that is on.
 *
 * Motion (section 5), driven by `useGuardianNotice`: unlocked, the padlock's shackle opens (240ms) while the notice turns
 * from amber to green and shrinks to one line, "Guardian unlocked / Phone payments work again." (280ms); it then
 * collapses (280ms). Locking opens it (280ms) as the shackle closes. "Guardian offline" opens and closes the same way,
 * with its own icon. These two height changes are the only layout animations Home has besides a new row. Reduce
 * Motion: no movement; the words and colours fade (150ms) and the notice fades out.
 */
export function GuardianDownNotice({ notice }: { notice: GuardianNotice }) {
  const router = useRouter();
  const service = useWalletService();
  const reduced = useReduceMotion();
  const { colors } = useTheme();
  const { guardian, hardware, hosted } = useWallet();
  // Unlocking with the hardware wallet is on: the guardian page offers it first.
  const byHardware = !!service.hardwareUnlock?.state()?.on;
  const unlocked = notice.look === 'unlocked';
  // What the amber words say: "unlocked" only ever follows "locked".
  const locked = notice.look !== 'offline';
  const host = guardianBox(guardian);

  // ok: amber to green, and the notice's height from the full notice to one line. words: the crossfade of the words.
  // open: the notice's own height and opacity. shackle: 0 closed, 1 open.
  const ok = useSharedValue(unlocked ? 1 : 0);
  const words = useSharedValue(unlocked ? 1 : 0);
  const open = useSharedValue(notice.opening ? 0 : 1);
  const shackle = useSharedValue(unlocked || (notice.opening && !reduced) ? 1 : 0);
  // The two layers' heights, measured; -1 until they are.
  const downH = useSharedValue(-1);
  const upH = useSharedValue(-1);

  useEffect(() => {
    const to = unlocked ? 1 : 0;
    if (reduced) {
      ok.value = reducedFade(to);
      words.value = reducedFade(to);
      shackle.value = to;
      return;
    }
    ok.value = standard(to, GUARDIAN_NOTICE.turnMs);
    words.value = fade(to, GUARDIAN_NOTICE.wordsMs);
    shackle.value = standard(to, GUARDIAN_NOTICE.shackleMs);
  }, [unlocked, reduced, ok, words, shackle]);
  useEffect(() => {
    const to = notice.closing ? 0 : 1;
    open.value = reduced ? reducedFade(to) : notice.closing ? exit(to, GUARDIAN_NOTICE.closeMs) : standard(to, GUARDIAN_NOTICE.openMs);
  }, [notice.closing, reduced, open]);

  const box = useAnimatedStyle(() => {
    const background = interpolateColor(ok.value, [0, 1], [colors.warnSoft, colors.goodSoft]);
    // Not measured yet: as it lays itself out (or nothing, while it is about to open).
    if (downH.value < 0) return open.value < 1 ? { backgroundColor: background, opacity: 0, height: 0 } : { backgroundColor: background, opacity: 1 };
    const up = upH.value < 0 ? downH.value : upH.value;
    // Reduce Motion: the height changes at once, never in steps.
    const full = reduced ? (ok.value < 0.5 ? downH.value : up) : downH.value + (up - downH.value) * ok.value;
    return { backgroundColor: background, opacity: open.value, height: reduced ? full : full * open.value };
  }, [colors, reduced]);
  const downWords = useAnimatedStyle(() => ({ opacity: 1 - words.value }));
  const upWords = useAnimatedStyle(() => ({ opacity: words.value }));

  return (
    <Animated.View style={[{ overflow: 'hidden', borderRadius: pick(10, 12) }, box]}>
      {/* The notice as it was: it sets the notice's full height. */}
      <Animated.View style={downWords} onLayout={(e) => (downH.value = e.nativeEvent.layout.height)} {...(unlocked ? HIDDEN : {})}>
        <View className={cn('gap-1 px-4 pt-3.5', locked ? 'pb-1.5' : 'pb-3.5')}>
          <View className="flex-row items-start gap-3">
            <View className="size-5" />
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold leading-5">{locked ? 'Guardian locked' : 'Guardian offline'}</Text>
              <Text className="text-sm leading-5">
                {locked
                  ? hosted
                    ? hostLockedLine(hosted.hostLabel ?? `Your host's ${host}`, hardware.brand)
                    : guardianLockedLine(guardian, host, hardware.brand)
                  : `Trikey can't reach your ${host}. Phone-only payments wait until it's back; your ${hardware.brand} can still pay.`}
              </Text>
              {locked && !hosted ? (
                <Pressable role="link" onPress={() => router.push('/settings/guardian')} className="min-h-11 justify-center self-start active:opacity-60">
                  <Text className="text-[15px] font-semibold leading-5">{byHardware ? `Unlock with your ${hardware.brand}` : 'Unlock with passphrase'}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </Animated.View>
      {/* Unlocked: one line. */}
      <Animated.View
        style={[{ position: 'absolute', top: 0, left: 0, right: 0 }, upWords]}
        onLayout={(e) => (upH.value = e.nativeEvent.layout.height)}
        {...(unlocked ? { accessible: true, accessibilityLabel: 'Guardian unlocked. Phone payments work again.' } : HIDDEN)}>
        <View className="flex-row items-start gap-3 px-4 py-3.5">
          <View className="size-5" />
          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold leading-5">Guardian unlocked</Text>
            <Text className="text-sm leading-5">Phone payments work again.</Text>
          </View>
        </View>
      </Animated.View>
      {/* The icon both share, where the notice's icon always was. */}
      <View style={{ position: 'absolute', left: 16, top: 15 }} {...HIDDEN}>
        {locked ? <Padlock shackle={shackle} ok={ok} /> : <Icon as={TriangleAlert} size={20} className="text-warn" strokeWidth={2} />}
      </View>
    </Animated.View>
  );
}

/** Lucide's lock, drawn in two parts so its shackle can open: it lifts and turns about its right foot. */
const LOCK_SHACKLE = 'M7 11V7a5 5 0 0 1 10 0v4';

/** The padlock of the guardian notice: amber and shut, or green with its shackle open. Decorative. */
function Padlock({ shackle, ok, size = 20 }: { shackle: SharedValue<number>; ok: SharedValue<number>; size?: number }) {
  const { colors } = useTheme();
  const k = size / 24;
  // The shackle turns about its right foot (17, 11 in Lucide's 24-unit box), measured from the icon's centre.
  const px = 17 * k - size / 2;
  const py = 11 * k - size / 2;
  const turn = useAnimatedStyle(() => ({
    transform: [
      { translateY: -GUARDIAN_NOTICE.shackleLift * k * shackle.value },
      { translateX: px },
      { translateY: py },
      { rotate: `${GUARDIAN_NOTICE.shackleDeg * shackle.value}deg` },
      { translateX: -px },
      { translateY: -py },
    ],
  }));
  const bodyAmber = useAnimatedStyle(() => ({ opacity: 1 - ok.value }));
  const bodyGreen = useAnimatedStyle(() => ({ opacity: ok.value }));
  const shackleAmber = useAnimatedStyle(() => ({ opacity: 1 - ok.value }));
  const shackleGreen = useAnimatedStyle(() => ({ opacity: ok.value }));
  const fill = { position: 'absolute', top: 0, left: 0, width: size, height: size } as const;
  const drawn = (color: string, part: ReactNode) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {part}
    </Svg>
  );
  const body = <Rect x={3} y={11} width={18} height={11} rx={2} ry={2} />;
  return (
    <View style={{ width: size, height: size, marginTop: 0 }}>
      <Animated.View style={[fill, bodyAmber]}>{drawn(colors.warn, body)}</Animated.View>
      <Animated.View style={[fill, bodyGreen]}>{drawn(colors.good, body)}</Animated.View>
      <Animated.View style={[fill, turn]}>
        <Animated.View style={[fill, shackleAmber]}>{drawn(colors.warn, <Path d={LOCK_SHACKLE} />)}</Animated.View>
        <Animated.View style={[fill, shackleGreen]}>{drawn(colors.good, <Path d={LOCK_SHACKLE} />)}</Animated.View>
      </Animated.View>
    </View>
  );
}

/** The latest few items under "Activity" on the home tab. */
export function ActivityPreview({ limit, newWallet = false }: { limit: number; newWallet?: boolean }) {
  const router = useRouter();
  const state = useWallet();
  const now = useNow();
  const items = useActivity()
    .filter((item): item is Extract<ActivityItem, { type: 'payment' }> => item.type === 'payment')
    .slice(0, limit);
  const ctx = { now, unit: state.unit, hardwareBrand: state.hardware.brand };
  // A payment that shows up while Home is open (not the rows there when it opened) opens its place in the list.
  const seen = useRef<Set<string> | null>(null);
  const arriving = (id: string, pending: boolean) => pending && seen.current !== null && !seen.current.has(id);
  useEffect(() => {
    seen.current = new Set([...(seen.current ?? []), ...items.map((i) => i.tx.id)]);
  });
  return (
    <View>
      <View className="flex-row items-center justify-between">
        <Text role="heading" className={pick('text-xl font-bold leading-[26px]', 'text-base font-medium leading-6')}>
          Recent
        </Text>
        <Pressable role="link" testID="home-see-all" onPress={() => router.push('/activity')} className="min-h-11 justify-center pl-4 active:opacity-60">
          <Text className={cn('text-muted-foreground font-medium', pick('text-[15px]', 'text-sm'))}>See all</Text>
        </Pressable>
      </View>
      {items.length === 0 ? newWallet ? <FirstPaymentCard /> : <Text className="text-muted-foreground py-4 text-[15px] leading-5">No payments yet.</Text> : null}
      {items.map((item, i) => (
        <ArrivingRow key={item.tx.id} arriving={arriving(item.tx.id, item.tx.status === 'pending')}>
          {/* Waiting to confirm: its amber dot pulses three times, then rests until the first confirmation. */}
          <ActivityRow item={item} variant="home" last={i === items.length - 1} ctx={ctx} pulse />
        </ArrivingRow>
      ))}
    </View>
  );
}

/**
 * A row that has just arrived: its place opens from nothing to its height (280ms, one of the two layout animations the
 * motion design allows), and its content fades in while dropping 6px into place. Reduce Motion: the row is there at
 * once and fades in. A row that was already there renders as it is.
 */
function ArrivingRow({ arriving: arrivingNow, children }: { arriving: boolean; children: ReactNode }) {
  // Decided when the row first renders: it stays arriving until its entrance is over.
  const [arriving] = useState(arrivingNow);
  const reduced = useReduceMotion();
  const height = useSharedValue(0);
  const open = useSharedValue(arriving && !reduced ? 0 : 1);
  const shown = useSharedValue(arriving ? 0 : 1);
  const started = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    // The row's own height, kept up to date (a line added later is not cut off).
    height.value = e.nativeEvent.layout.height;
    if (started.current) return;
    started.current = true;
    if (reduced) {
      shown.value = reducedFade(1);
      return;
    }
    open.value = withDelay(NEW_ROW.heightDelayMs, standard(1, NEW_ROW.heightMs));
    shown.value = withDelay(NEW_ROW.contentDelayMs, standard(1, NEW_ROW.contentMs));
  };
  const place = useAnimatedStyle(() => ({ height: height.value * open.value }));
  const content = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: -NEW_ROW.drop * (1 - shown.value) }] }));
  if (!arriving) return <>{children}</>;
  return (
    <Animated.View style={[{ overflow: 'hidden' }, reduced ? null : place]}>
      <Animated.View onLayout={onLayout} style={content}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/** A new wallet's Recent: one card that leads to the address, in place of an empty list. */
function FirstPaymentCard() {
  const router = useRouter();
  return (
    <Card className="mt-2 items-center gap-2.5 px-5 py-6">
      <View className="bg-secondary size-11 items-center justify-center rounded-full">
        <Icon as={ArrowDownLeft} size={22} strokeWidth={2} className="text-foreground" />
      </View>
      <Text role="heading" aria-level={2} className={cn('text-center font-semibold', pick('text-[17px] leading-[22px]', 'text-base leading-[22px]'))}>
        Receive your first bitcoin
      </Text>
      <Text className="text-muted-foreground text-center text-sm leading-5">Share your address or QR code. Payments show up here.</Text>
      <AppButton title="Show my address" className="mt-1 self-center px-5" onPress={() => router.push('/receive')} />
    </Card>
  );
}

/**
 * Shown on home while a recovery is running or waiting for the user's answer, and after a recovery someone else cancelled:
 * phone-only payments stay paused until the hardware wallet resumes them.
 */
export function RecoveryBanner() {
  const router = useRouter();
  const now = useNow();
  const wallet = useWalletService();
  const { recovery, phoneSpending, hardware, walletRetired: retired, hosted } = useWallet();
  const { busy, run, message, error } = useAction();

  if (!recovery) {
    // A hosted wallet that is paused (family hosting phase 2): only this wallet, and only the hardware wallet resumes it.
    if (hosted?.paused && !retired && phoneSpending !== 'retired') {
      return (
        <View className="gap-3">
          <Notice icon={Lock} iconClass="text-warn" tone="warn-outline" title="This wallet is paused">
            {walletPausedLine(hosted.paused, hardware.brand)}
          </Notice>
          <AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Resume with ${hardware.brand}`} variant="outline" busy={busy} onPress={() => void run(wallet.resumePhoneSpending())} />
          <ActionNotice message={message} error={error} />
        </View>
      );
    }
    if (phoneSpending === 'paused_contested') {
      return (
        <View className="gap-3">
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Phone payments are paused">
            A recovery was cancelled by someone other than the phone that started it, so phone-only payments stay off until your {hardware.brand}{' '}
            confirms. You can still pay with your {hardware.brand}.
          </Notice>
          <AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Resume with ${hardware.brand}`} variant="outline" busy={busy} onPress={() => void run(wallet.resumePhoneSpending())} />
          <ActionNotice message={message} error={error} />
        </View>
      );
    }
    if (phoneSpending === 'retired' || retired) {
      const why =
        retired?.reason === 'reset'
          ? 'Your guardian was reset, so it no longer guards this wallet. Your phone and hardware wallet can still move the money: replace the guardian from Settings.'
          : retired?.reason === 'retired'
            ? 'This wallet was retired on your guardian, so the guardian co-signs nothing for it any more. Your hardware wallet can still approve payments.'
            : "A recovery moved this wallet's money to a new wallet, so this phone can no longer pay from it.";
      return (
        <Notice icon={Clock} tone="fill" title={retired?.reason === 'reset' ? 'Guardian reset' : 'This wallet was moved'}>
          {why}
        </Notice>
      );
    }
    return null;
  }
  const remaining = formatCountdown(new Date(recovery.completesAt).getTime() - now.getTime());
  const needsAnswer = recovery.origin === 'someone-else' && !recovery.acknowledged;
  return (
    <Pressable
      role="link"
      onPress={() => router.push(needsAnswer ? '/recover/alert' : '/recover/waiting')}
      accessibilityLabel={needsAnswer ? 'Someone started a recovery. Review it.' : `Recovery in progress, ${remaining} left`}>
      <Notice icon={needsAnswer ? TriangleAlert : Clock} iconClass={needsAnswer ? 'text-destructive' : 'text-warn'} tone="warn-outline" title={needsAnswer ? 'Someone started a recovery' : 'Recovery in progress'}>
        {needsAnswer ? 'Tap to review it and cancel if it was not you.' : `${remaining} until your money moves to the new wallet.`}
      </Notice>
    </Pressable>
  );
}

/**
 * After a recovery moved the wallet: the hardware wallet has to see the new wallet once (register it, show its first
 * address, confirm its key to the guardian). Until then it cannot approve payments or rule changes.
 */
export function HardwareConfirmCard() {
  const wallet = useWalletService();
  const { hardwareConfirmRequired, hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  if (!hardwareConfirmRequired) return null;
  return (
    <View className="gap-3">
      <Notice icon={HardwareWallet} iconClass="text-warn" tone="warn-outline" title={`Confirm on your ${hardware.brand}`}>
        Your recovered wallet is ready. Your {hardware.brand} needs to see it once: it registers the wallet, shows its first address and confirms its key
        to the guardian. Until then it can't approve payments or rule changes, and receiving waits.
      </Notice>
      <AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Confirm on ${hardware.brand}`} busy={busy} onPress={() => void run(wallet.confirmHardware())} />
      <ActionNotice message={message} error={error} />
    </View>
  );
}
