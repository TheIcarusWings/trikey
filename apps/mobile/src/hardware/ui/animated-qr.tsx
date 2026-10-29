import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';

/** QR codes stay black on white in both themes so any camera reads them (same as AddressQr). */
const QR_INK = '#111418';
const QR_PAPER = '#FFFFFF';

export interface AnimatedQrProps {
  /** The QR frames to cycle through. One frame is shown as a still QR. */
  frames: readonly string[];
  /** Size of the QR itself in points. */
  size?: number;
  /** Time each frame stays up. 250 ms is the rate the Coldcard Q is tuned for; UR devices cope with 150 to 300. */
  intervalMs?: number;
  /** What the QR is, for screen readers. */
  accessibilityLabel?: string;
  /** Hide the "Frame 3 of 12" caption. */
  hideCaption?: boolean;
}

/**
 * Shows a series of QR codes in a loop, for an air-gapped device to scan (a PSBT, a wallet to register).
 * Tap to pause on one frame, tap again to go on. Error correction is at the lowest level: the screen is perfect, and
 * a smaller code is easier for a small camera to read.
 */
export function AnimatedQr({ frames, size = pick(264, 280), intervalMs = 250, accessibilityLabel = 'QR code to scan with your hardware wallet', hideCaption }: AnimatedQrProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = frames.length;
  const animated = count > 1;

  useEffect(() => {
    setIndex(0);
  }, [frames]);

  useEffect(() => {
    if (!animated || paused) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), intervalMs);
    return () => clearInterval(id);
  }, [animated, paused, count, intervalMs]);

  const current = frames[Math.min(index, count - 1)] ?? '';

  return (
    <View className="items-center gap-3">
      <Pressable
        role="img"
        accessibilityLabel={animated ? `${accessibilityLabel}. Frame ${index + 1} of ${count}. Double tap to ${paused ? 'resume' : 'pause'}.` : accessibilityLabel}
        disabled={!animated}
        onPress={() => setPaused((p) => !p)}
        style={{ width: size + 32, height: size + 32 }}
        className="border-border items-center justify-center self-center rounded-2xl border bg-white p-4">
        {current ? <QRCode value={current} size={size} color={QR_INK} backgroundColor={QR_PAPER} ecl="L" quietZone={0} /> : null}
      </Pressable>
      {animated && !hideCaption ? (
        <View className="items-center gap-1.5">
          <View className="flex-row gap-1" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {frames.length <= 24
              ? frames.map((_, i) => <View key={i} className={i === index ? 'bg-foreground size-1.5 rounded-full' : 'bg-border size-1.5 rounded-full'} />)
              : null}
          </View>
          <Text className="text-muted-foreground text-[13px] leading-[18px]">
            {paused ? 'Paused. Tap to go on.' : `Frame ${index + 1} of ${count}. Tap to pause.`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
