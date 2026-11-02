// JavaScript side of the QR camera of the Android build without Google code (apps/mobile/README.md, "Two Android
// builds"). Only the FOSS Android bundle imports it
// (src/hardware/ui/qr-camera.android.foss.tsx); the native module is not in any other build.
import { createPermissionHook, requireNativeModule, requireNativeView, type PermissionResponse } from 'expo';
import type { ViewProps } from 'react-native';
import type { CodeScannedEvent, MountErrorEvent } from './events';

export { codeFromEvent, mountErrorMessage, type CodeScannedEvent, type MountErrorEvent } from './events';

export interface QrCameraViewProps extends ViewProps {
  /** Run the camera (default true). */
  active?: boolean;
  /** Keep the preview but stop decoding. */
  paused?: boolean;
  /** Every QR code read, as often as the camera sees it. */
  onCodeScanned?: (event: CodeScannedEvent) => void;
  /** The camera could not be started. */
  onMountError?: (event: MountErrorEvent) => void;
}

interface TrikeyQrCameraModule {
  getCameraPermissionsAsync(): Promise<PermissionResponse>;
  requestCameraPermissionsAsync(): Promise<PermissionResponse>;
}

const native = requireNativeModule<TrikeyQrCameraModule>('TrikeyQrCamera');

/** The camera preview that reads QR codes. */
export const QrCameraView = requireNativeView<QrCameraViewProps>('TrikeyQrCamera');

/** Same shape as expo-camera's `useCameraPermissions`: `[permission, request, get]`. */
export const useCameraPermissions = createPermissionHook({
  getMethod: () => native.getCameraPermissionsAsync(),
  requestMethod: () => native.requestCameraPermissionsAsync(),
});
