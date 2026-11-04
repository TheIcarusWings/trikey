import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowDownLeft } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { useHapticOnce } from '@/lib/haptics';

/**
 * The short note over every screen (`WalletState.toast`): "Incoming 2,000 sats · unconfirmed", the moment the guardian
 * sees a payment come in, from this phone or any other device. It goes away by itself after a few seconds; a tap hides
 * it sooner. Read out by screen readers as it appears; felt once as `light`.
 */
export function ToastHost() {
  const { toast } = useWallet();
  const service = useWalletService();
  const insets = useSafeAreaInsets();
  useHapticOnce('light', !!toast, toast?.id);
  if (!toast) return null;
  return (
    <View pointerEvents="box-none" className="absolute right-0 left-0 items-center px-4" style={{ top: insets.top + 8 }}>
      <Pressable
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel={toast.text}
        accessibilityHint="Hides this note"
        onPress={() => service.dismissToast?.()}
        className="bg-foreground flex-row items-center gap-2 rounded-full px-4 py-2.5 shadow-md"
        testID="toast"
      >
        <Icon as={ArrowDownLeft} size={16} className="text-background" strokeWidth={2.2} />
        <Text className="text-background text-[14px] leading-[18px] font-medium">{toast.text}</Text>
      </Pressable>
    </View>
  );
}
