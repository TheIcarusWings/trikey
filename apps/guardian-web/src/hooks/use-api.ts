import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally, for example after a mutation returns the new value. */
  set: (value: T) => void;
}

function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError('internal', e instanceof Error ? e.message : 'Something went wrong.');
}

/**
 * Loads data once, and again on `reload()` or every `pollMs`. Background polls
 * keep showing the previous data instead of flashing a spinner.
 */
export function useApi<T>(load: () => Promise<T>, deps: unknown[] = [], pollMs?: number): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    const run = (background: boolean) => {
      if (!background) setLoading(true);
      loadRef.current().then(
        (value) => {
          if (cancelled) return;
          setData(value);
          setError(undefined);
          setLoading(false);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(toApiError(e));
          setLoading(false);
        },
      );
    };
    run(false);
    const timer = pollMs ? window.setInterval(() => run(true), pollMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, pollMs, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, set: setData };
}

/** Re-renders every `intervalMs` and returns the current time. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Sets the browser tab title for the current page. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Trikey Guardian`;
  }, [title]);
}
