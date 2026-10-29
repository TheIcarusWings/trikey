import { useSyncExternalStore } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { ProgressBar } from '@/components/progress';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { defaultQrBridge, type QrBridge, type QrScanRequest, type QrShowRequest } from '../qr/bridge';
import { AnimatedQr } from './animated-qr';
import { QrScanner } from './qr-scanner';

/** The current request of a bridge, re-rendered when it changes. `undefined` when nothing is on screen. */
export function useQrBridge(bridge: QrBridge = defaultQrBridge) {
  return useSyncExternalStore(bridge.subscribe, () => bridge.getSnapshot(), () => bridge.getSnapshot());
}

function ShowRequest({ request, bridge }: { request: QrShowRequest; bridge: QrBridge }) {
  return (
    <>
      <AnimatedQr frames={request.frames} />
      {request.detail ? (
        <Text selectable className="text-foreground text-center font-mono text-[13px] leading-[20px]">
          {request.detail}
        </Text>
      ) : null}
      <View className="gap-2 self-stretch">
        <AppButton title={request.continueLabel} size="hero" onPress={() => bridge.finishShow()} />
        <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
      </View>
    </>
  );
}

function ScanRequest({ request, bridge, progress, hint }: { request: QrScanRequest; bridge: QrBridge; progress?: { fraction: number; received: number; total?: number }; hint?: string }) {
  return (
    <>
      <QrScanner onFrame={(data) => bridge.submitFrame(data)} />
      {progress && progress.received > 0 ? (
        <View className="gap-1.5 self-stretch">
          <ProgressBar fraction={progress.fraction} label={`Scanned ${progress.received}${progress.total ? ` of ${progress.total}` : ''} parts`} />
          <Text className="text-muted-foreground text-center text-[13px] leading-[18px]">
            {progress.total ? `Part ${progress.received} of ${progress.total}. Keep the camera on the code.` : 'Keep the camera on the code.'}
          </Text>
        </View>
      ) : null}
      {hint ? <Text className="text-warn text-center text-sm leading-5">{hint}</Text> : null}
      <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
    </>
  );
}

/**
 * Renders what the QR signer asks for: an animated QR to scan with the device, or the camera to scan the device's QR.
 * Mount it once near the root of the app (inside the theme and safe-area providers); it shows a full-screen sheet while a
 * request is waiting and nothing otherwise. Pass the same `bridge` you gave `createHardwareProviders` (or none, to use the
 * default bridge, which is what the providers use when they are not given one).
 */
export function QrBridgeHost({ bridge = defaultQrBridge }: { bridge?: QrBridge }) {
  const snapshot = useQrBridge(bridge);
  const insets = useScreenInsets();
  const request = snapshot?.request;

  return (
    <Modal
      visible={!!request}
      animationType="slide"
      presentationStyle={IS_IOS ? 'pageSheet' : 'fullScreen'}
      onRequestClose={() => bridge.cancel()}
      statusBarTranslucent>
      <View className="bg-background flex-1">
        <ScrollView
          contentContainerStyle={{ alignItems: 'center', gap: 20, paddingHorizontal: GUTTER, paddingTop: Math.max(insets.top, 24), paddingBottom: insets.bottom + 16 }}
          keyboardShouldPersistTaps="handled">
          {request ? (
            <>
              <View className="gap-2 self-stretch">
                <Text role="heading" className={cn('text-foreground font-semibold', pick('text-[28px] leading-[34px]', 'text-[24px] leading-[32px]'))}>
                  {request.title}
                </Text>
                <Text className="text-muted-foreground text-base leading-6">{request.instructions}</Text>
              </View>
              {request.type === 'show' ? (
                <ShowRequest request={request} bridge={bridge} />
              ) : (
                <ScanRequest request={request} bridge={bridge} progress={snapshot?.progress} hint={snapshot?.hint} />
              )}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
