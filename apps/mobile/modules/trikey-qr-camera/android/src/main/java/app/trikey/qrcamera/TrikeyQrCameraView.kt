package app.trikey.qrcamera

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import android.util.Size
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The back camera's preview, with every frame handed to [QrDecoder] on a worker thread. Each QR code read is sent to
 * JavaScript as `onCodeScanned({ data })`, as often as the camera sees it (the receiver decides what is new, as with
 * expo-camera's `onBarcodeScanned`). The camera runs while the view is on screen, `active` and the app is in front;
 * `paused` stops the decoding but keeps the preview.
 */
@SuppressLint("ViewConstructor")
class TrikeyQrCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // The preview is laid out by Android inside the size React Native gives this view.
  override val shouldUseAndroidLayout = true

  private val onCodeScanned by EventDispatcher<Map<String, Any>>(
    // Distinct codes must not be merged into one event when several wait for JavaScript (animated QR parts).
    coalescingKey = { event -> ((event["data"]?.hashCode() ?: 0) % Short.MAX_VALUE).toShort() }
  )
  private val onMountError by EventDispatcher<Map<String, Any>>()

  private val previewView = PreviewView(context).apply {
    scaleType = PreviewView.ScaleType.FILL_CENTER
    // A TextureView, so the preview is clipped to the rounded corners of the view around it.
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
  }
  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val decoder by lazy { QrDecoder() }

  private var provider: ProcessCameraProvider? = null
  private var useCases: List<UseCase> = emptyList()
  private var wanted = false
  private var released = false

  /** Whether the camera should run (the `active` prop). */
  var active = true
    set(value) {
      field = value
      update()
    }

  /** Skip decoding while true (the `paused` prop). Read on the analysis thread. */
  @Volatile
  var paused = false

  init {
    addView(previewView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    update()
  }

  override fun onDetachedFromWindow() {
    stopCamera()
    super.onDetachedFromWindow()
  }

  /** The view is gone for good: stop the camera and the worker thread. */
  fun release() {
    released = true
    stopCamera()
    analysisExecutor.shutdown()
  }

  private fun update() {
    if (active && isAttachedToWindow && !released) startCamera() else stopCamera()
  }

  private fun startCamera() {
    if (wanted) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      mountError("The camera needs the app to be open")
      return
    }
    wanted = true
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (!wanted || released) return@addListener
      try {
        val cameraProvider = future.get()
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder()
          // Enough pixels for the dense codes of animated QR, few enough to read every frame or two.
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setResolutionStrategy(
                ResolutionStrategy(ANALYSIS_SIZE, ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)
              )
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()
        analysis.setAnalyzer(analysisExecutor) { image -> analyze(image) }
        cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        provider = cameraProvider
        useCases = listOf(preview, analysis)
      } catch (e: Exception) {
        wanted = false
        Log.w(TAG, "Could not start the camera", e)
        mountError("The camera could not be started. It may be in use by another app: ${e.message ?: e.javaClass.simpleName}")
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun stopCamera() {
    wanted = false
    val cameraProvider = provider ?: return
    useCases.filterIsInstance<ImageAnalysis>().forEach { it.clearAnalyzer() }
    try {
      cameraProvider.unbind(*useCases.toTypedArray())
    } catch (e: Exception) {
      Log.w(TAG, "Could not stop the camera", e)
    }
    useCases = emptyList()
    provider = null
  }

  private fun analyze(image: ImageProxy) {
    try {
      if (paused) return
      val codes = try {
        decoder.read(image)
      } catch (e: Throwable) {
        Log.w(TAG, "QR decoding failed", e)
        emptyList()
      }
      if (codes.isNotEmpty()) {
        post {
          if (!paused && wanted) codes.forEach { onCodeScanned(mapOf("data" to it)) }
        }
      }
    } finally {
      image.close()
    }
  }

  private fun mountError(message: String) {
    onMountError(mapOf("message" to message))
  }

  private companion object {
    const val TAG = "TrikeyQrCamera"
    val ANALYSIS_SIZE = Size(1920, 1080)
  }
}
