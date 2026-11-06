import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, ScrollView, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { BitBoxBridge } from '../bitbox02/bridge';
import { defaultBitBoxBridge } from '../bitbox02/default';

/** What the BitBox02 bridge shows right now, re-rendered when it changes. `undefined` when nothing is on screen. */
export function useBitBoxBridge(bridge: BitBoxBridge = defaultBitBoxBridge) {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
}

/**
 * Renders what the BitBox02 provider shows while it finds, unlocks and pairs a BitBox02 ("Enter your password on the
 * BitBox02"), and the first time the pairing code, large, to compare with the BitBox02's screen (the owner confirms it
 * there). Mount it once near the root of the app, next to `JadeBleBridgeHost`; it shows a sheet only while there is
 * something to show.
 */
export function BitBox02BridgeHost({ bridge = defaultBitBoxBridge }: { bridge?: BitBoxBridge }) {
  const screen = useBitBoxBridge(bridge);
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
              {screen.code ? (
                <View className="border-border self-stretch rounded-xl border px-4 py-5" accessible accessibilityLabel={`Pairing code: ${screen.code.replace(/\s+/g, ' ').split('').join(' ')}`}>
                  <Text selectable className="text-foreground text-center font-mono text-[26px] leading-[38px] tracking-widest">
                    {screen.code}
                  </Text>
                </View>
              ) : null}
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
              <View className="gap-2 self-stretch">
                <View className="flex-row items-center justify-center gap-2.5 py-2" accessibilityLiveRegion="polite">
                  <ActivityIndicator />
                  <Text className="text-foreground text-base leading-6">{screen.code ? 'Confirm on your BitBox02…' : 'Waiting for your BitBox02…'}</Text>
                </View>
                <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
              </View>
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
