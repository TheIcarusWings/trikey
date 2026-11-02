// The camera behind `QrScanner` on iOS and in the standard Android build: expo-camera, which reads QR codes with the
// phone's own scanner (Apple's Vision on iOS, Google's ML Kit on Android). The Android build without Google code
// bundles qr-camera.android.foss.tsx in its place (metro.config.js); both files export the same things.
import { CameraView, useCameraPermissions } from 'expo-camera';

export { useCameraPermissions };

export interface QrCameraProps {
  /** Side of the square preview. */
  size: number;
  /** Every QR read, as text; undefined stops reading (the preview stays). */
  onCode?: (data: string) => void;
}

export function QrCamera({ size, onCode }: QrCameraProps) {
  return (
    <CameraView
      style={{ width: size, height: size }}
      facing="back"
      active
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={onCode ? (result) => onCode(result.data) : undefined}
    />
  );
}
