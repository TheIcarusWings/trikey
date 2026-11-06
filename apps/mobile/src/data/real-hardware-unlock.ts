/**
 * Unlocking the guardian with the hardware wallet, for the guardian mode's real wallet (`WalletService.hardwareUnlock`):
 * `TrikeyWallet.enableHardwareUnlock`, `disableHardwareUnlock` and `unlockGuardianWithHardware`, in the app's words. Kept
 * apart from ./real.ts, which hands it what it needs (`HardwareUnlockHost`).
 */
import type { TrikeyWallet } from '@trikey/wallet';
import { HARDWARE_UNLOCK_UNAVAILABLE, type HardwareUnlockActions, type HardwareUnlockState } from './hardware-unlock-actions';
import { mapError, refusalToError } from './real-errors';
import type { IsoDate } from './types';

export interface HardwareUnlockHost {
  wallet(): TrikeyWallet | undefined;
  requireWallet(): TrikeyWallet;
  /** Runs a hardware wallet job: one at a time with the other device jobs. */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** The guardian answered (it is reachable, and unlocked now): every screen reads it again. */
  unlocked(): void;
  /** Something changed: every screen reads the wallet again. */
  changed(): void;
  iso(ms: number): IsoDate;
}

export function hardwareUnlockState(w: TrikeyWallet, iso: (ms: number) => IsoDate): HardwareUnlockState {
  const v = w.hardwareUnlockView();
  return {
    available: v.available,
    ...(v.unavailable ? { unavailable: v.unavailable, unavailableText: HARDWARE_UNLOCK_UNAVAILABLE[v.unavailable] } : {}),
    on: v.on,
    ...(v.since !== undefined ? { since: iso(v.since) } : {}),
  };
}

export function createHardwareUnlockActions(host: HardwareUnlockHost): HardwareUnlockActions {
  const guard = async <T>(job: () => Promise<T>): Promise<T> => {
    try {
      return await job();
    } catch (e) {
      throw mapError(e);
    }
  };
  return {
    state: () => {
      const w = host.wallet();
      return w ? hardwareUnlockState(w, host.iso) : null;
    },
    enable: () =>
      guard(async () => {
        const w = host.requireWallet();
        await host.run(() => w.enableHardwareUnlock());
        host.changed();
        return hardwareUnlockState(w, host.iso);
      }),
    disable: () =>
      guard(async () => {
        const w = host.requireWallet();
        await w.disableHardwareUnlock();
        host.changed();
        return hardwareUnlockState(w, host.iso);
      }),
    unlock: () =>
      guard(async () => {
        const w = host.requireWallet();
        const r = await host.run(() => w.unlockGuardianWithHardware());
        if (!r.ok) throw refusalToError(r.refusal);
        host.unlocked();
      }),
  };
}
