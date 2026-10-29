import { useCallback, useState } from 'react';

/**
 * Tracks a pending promise so a button can show its waiting state ("Waiting for your
 * Ledger..."). `run` returns the same promise, so callers can still await the result.
 */
export function useBusy(): [boolean, <T>(task: Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(task: Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await task;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
