import { Modal, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { HardwareWallet } from '@/components/icons';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The "Confirm on your device" sheet. Mounted once near the root: it appears whenever the wallet is waiting for the
 * hardware wallet, with the exact text or address the device will show, so the person can compare it with the
 * device's screen before approving. Nothing is shown when the wallet is not waiting for a device.
 */
export function DevicePromptHost() {
  const { devicePrompt: prompt, hardware } = useWallet();
  const wallet = useWalletService();
  const insets = useScreenInsets();

  return (
    <Modal
      visible={!!prompt}
      transparent
      animationType="slide"
      onRequestClose={() => wallet.cancelDevicePrompt()}
      statusBarTranslucent>
      <View className="flex-1 justify-end bg-black/40" accessibilityViewIsModal>
        <View
          className={cn('bg-background gap-4 border-t', 'border-border', pick('rounded-t-[20px]', 'rounded-t-[28px]'))}
          style={{ paddingHorizontal: GUTTER, paddingTop: 20, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="flex-row items-center gap-3">
            <View className="bg-secondary size-11 items-center justify-center rounded-xl">
              <Icon as={HardwareWallet} size={24} className="text-foreground" strokeWidth={1.8} />
            </View>
            <View className="flex-1">
              <Text role="heading" aria-level={2} className={cn(pick('text-[20px] font-semibold leading-[26px]', 'text-xl font-medium leading-7'))}>
                {prompt?.title ?? 'Confirm on your device'}
              </Text>
              <Text className="text-muted-foreground text-sm leading-5">Your {hardware.brand}</Text>
            </View>
          </View>
          {prompt?.detail ? (
            <Card className="px-4 py-3">
              <Text selectable className="font-mono text-[13px] leading-5">
                {prompt.detail}
              </Text>
            </Card>
          ) : null}
          {prompt?.hint ? <Text className="text-sm leading-5">{prompt.hint}</Text> : null}
          <View className="flex-row items-center gap-2.5" accessibilityLiveRegion="polite">
            <View className="bg-warn size-2 rounded-full" />
            <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
              Waiting for your {hardware.brand}{'…'}
            </Text>
          </View>
          <AppButton title="Cancel" variant="outline" onPress={() => wallet.cancelDevicePrompt()} />
        </View>
      </View>
    </Modal>
  );
}
