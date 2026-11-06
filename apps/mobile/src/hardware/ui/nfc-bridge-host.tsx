import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, ScrollView, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { NfcBridge, NfcRequest, NfcTapState } from '../nfc/bridge';
import { defaultNfcBridge } from '../nfc/default';

/** The current request of an NFC bridge, re-rendered when it changes. `undefined` when nothing is on screen. */
export function useNfcBridge(bridge: NfcBridge = defaultNfcBridge) {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
}

function Steps({ request }: { request: NfcRequest }) {
  return (
    <>
      {request.detail ? (
        <Text
          selectable
          accessibilityLabel={request.type === 'write' && request.purpose === 'message' ? `The text to sign: ${request.detail}` : undefined}
          className="text-foreground self-stretch text-left font-mono text-[13px] leading-[20px]">
          {request.detail}
        </Text>
      ) : null}
      {request.steps?.length ? (
        <View className="gap-2 self-stretch pl-5">
          {request.steps.map((step, i) => (
            <View key={step} className="flex-row">
              <Text className="-ml-5 w-5 text-base leading-6">{i + 1}.</Text>
              <Text className="flex-1 text-base leading-6">{step}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {request.notes?.length ? (
        <View className="gap-1.5 self-stretch">
          {request.notes.map((note) => (
            <Text key={note} selectable className="text-muted-foreground text-sm leading-5">
              {note}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

function Actions({ request, state, bridge, systemSheet }: { request: NfcRequest; state: NfcTapState; bridge: NfcBridge; systemSheet: boolean }) {
  if (request.type === 'show')
    return (
      <View className="gap-2 self-stretch">
        <AppButton title={request.continueLabel} size="hero" onPress={() => bridge.finishShow()} />
        <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
      </View>
    );
  return (
    <View className="gap-2 self-stretch">
      {state.busy && !systemSheet ? (
        // Android shows nothing while it waits for the tag: say it here.
        <View className="flex-row items-center justify-center gap-2.5 py-2" accessibilityLiveRegion="polite">
          <ActivityIndicator />
          <Text className="text-foreground text-base leading-6">Hold the phone to the Coldcard…</Text>
        </View>
      ) : null}
      {state.hint ? (
        <Text className="text-warn text-center text-sm leading-5" accessibilityLiveRegion="polite">
          {state.hint}
        </Text>
      ) : null}
      {state.nfcOff ? <AppButton title="Open NFC settings" variant="outline" onPress={() => void bridge.openSettings()} /> : null}
      <AppButton title={state.hint ? 'Try again' : request.actionLabel} size="hero" disabled={state.busy} onPress={() => void bridge.tap()} />
      <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
    </View>
  );
}

/**
 * Renders what the NFC signer asks for: the steps on the Coldcard, then a button that holds the phone to it (writing or
 * reading over NFC), or an address to compare. Mount it once near the root of the app, next to `QrBridgeHost`; it shows
 * a full-screen sheet while a request is waiting and nothing otherwise.
 */
export function NfcBridgeHost({ bridge = defaultNfcBridge }: { bridge?: NfcBridge }) {
  const snapshot = useNfcBridge(bridge);
  const insets = useScreenInsets();
  const request = snapshot?.request;

  return (
    <Modal visible={!!request} animationType="slide" presentationStyle={IS_IOS ? 'pageSheet' : 'fullScreen'} onRequestClose={() => bridge.cancel()} statusBarTranslucent>
      <View className="bg-background flex-1">
        <ScrollView
          contentContainerStyle={{ alignItems: 'center', gap: 20, paddingHorizontal: GUTTER, paddingTop: Math.max(insets.top, 24), paddingBottom: insets.bottom + 16 }}
          keyboardShouldPersistTaps="handled">
          {request && snapshot ? (
            <>
              <View className="gap-2 self-stretch">
                <Text role="heading" className={cn('text-foreground font-semibold', pick('text-[28px] leading-[34px]', 'text-[24px] leading-[32px]'))}>
                  {request.title}
                </Text>
                <Text className="text-muted-foreground text-base leading-6">{request.instructions}</Text>
              </View>
              <Steps request={request} />
              <Actions request={request} state={snapshot} bridge={bridge} systemSheet={bridge.transport.systemSheet} />
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
