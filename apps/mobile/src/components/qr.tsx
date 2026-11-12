import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';
import { Breathe, HIDDEN, reducedFade, spring, standard, useReduceMotion } from '@/components/motion';
import { pick } from '@/lib/platform';
import { PAIRING } from '@/theme/motion';
import { palette } from '@/theme/tokens';

/** QR codes stay black on white in both themes so any camera reads them. */
const QR_INK = '#111418';
const QR_PAPER = '#FFFFFF';

export function AddressQr({
  address,
  size = pick(200, 216),
  uri,
  label = 'your receiving address',
}: {
  address: string;
  size?: number;
  /** What the code holds. Default `bitcoin:<address>`; a silent payment address goes in as it is, which every wallet that knows them reads. */
  uri?: string;
  /** For screen readers: "QR code for <label>". */
  label?: string;
}) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`QR code for ${label}`}
      style={{ width: size + 32, height: size + 32 }}
      className="border-border self-center rounded-2xl border bg-white p-4">
      <QRCode value={uri ?? `bitcoin:${address}`} size={size} color={QR_INK} backgroundColor={QR_PAPER} ecl="M" quietZone={0} />
    </View>
  );
}

/**
 * Camera viewfinder placeholder. The real scanner (expo-camera) replaces the inside of
 * this box later; the corner brackets, size and press target stay.
 */
export function ScanViewfinder({
  onScan,
  label,
  size = pick(264, 316),
  frame,
}: {
  onScan: () => void;
  label: string;
  size?: number;
  /** The corner frame's motion (pairing the guardian); without it the frame stands still. */
  frame?: ScanFrameState;
}) {
  return (
    <Pressable
      onPress={onScan}
      role="button"
      accessibilityLabel={label}
      accessibilityHint="Prototype: double tap to continue with a demo code"
      style={{ width: size, height: size }}
      className="self-center rounded-3xl bg-[#1B1F24]">
      <ScanFrame size={size} state={frame} />
    </Pressable>
  );
}

/**
 * Where a scan is (docs/design/motion.md, section 4): `scanning` breathes; `reading` closes onto the code and dims the
 * camera picture; `paired` stays closed and turns green.
 */
export type ScanFrameState = 'scanning' | 'reading' | 'paired';

const CORNER = { size: 44, inset: 40, border: 4, radius: 12 } as const;

/** One corner: its colour, and how far it has moved toward the middle (`sx`, `sy`: which way that is). */
function useCornerStyle(green: SharedValue<number>, close: SharedValue<number>, travel: number, sx: 1 | -1, sy: 1 | -1) {
  return useAnimatedStyle(() => ({
    borderColor: interpolateColor(green.value, [0, 1], [FRAME_WHITE, FRAME_GREEN]),
    transform: [{ translateX: sx * travel * close.value }, { translateY: sy * travel * close.value }],
  }));
}
/** The corners stay white on the dark viewfinder in both themes; paired, they take the dark theme's green. */
const FRAME_WHITE = '#FFFFFF';
const FRAME_GREEN = palette.dark.good;

/**
 * The four white corner brackets over a viewfinder (and, while a code is read, a veil that dims the camera picture).
 * With a `state` they move: they breathe while scanning (2.4s), close onto the code with the scan-frame spring once it
 * is read, turn green when paired, and open back out when it is refused. Without one they stand still, as they always
 * did. Never takes touches and never holds up the camera. Reduce Motion: they stay where they are and only their colour
 * and the veil fade (150ms).
 */
export function ScanFrame({ size, state }: { size: number; state?: ScanFrameState }) {
  const reduced = useReduceMotion();
  const closed = state === 'reading' || state === 'paired';
  const paired = state === 'paired';
  const close = useSharedValue(closed && !reduced ? 1 : 0);
  const green = useSharedValue(paired ? 1 : 0);
  const veil = useSharedValue(closed ? 1 : 0);
  useEffect(() => {
    if (reduced) {
      close.value = 0;
      green.value = reducedFade(paired ? 1 : 0);
      veil.value = reducedFade(closed ? 1 : 0);
      return;
    }
    close.value = spring(closed ? 1 : 0, 'scanFrame');
    green.value = standard(paired ? 1 : 0);
    veil.value = standard(closed ? 1 : 0);
  }, [closed, paired, reduced, close, green, veil]);

  // How far each corner travels toward the middle to close the frame to 68% of its side.
  const travel = ((size - 2 * CORNER.inset) * (1 - PAIRING.closeTo)) / 2;
  const topLeft = useCornerStyle(green, close, travel, 1, 1);
  const topRight = useCornerStyle(green, close, travel, -1, 1);
  const bottomLeft = useCornerStyle(green, close, travel, 1, -1);
  const bottomRight = useCornerStyle(green, close, travel, -1, -1);
  const dim = useAnimatedStyle(() => ({ opacity: PAIRING.dimTo * veil.value }));

  const base = { position: 'absolute', width: CORNER.size, height: CORNER.size } as const;
  const { inset: i, border: b, radius: r } = CORNER;
  return (
    <View style={StyleSheet.absoluteFill} {...HIDDEN}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000', borderRadius: 24 }, dim]} />
      <Breathe active={state === 'scanning'} style={StyleSheet.absoluteFill}>
        <Animated.View style={[base, { left: i, top: i, borderLeftWidth: b, borderTopWidth: b, borderTopLeftRadius: r }, topLeft]} />
        <Animated.View style={[base, { right: i, top: i, borderRightWidth: b, borderTopWidth: b, borderTopRightRadius: r }, topRight]} />
        <Animated.View style={[base, { left: i, bottom: i, borderLeftWidth: b, borderBottomWidth: b, borderBottomLeftRadius: r }, bottomLeft]} />
        <Animated.View style={[base, { right: i, bottom: i, borderRightWidth: b, borderBottomWidth: b, borderBottomRightRadius: r }, bottomRight]} />
      </Breathe>
    </View>
  );
}
