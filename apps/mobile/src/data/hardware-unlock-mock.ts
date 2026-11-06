/**
 * Unlocking the guardian with the hardware wallet, for the demo (`WalletService.hardwareUnlock`): the same actions as
 * the real wallet, held in memory. Turning it on waits for the "device" twice (the determinism check), unlocking once.
 */
import type { HardwareUnlockActions, HardwareUnlockState } from './hardware-unlock-actions';
import type { MockHooks } from './rk-mock';

export function createMockHardwareUnlock(h: MockHooks & { unlocked(): void }): HardwareUnlockActions {
  let state: HardwareUnlockState = { available: true, on: false };
  const set = (next: HardwareUnlockState) => {
    state = next;
    h.update({});
    return state;
  };
  return {
    state: () => state,
    enable: async () => {
      if (state.on) return state;
      await h.wait(h.deviceDelay);
      await h.wait(h.deviceDelay);
      await h.wait(h.networkDelay);
      return set({ available: true, on: true, since: h.now.toISOString() });
    },
    disable: async () => {
      await h.wait(h.networkDelay);
      return set({ available: true, on: false });
    },
    unlock: async () => {
      await h.wait(h.deviceDelay);
      await h.wait(h.networkDelay);
      h.unlocked();
    },
  };
}
