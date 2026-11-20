import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Rise, reducedFade, standard, useReduceMotion, useRing, useShake } from '@/components/motion';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { DEVICE_LINES, DEVICE_RING } from '@/theme/motion';

export type DeviceLine = string | { text: string; muted?: boolean };

/** Where the device is in its approval: asked, approved (signed), or declined (or failed). */
export type DeviceStatus = 'waiting' | 'approved' | 'declined';

/**
 * What the hardware wallet's own screen shows at this step, drawn as a small device.
 * The first line is the title. The user compares it against the phone.
 *
 * With `status` (docs/design/motion.md, section 2): while it waits, a ring leaves the device's outline every 2.4s;
 * approved, the ring stops and the outline turns green; declined, the device shakes once and the outline turns red.
 * With `animateIn`, its lines appear one after another as it mounts. No check is drawn on the device.
 */
export function DeviceMock({
  lines,
  width = 200,
  height = 132,
  lineHeight = 14,
  label,
  status,
  animateIn = false,
}: {
  lines: DeviceLine[];
  width?: number;
  height?: number;
  lineHeight?: number;
  /** Spoken description, e.g. "Ledger screen showing: Register wallet?". */
  label: string;
  status?: DeviceStatus;
  animateIn?: boolean;
}) {
  const body = (
    <View className="bg-device-screen flex-1 justify-center gap-1 rounded-lg p-2.5">
      {lines.map((line, i) => {
        const text = typeof line === 'string' ? line : line.text;
        const muted = typeof line === 'string' ? false : line.muted;
        const shown = (
          <Text
            key={i}
            style={{
              fontSize: 11,
              lineHeight,
              fontFamily: i === 0 ? 'GeistMono-Medium' : 'GeistMono',
              color: muted ? '#4A5058' : undefined,
            }}
            className="text-device-ink">
            {text}
          </Text>
        );
        return animateIn ? (
          <Rise key={i} delay={i * DEVICE_LINES.stepMs} distance={DEVICE_LINES.rise} duration={DEVICE_LINES.durationMs}>
            {shown}
          </Rise>
        ) : (
          shown
        );
      })}
    </View>
  );

  if (!status) {
    return (
      <View accessible accessibilityLabel={label} style={{ width, height }} className="bg-device mt-3 self-center rounded-[20px] p-[18px]">
        {body}
      </View>
    );
  }
  return (
    <AnimatedDevice width={width} height={height} label={label} status={status}>
      {body}
    </AnimatedDevice>
  );
}

function AnimatedDevice({ width, height, label, status, children }: { width: number; height: number; label: string; status: DeviceStatus; children: ReactNode }) {
  const reduced = useReduceMotion();
  const ring = useRing(status === 'waiting', 'activity', DEVICE_RING);
  const { style: shaking, shake } = useShake();
  // The outline: none while it waits, green once approved, red once declined (240ms).
  const outline = useSharedValue(status === 'waiting' ? 0 : 1);
  useEffect(() => {
    const to = status === 'waiting' ? 0 : 1;
    outline.value = reduced ? reducedFade(to) : standard(to);
    if (status === 'declined') shake();
  }, [status, reduced, outline, shake]);
  const outlined = useAnimatedStyle(() => ({ opacity: outline.value }));
  // Both rings sit just outside the device, as a 2px outline would.
  const edge = { position: 'absolute', top: -2, left: -2, right: -2, bottom: -2 } as const;
  return (
    <Animated.View accessible accessibilityLabel={label} style={[{ width, height, marginTop: 12, alignSelf: 'center' }, shaking]}>
      <Animated.View style={[edge, ring]} pointerEvents="none">
        <View className="border-warn size-full rounded-[22px] border-2" />
      </Animated.View>
      <View className="bg-device size-full rounded-[20px] p-[18px]">{children}</View>
      <Animated.View style={[edge, outlined]} pointerEvents="none">
        <View className={cn('size-full rounded-[22px] border-2', status === 'declined' ? 'border-destructive' : 'border-good')} />
      </Animated.View>
    </Animated.View>
  );
}
