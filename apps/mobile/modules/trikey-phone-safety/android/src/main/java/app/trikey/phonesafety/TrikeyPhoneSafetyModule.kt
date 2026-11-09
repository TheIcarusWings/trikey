package app.trikey.phonesafety

import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What the phone-safety note needs that Expo does not offer: the date of the last Android security patch
 * (`Build.VERSION.SECURITY_PATCH`, "YYYY-MM-DD"). Read on the phone and kept there; nothing is sent anywhere.
 *
 * And `setScreenSecure`: FLAG_SECURE on the app's window while a screen shows a secret (the backup's recovery code), so
 * Android leaves it out of screenshots, screen recordings and the recents thumbnail.
 */
class TrikeyPhoneSafetyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TrikeyPhoneSafety")

    Constant("securityPatch") {
      Build.VERSION.SECURITY_PATCH ?: ""
    }

    AsyncFunction("setScreenSecure") { secure: Boolean ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.runOnUiThread {
        if (secure) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      return@AsyncFunction true
    }
  }
}
