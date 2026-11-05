package app.trikey.phonesafety

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What the phone-safety note needs that Expo does not offer: the date of the last Android security patch
 * (`Build.VERSION.SECURITY_PATCH`, "YYYY-MM-DD"). Read on the phone and kept there; nothing is sent anywhere.
 */
class TrikeyPhoneSafetyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TrikeyPhoneSafety")

    Constant("securityPatch") {
      Build.VERSION.SECURITY_PATCH ?: ""
    }
  }
}
