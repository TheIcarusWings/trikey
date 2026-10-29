import { CameraView, useCameraPermissions } from 'expo-camera';
import { Linking, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export interface QrScannerProps {
  /** Called with every QR the camera reads, as text. The same QR arrives many times a second; the receiver decides what is new. */
  onFrame: (data: string) => void;
  /** Stop reading (the camera keeps showing). */
  paused?: boolean;
  /** Side of the square viewfinder. */
  size?: number;
}

const CORNER = 'absolute size-11 border-white';

/**
 * Camera viewfinder that reads QR codes with expo-camera. It asks for the camera permission itself and explains what to
 * do if it was refused. The corner brackets match `ScanViewfinder`, the placeholder it replaces.
 */
export function QrScanner({ onFrame, paused, size = pick(264, 316) }: QrScannerProps) {
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
      <CameraView
        style={{ width: size, height: size }}
        facing="back"
        active
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={paused ? undefined : (result) => onFrame(result.data)}
      />
      <View pointerEvents="none" className="absolute inset-0">
        <View className={cn(CORNER, 'left-10 top-10 rounded-tl-xl border-l-4 border-t-4')} />
        <View className={cn(CORNER, 'right-10 top-10 rounded-tr-xl border-r-4 border-t-4')} />
        <View className={cn(CORNER, 'bottom-10 left-10 rounded-bl-xl border-b-4 border-l-4')} />
        <View className={cn(CORNER, 'bottom-10 right-10 rounded-br-xl border-b-4 border-r-4')} />
      </View>
    </View>
  );
}
