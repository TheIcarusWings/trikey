import { useEffect, useState } from 'react';
import { AppState, Modal, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { HardwareWallet } from '@/components/icons';
import { WaitingStatus } from '@/components/motion';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { promptDetailText, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The "Confirm on your device" sheet. Mounted once near the root: it appears whenever the wallet is waiting for the
 * hardware wallet, with the exact text or address the device will show, so the person can compare it with the
 * device's screen before approving. Nothing is shown when the wallet is not waiting for a device.
 *
 * The sheet only appears or goes while the app is in front. A Trezor answers through Trezor Suite Lite, so its reply,
 * and the next request's prompt, come while Trikey is in the background: on iOS a `Modal` shown and hidden then (within
 * milliseconds, for a key the phone already holds) leaves an invisible layer that takes every touch, and the screen
 * under it looks frozen (found on an iPhone with a Trezor Safe 7). A change made in the background is applied when the
 * app comes back.
 */
export function DevicePromptHost() {
  const { devicePrompt: prompt, hardware } = useWallet();
  const wallet = useWalletService();
  const insets = useScreenInsets();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [shown, setShown] = useState(!!prompt);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (appActive) setShown(!!prompt);
  }, [prompt, appActive]);

  return (
    <Modal
      visible={shown}
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
                {promptDetailText(prompt.detail)}
              </Text>
            </Card>
          ) : null}
          {prompt?.hint ? <Text className="text-sm leading-5">{prompt.hint}</Text> : null}
          {prompt?.continueLabel ? (
            <>
              {/* A Trezor answers through Trezor Suite Lite, which takes the screen: this is read here first. The Trezor
                  keeps what it shows on its own screen until it is confirmed there. */}
              <Text className="text-muted-foreground text-sm leading-5">
                Read this first: Trezor Suite opens next. Then compare it with your {hardware.brand}&apos;s screen before you confirm there.
              </Text>
              <AppButton title={prompt.continueLabel} onPress={() => wallet.proceedDevicePrompt()} />
            </>
          ) : (
            // The same waiting line as on the payment screens: the amber dot breathes while the device is asked.
            <WaitingStatus className="justify-start" tone="waiting" text={`Waiting for your ${hardware.brand}…`} textClassName={pick('text-[15px] leading-5', 'text-sm leading-5')} />
          )}
          <AppButton title="Cancel" variant="outline" onPress={() => wallet.cancelDevicePrompt()} />
        </View>
      </View>
    </Modal>
  );
}
