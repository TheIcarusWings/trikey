import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, ScrollView, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { JadeBleBridge, JadeBridgeScreen } from '../jade/bridge';
import { defaultJadeBleBridge } from '../jade/default';

/** What the Jade bridge shows right now, re-rendered when it changes. `undefined` when nothing is on screen. */
export function useJadeBleBridge(bridge: JadeBleBridge = defaultJadeBleBridge) {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
}

function Body({ screen }: { screen: JadeBridgeScreen }) {
  return (
    <>
      {screen.steps?.length ? (
        <View className="gap-2 self-stretch pl-5">
          {screen.steps.map((step, i) => (
            <View key={step} className="flex-row">
              <Text className="-ml-5 w-5 text-base leading-6">{i + 1}.</Text>
              <Text className="flex-1 text-base leading-6">{step}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {screen.notes?.length ? (
        <View className="gap-1.5 self-stretch">
          {screen.notes.map((note) => (
            <Text key={note} selectable className="text-muted-foreground text-sm leading-5">
              {note}
            </Text>
          ))}
        </View>
      ) : null}
      {screen.hint ? (
        <Text className="text-warn self-stretch text-sm leading-5" accessibilityLiveRegion="polite">
          {screen.hint}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Renders what the Jade provider shows while it finds, pairs and unlocks a Jade over Bluetooth ("Enter your PIN on the
 * Jade"), and the PIN-server notice before the first unlock. Mount it once near the root of the app, next to
 * `NfcBridgeHost`; it shows a sheet while there is something to show and nothing otherwise.
 */
export function JadeBleBridgeHost({ bridge = defaultJadeBleBridge }: { bridge?: JadeBleBridge }) {
  const screen = useJadeBleBridge(bridge);
  const insets = useScreenInsets();

  return (
    <Modal visible={!!screen} animationType="slide" presentationStyle={IS_IOS ? 'pageSheet' : 'fullScreen'} onRequestClose={() => bridge.cancel()} statusBarTranslucent>
      <View className="bg-background flex-1">
        <ScrollView
          contentContainerStyle={{ alignItems: 'center', gap: 20, paddingHorizontal: GUTTER, paddingTop: Math.max(insets.top, 24), paddingBottom: insets.bottom + 16 }}
          keyboardShouldPersistTaps="handled">
          {screen ? (
            <>
              <View className="gap-2 self-stretch">
                <Text role="heading" className={cn('text-foreground font-semibold', pick('text-[28px] leading-[34px]', 'text-[24px] leading-[32px]'))}>
                  {screen.title}
                </Text>
                <Text className="text-muted-foreground text-base leading-6">{screen.instructions}</Text>
              </View>
              <Body screen={screen} />
              {screen.type === 'confirm' ? (
                <View className="gap-2 self-stretch">
                  <AppButton title={screen.continueLabel} size="hero" onPress={() => bridge.proceed()} />
                  <AppButton title={screen.cancelLabel} variant="ghost" onPress={() => bridge.cancel()} />
                </View>
              ) : (
                <View className="gap-2 self-stretch">
                  <View className="flex-row items-center justify-center gap-2.5 py-2" accessibilityLiveRegion="polite">
                    <ActivityIndicator />
                    <Text className="text-foreground text-base leading-6">Waiting for your Jade…</Text>
                  </View>
                  <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
                </View>
              )}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
