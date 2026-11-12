import { Linking, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { ScanFrame, type ScanFrameState } from '@/components/qr';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { QrCamera, useCameraPermissions } from './qr-camera';

export interface QrScannerProps {
  /** Called with every QR the camera reads, as text. The same QR arrives many times a second; the receiver decides what is new. */
  onFrame: (data: string) => void;
  /** Stop reading (the camera keeps showing). */
  paused?: boolean;
  /** Side of the square viewfinder. */
  size?: number;
  /** The corner frame's motion (pairing the guardian); without it the frame stands still. It never pauses the camera. */
  frame?: ScanFrameState;
}

/**
 * Camera viewfinder that reads QR codes (`QrCamera`: expo-camera, or the open source decoder in the Android build
 * without Google code). It asks for the camera permission itself and explains what to
 * do if it was refused. The corner brackets are `ScanViewfinder`'s, the placeholder it replaces.
 */
export function QrScanner({ onFrame, paused, size = pick(264, 316), frame }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();

  if (!permission) {
    return <View style={{ width: size, height: size }} className="self-center rounded-3xl bg-[#1B1F24]" accessibilityLabel="Starting the camera" />;
  }

  if (!permission.granted) {
    return (
      <View style={{ width: size }} className="items-center gap-3 self-center">
        <Text className="text-center text-base">Trikey needs the camera to scan the QR codes from your hardware wallet.</Text>
        {permission.canAskAgain ? (
          <AppButton title="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <>
            <Text className="text-muted-foreground text-center text-sm">The camera is turned off for Trikey. Turn it on in the phone's settings.</Text>
            <AppButton title="Open settings" variant="outline" onPress={() => void Linking.openSettings()} />
          </>
        )}
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityLabel="Camera. Point it at the QR code on your hardware wallet."
      style={{ width: size, height: size }}
      className="self-center overflow-hidden rounded-3xl bg-[#1B1F24]">
      <QrCamera size={size} onCode={paused ? undefined : onFrame} />
      <ScanFrame size={size} state={frame} />
    </View>
  );
}
