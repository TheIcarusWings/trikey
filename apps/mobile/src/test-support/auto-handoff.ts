/**
 * Test setup (vitest `setupFiles`). With a Trezor, the "Confirm on your device" sheet waits for the person to tap
 * "Continue in Trezor Suite" before the request goes to the device (src/data/device.ts, `prompted`). The service tests
 * drive a simulated Trezor with nobody to tap it: here the tap is made for them, right after the sheet opens, as a
 * person who read it would. A test of the wait itself sets `globalThis.__trikeyManualHandoff = true`.
 */
import { DevicePromptStore } from '../data/device';

const show = DevicePromptStore.prototype.show;
DevicePromptStore.prototype.show = function (this: DevicePromptStore, title, opts = {}) {
  const id = show.call(this, title, opts);
  if (opts.continueLabel && !(globalThis as { __trikeyManualHandoff?: boolean }).__trikeyManualHandoff) queueMicrotask(() => this.proceed());
  return id;
};
