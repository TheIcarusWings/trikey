import { Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { cn } from '@/lib/utils';
import { pick } from '@/lib/platform';

/** QR codes stay black on white in both themes so any camera reads them. */
const QR_INK = '#111418';
const QR_PAPER = '#FFFFFF';

export function AddressQr({ address, size = pick(200, 216) }: { address: string; size?: number }) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="QR code for your receiving address"
      style={{ width: size + 32, height: size + 32 }}
      className="border-border self-center rounded-2xl border bg-white p-4">
      <QRCode value={`bitcoin:${address}`} size={size} color={QR_INK} backgroundColor={QR_PAPER} ecl="M" quietZone={0} />
    </View>
  );
}

const CORNER = 'absolute size-11 border-white';

/**
 * Camera viewfinder placeholder. The real scanner (expo-camera) replaces the inside of
 * this box later; the corner brackets, size and press target stay.
 */
export function ScanViewfinder({
  onScan,
  label,
  size = pick(264, 316),
}: {
  onScan: () => void;
  label: string;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onScan}
      role="button"
      accessibilityLabel={label}
      accessibilityHint="Prototype: double tap to continue with a demo code"
      style={{ width: size, height: size }}
      className="self-center rounded-3xl bg-[#1B1F24]">
      <View className={cn(CORNER, 'left-10 top-10 rounded-tl-xl border-l-4 border-t-4')} />
      <View className={cn(CORNER, 'right-10 top-10 rounded-tr-xl border-r-4 border-t-4')} />
      <View className={cn(CORNER, 'bottom-10 left-10 rounded-bl-xl border-b-4 border-l-4')} />
      <View className={cn(CORNER, 'bottom-10 right-10 rounded-br-xl border-b-4 border-r-4')} />
    </Pressable>
  );
}
