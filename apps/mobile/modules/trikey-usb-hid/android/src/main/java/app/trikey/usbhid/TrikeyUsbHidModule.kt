package app.trikey.usbhid

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * USB HID for a BitBox02 (or BitBox02 Nova) plugged into the phone's USB-C port, with nothing but the Android framework
 * (android.hardware.usb): list the BitBox02s attached, ask Android's permission to use one (the system's dialog), open
 * its first interface, read its 64-byte input reports on a thread of their own, and write 64-byte output reports. As
 * BitBoxApp's own Android app does (frontends/android GoViewModel.java: interface 0, its IN and OUT endpoints,
 * bulkTransfer). What the reports mean is JavaScript's business (src/hardware/bitbox02).
 *
 * Events: `onReport` { handle, data (base64, 64 bytes) } and `onClosed` { handle, reason } when the device is unplugged
 * or a read fails.
 */
class TrikeyUsbHidModule : Module() {
  private class Open(
    val device: UsbDevice,
    val connection: UsbDeviceConnection,
    val intf: UsbInterface,
    val input: UsbEndpoint,
    val output: UsbEndpoint,
  ) {
    @Volatile var closed = false
    var reader: Thread? = null
  }

  private val open = ConcurrentHashMap<Int, Open>()
  private val handles = AtomicInteger(1)
  private var detachReceiver: BroadcastReceiver? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No Android context")

  private val usb: UsbManager
    get() = context.getSystemService(Context.USB_SERVICE) as UsbManager

  private fun register(receiver: BroadcastReceiver, filter: IntentFilter) {
    if (Build.VERSION.SDK_INT >= 33) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(receiver, filter)
    }
  }

  private fun find(id: String): UsbDevice? = usb.deviceList.values.firstOrNull { it.deviceName == id }

  private fun close(handle: Int, reason: String?) {
    val o = open.remove(handle) ?: return
    o.closed = true
    try {
      o.connection.releaseInterface(o.intf)
    } catch (_: Throwable) {
    }
    try {
      o.connection.close()
    } catch (_: Throwable) {
    }
    if (reason != null) sendEvent("onClosed", mapOf("handle" to handle, "reason" to reason))
  }

  private fun startReader(handle: Int, o: Open) {
    val t = Thread({
      val buf = ByteArray(64)
      while (!o.closed) {
        // A short timeout so a close is noticed; a timeout and an error both return a negative count.
        val n = o.connection.bulkTransfer(o.input, buf, buf.size, 250)
        if (o.closed) break
        if (n > 0) {
          val report = buf.copyOf(n)
          sendEvent("onReport", mapOf("handle" to handle, "data" to Base64.encodeToString(report, Base64.NO_WRAP)))
        } else if (find(o.device.deviceName) == null) {
          close(handle, "unplugged")
          break
        }
      }
    }, "trikey-usb-hid-$handle")
    t.isDaemon = true
    o.reader = t
    t.start()
  }

  private fun openNow(device: UsbDevice, promise: Promise) {
    if (device.interfaceCount < 1) return promise.reject("E_USB_INTERFACE", "The device has no USB interface.", null)
    val intf = device.getInterface(0)
    var input: UsbEndpoint? = null
    var output: UsbEndpoint? = null
    for (i in 0 until intf.endpointCount) {
      val e = intf.getEndpoint(i)
      if (e.type != UsbConstants.USB_ENDPOINT_XFER_INT && e.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
      if (e.direction == UsbConstants.USB_DIR_IN && input == null) input = e
      if (e.direction == UsbConstants.USB_DIR_OUT && output == null) output = e
    }
    if (input == null || output == null) return promise.reject("E_USB_ENDPOINTS", "The device's USB interface has no input and output endpoints.", null)
    val connection = usb.openDevice(device) ?: return promise.reject("E_USB_OPEN", "Android could not open the device.", null)
    if (!connection.claimInterface(intf, true)) {
      connection.close()
      return promise.reject("E_USB_CLAIM", "Another app is using the device.", null)
    }
    val handle = handles.getAndIncrement()
    val o = Open(device, connection, intf, input, output)
    open[handle] = o
    startReader(handle, o)
    promise.resolve(handle)
  }

  override fun definition() = ModuleDefinition {
    Name("TrikeyUsbHid")

    Events("onReport", "onClosed")

    OnCreate {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (intent.action != UsbManager.ACTION_USB_DEVICE_DETACHED) return
          @Suppress("DEPRECATION")
          val gone = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE) ?: return
          for ((handle, o) in open.entries) if (o.device.deviceName == gone.deviceName) close(handle, "unplugged")
        }
      }
      try {
        // The detach broadcast comes from the system: it must be receivable from outside the app.
        if (Build.VERSION.SDK_INT >= 33) {
          context.registerReceiver(receiver, IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED), Context.RECEIVER_EXPORTED)
        } else {
          @Suppress("UnspecifiedRegisterReceiverFlag")
          context.registerReceiver(receiver, IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED))
        }
        detachReceiver = receiver
      } catch (_: Throwable) {
      }
    }

    OnDestroy {
      for (handle in open.keys.toList()) close(handle, null)
      detachReceiver?.let {
        try {
          context.unregisterReceiver(it)
        } catch (_: Throwable) {
        }
      }
      detachReceiver = null
    }

    Function("isSupported") {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST)
    }

    /** The attached devices with this vendor and product id: [{ id, name }]. */
    Function("list") { vendorId: Int, productId: Int ->
      usb.deviceList.values
        .filter { it.vendorId == vendorId && it.productId == productId }
        .map { mapOf("id" to it.deviceName, "name" to (it.productName ?: "")) }
    }

    /** Opens the device, asking Android's permission first if the app does not have it. Resolves with a handle. */
    AsyncFunction("open") { id: String, promise: Promise ->
      val device = find(id) ?: return@AsyncFunction promise.reject("E_USB_GONE", "The device is no longer plugged in.", null)
      if (usb.hasPermission(device)) return@AsyncFunction openNow(device, promise)
      val action = "${context.packageName}.TRIKEY_USB_PERMISSION"
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (intent.action != action) return
          try {
            context.unregisterReceiver(this)
          } catch (_: Throwable) {
          }
          if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) && usb.hasPermission(device)) {
            openNow(device, promise)
          } else {
            promise.reject("E_USB_PERMISSION", "Android did not allow Trikey to use the device.", null)
          }
        }
      }
      register(receiver, IntentFilter(action))
      // Mutable: the system adds the device and the answer to the intent. Explicit (our package) so that is allowed.
      val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
      val pending = PendingIntent.getBroadcast(context, 0, Intent(action).setPackage(context.packageName), flags)
      usb.requestPermission(device, pending)
    }

    /** Writes whole 64-byte reports (base64). */
    AsyncFunction("write") { handle: Int, data: String, promise: Promise ->
      val o = open[handle] ?: return@AsyncFunction promise.reject("E_USB_CLOSED", "The device is not open.", null)
      val bytes = Base64.decode(data, Base64.NO_WRAP)
      var at = 0
      while (at < bytes.size) {
        val chunk = bytes.copyOfRange(at, minOf(at + 64, bytes.size))
        val n = o.connection.bulkTransfer(o.output, chunk, chunk.size, 5000)
        if (n < 0) {
          close(handle, "write failed")
          return@AsyncFunction promise.reject("E_USB_WRITE", "Writing to the device failed.", null)
        }
        at += chunk.size
      }
      promise.resolve(null)
    }

    Function("close") { handle: Int ->
      close(handle, null)
    }
  }
}
