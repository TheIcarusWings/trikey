// The camera behind `QrScanner` in the Android build without Google code (TRIKEY_ANDROID_VARIANT=foss): the app's own
// module, CameraX with the open source zxing-cpp decoder (modules/trikey-qr-camera). metro.config.js bundles this file
// in place of qr-camera.tsx for that build only; it exports the same things.
import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { QrCameraView, codeFromEvent, mountErrorMessage, useCameraPermissions } from '../../../modules/trikey-qr-camera';
import type { QrCameraProps } from './qr-camera';

export { useCameraPermissions };
export type { QrCameraProps };

export function QrCamera({ size, onCode }: QrCameraProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ width: size, height: size }}>
      <QrCameraView
        style={{ width: size, height: size }}
        active
        paused={!onCode}
        onCodeScanned={(event) => {
          const data = codeFromEvent(event);
          if (data !== null) onCode?.(data);
        }}
        onMountError={(event) => setError(mountErrorMessage(event))}
      />
      {error ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center p-6">
          <Text className="text-center text-sm text-white">{error}</Text>
        </View>
      ) : null}
    </View>
  );
}
