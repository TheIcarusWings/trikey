package app.trikey.qrcamera

import androidx.camera.core.ImageProxy
import zxingcpp.BarcodeReader

/**
 * Reads QR codes in camera frames with zxing-cpp. Only QR codes; the image's luminance plane is all it looks at.
 *
 * - `tryHarder`: look closer at each frame (smaller, tilted or partly blurred codes).
 * - `tryInvert`: also read light-on-dark codes, which some hardware wallets show in their dark theme.
 * - `tryDownscale`: also look at a smaller copy of a large frame, which helps with codes that fill the view or are
 *   out of focus.
 * - `TextMode.PLAIN`: the code's bytes as text (character set from the code, or guessed), the way the standard
 *   build's ML Kit hands over its raw value. BBQr, UR, addresses and pairing codes are all plain text.
 */
internal class QrDecoder {
  private val reader = BarcodeReader(
    BarcodeReader.Options(
      formats = setOf(BarcodeReader.Format.QR_CODE),
      tryHarder = true,
      tryInvert = true,
      tryDownscale = true,
      textMode = BarcodeReader.TextMode.PLAIN,
    )
  )

  /** The text of every QR code in the frame (usually none or one). */
  fun read(image: ImageProxy): List<String> =
    reader.read(image).mapNotNull { result -> result.text?.takeIf { it.isNotEmpty() && result.error == null } }
}
