import { useCallback, useEffect, useRef, useState } from 'react';
import { WalletServiceError, errorText } from '@/data/errors';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: WalletServiceError | Error };

export interface Action {
  /** A task is running: show the button's waiting state. */
  busy: boolean;
  /** What went wrong the last time, in words for the user. */
  message: string | null;
  /** The error itself, for screens that offer a next step (`kind`, `suggestsHardware`). */
  error: WalletServiceError | Error | null;
  /** Runs `task`; never rejects. A failure is kept in `error`/`message` and returned as `{ ok: false }`. */
  run: <T>(task: Promise<T>) => Promise<ActionResult<T>>;
  clear: () => void;
}

/**
 * Tracks a pending wallet call for a screen: a waiting state while it runs, and the polite error text when it fails.
 * A cancelled call (the person closed the device sheet) is not shown as an error.
 */
export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WalletServiceError | Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(task: Promise<T>): Promise<ActionResult<T>> => {
    setBusy(true);
    setError(null);
    try {
      const value = await task;
      return { ok: true, value };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (mounted.current && !(err instanceof WalletServiceError && err.kind === 'cancelled')) setError(err);
      return { ok: false, error: err };
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, message: error ? errorText(error) : null, error, run, clear };
}
