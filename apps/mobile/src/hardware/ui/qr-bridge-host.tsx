import { useState, useSyncExternalStore } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { ProgressBar } from '@/components/progress';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { deviceFileIo } from '@/platform/device-files';
import { defaultQrBridge, type DeviceFileIo, type QrBridge, type QrFileRequest, type QrNoticeRequest, type QrScanRequest, type QrShowRequest } from '../qr/bridge';
import { AnimatedQr } from './animated-qr';
import { QrScanner } from './qr-scanner';

/** The current request of a bridge, re-rendered when it changes. `undefined` when nothing is on screen. */
export function useQrBridge(bridge: QrBridge = defaultQrBridge) {
  return useSyncExternalStore(bridge.subscribe, () => bridge.getSnapshot(), () => bridge.getSnapshot());
}

/** The numbered device steps and the notes under them. */
function Steps({ request }: { request: { steps?: string[]; notes?: string[] } }) {
  return (
    <>
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

function ShowRequest({ request, bridge }: { request: QrShowRequest; bridge: QrBridge }) {
  return (
    <>
      <AnimatedQr frames={request.frames} />
      {request.detail ? (
        <Text
          selectable
          accessibilityLabel={request.purpose === 'message' ? `The text to sign: ${request.detail}` : undefined}
          className={cn('text-foreground font-mono text-[13px] leading-[20px]', request.purpose === 'message' ? 'self-stretch text-left' : 'text-center')}>
          {request.detail}
        </Text>
      ) : null}
      <Steps request={request} />
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
 * A text to sign from a microSD card (Passport gen 2, Krux): save the request file to the card (or share it), sign on the
 * device, then open the signed file it wrote, or scan its signature QR where the device shows one (Krux).
 */
function FileRequest({ request, bridge, io, hint, saved }: { request: QrFileRequest; bridge: QrBridge; io: DeviceFileIo; hint?: string; saved?: boolean }) {
  const [busy, setBusy] = useState<'save' | 'share' | 'pick' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (what: 'save' | 'share' | 'pick', job: () => Promise<unknown>) => {
    setBusy(what);
    setProblem(null);
    try {
      await job();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {request.detail ? (
        <Text selectable accessibilityLabel={`The text to sign: ${request.detail}`} className="text-foreground self-stretch text-left font-mono text-[13px] leading-[20px]">
          {request.detail}
        </Text>
      ) : null}
      <Steps request={request} />
      <View className="gap-2 self-stretch">
        <AppButton
          title={saved ? `Save ${request.file.name} again` : `Save the file (${request.file.name})`}
          variant={saved ? 'outline' : 'primary'}
          busy={busy === 'save'}
          disabled={!!busy}
          onPress={() => void act('save', () => bridge.saveFile(io))}
        />
        <AppButton title="Share the file" variant="ghost" busy={busy === 'share'} disabled={!!busy} onPress={() => void act('share', () => bridge.shareFile(io))} />
        {saved ? <Text className="text-muted-foreground text-center text-sm leading-5">{`${request.file.name} handed over. Sign it on your device, then come back.`}</Text> : null}
        <AppButton title="Open the signed file" size="hero" variant={saved ? 'primary' : 'outline'} busy={busy === 'pick'} disabled={!!busy} onPress={() => void act('pick', () => bridge.pickFile(io))} />
        {request.acceptFrame ? (
          scanning ? (
            <QrScanner onFrame={(data) => bridge.submitFrame(data)} />
          ) : (
            <AppButton title="Scan the signature instead" variant="outline" disabled={!!busy} onPress={() => setScanning(true)} />
          )
        ) : null}
      </View>
      {hint ? <Text className="text-warn text-center text-sm leading-5">{hint}</Text> : null}
      {problem ? <Text className="text-warn text-center text-sm leading-5">{problem}</Text> : null}
      <AppButton title="Cancel" variant="ghost" onPress={() => bridge.cancel()} />
    </>
  );
}

/**
 * A step the owner must confirm: after a microSD round trip, the files to delete from the card, by name. One button and
 * no cancel (the signature is already taken; the bridge ignores a cancel, the system back gesture included).
 */
function NoticeRequest({ request, bridge }: { request: QrNoticeRequest; bridge: QrBridge }) {
  return (
    <>
      <View className="bg-muted gap-1 self-stretch rounded-lg px-3 py-2.5">
        {request.items.map((item) => (
          <Text key={item} selectable className="text-foreground font-mono text-[13px] leading-[20px]">
            {item}
          </Text>
        ))}
      </View>
      <Steps request={request} />
      <AppButton title={request.continueLabel} size="hero" onPress={() => bridge.acknowledge()} />
    </>
  );
}

/**
 * Renders what the QR signer asks for: an animated QR to scan with the device, the camera to scan the device's QR, or a
 * file to carry to the device on its microSD card and the signed file to bring back (`io`: the phone's file pickers), and
 * then the files to delete from the card.
 * Mount it once near the root of the app (inside the theme and safe-area providers); it shows a full-screen sheet while a
 * request is waiting and nothing otherwise. Pass the same `bridge` you gave `createHardwareProviders` (or none, to use the
 * default bridge, which is what the providers use when they are not given one).
 */
export function QrBridgeHost({ bridge = defaultQrBridge, io = deviceFileIo }: { bridge?: QrBridge; io?: DeviceFileIo }) {
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
              ) : request.type === 'file' ? (
                <FileRequest key={request.file.name} request={request} bridge={bridge} io={io} hint={snapshot?.hint} saved={snapshot?.saved} />
              ) : request.type === 'notice' ? (
                <NoticeRequest request={request} bridge={bridge} />
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
