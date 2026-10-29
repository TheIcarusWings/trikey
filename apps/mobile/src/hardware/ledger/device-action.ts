/**
 * Turns a DMK device action (an observable of states plus `cancel()`) into a promise.
 * The state shape is written out structurally so this file does not load the DMK at runtime.
 */
import { HardwareError } from '../errors';

export type DeviceActionStateLike<Output, Err> =
  | { status: 'not-started' }
  | { status: 'pending'; intermediateValue?: { requiredUserInteraction?: string } }
  | { status: 'stopped' }
  | { status: 'completed'; output: Output }
  | { status: 'error'; error: Err };

export interface DeviceActionLike<Output, Err> {
  observable: {
    subscribe(observer: { next: (s: DeviceActionStateLike<Output, Err>) => void; error: (e: unknown) => void; complete: () => void }): { unsubscribe(): void };
  };
  cancel(): void;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with the DMK's `requiredUserInteraction` ("sign-transaction", "verify-address", "unlock-device"...). */
  onInteraction?: (interaction: string) => void;
}

/** Resolves with the output; rejects with the DMK's own error object (map it with `mapLedgerError`). */
export function runDeviceAction<Output, Err>(action: DeviceActionLike<Output, Err>, opts: RunOptions = {}): Promise<Output> {
  return new Promise<Output>((resolve, reject) => {
    let settled = false;
    let sub: { unsubscribe(): void } | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      sub?.unsubscribe();
      fn();
    };
    sub = action.observable.subscribe({
      next: (state) => {
        if (state.status === 'pending') {
          const interaction = state.intermediateValue?.requiredUserInteraction;
          if (interaction) opts.onInteraction?.(interaction);
        } else if (state.status === 'completed') {
          finish(() => resolve(state.output));
        } else if (state.status === 'error') {
          finish(() => reject(state.error));
        } else if (state.status === 'stopped') {
          finish(() => reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'ledger' })));
        }
      },
      error: (e) => finish(() => reject(e)),
      complete: () => finish(() => reject(new HardwareError('device-error', 'The Ledger action ended without a result.', { kind: 'ledger' }))),
    });
    if (opts.signal) {
      onAbort = () => {
        action.cancel();
        finish(() => reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'ledger' })));
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort);
    }
    // `finish` may have run synchronously (an already-completed observable) before `sub` was assigned.
    if (settled) sub.unsubscribe();
  });
}
