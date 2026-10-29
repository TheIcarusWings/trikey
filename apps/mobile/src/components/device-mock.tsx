import { View } from 'react-native';
import { Text } from '@/components/ui/text';

export type DeviceLine = string | { text: string; muted?: boolean };

/**
 * What the hardware wallet's own screen shows at this step, drawn as a small device.
 * The first line is the title. The user compares it against the phone.
 */
export function DeviceMock({
  lines,
  width = 200,
  height = 132,
  lineHeight = 14,
  label,
}: {
  lines: DeviceLine[];
  width?: number;
  height?: number;
  lineHeight?: number;
  /** Spoken description, e.g. "Ledger screen showing: Register wallet?". */
  label: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width, height }}
      className="bg-device mt-3 self-center rounded-[20px] p-[18px]">
      <View className="bg-device-screen flex-1 justify-center gap-1 rounded-lg p-2.5">
        {lines.map((line, i) => {
          const text = typeof line === 'string' ? line : line.text;
          const muted = typeof line === 'string' ? false : line.muted;
          return (
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
        })}
      </View>
    </View>
  );
}
