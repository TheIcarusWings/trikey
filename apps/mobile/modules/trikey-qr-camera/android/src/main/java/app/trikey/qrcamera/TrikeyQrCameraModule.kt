package app.trikey.qrcamera

import android.Manifest
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The QR camera of the FOSS Android build: the camera permission and the scanning view. */
class TrikeyQrCameraModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TrikeyQrCamera")

    AsyncFunction("getCameraPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("requestCameraPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    View(TrikeyQrCameraView::class) {
      Events("onCodeScanned", "onMountError")

      Prop("active") { view: TrikeyQrCameraView, active: Boolean? ->
        view.active = active ?: true
      }

      Prop("paused") { view: TrikeyQrCameraView, paused: Boolean? ->
        view.paused = paused ?: false
      }

      OnViewDestroys { view: TrikeyQrCameraView ->
        view.release()
      }
    }
  }
}
