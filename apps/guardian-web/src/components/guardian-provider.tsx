import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { ApiError, GuardianStatus } from '@/api';
import { api } from '@/api';
import { useApi } from '@/hooks/use-api';

interface GuardianContextValue {
  status: GuardianStatus | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Fetch the status again right now. */
  refresh: () => void;
  /**
   * Use a status a mutation already returned (unlock, lock, setup). `landing` is
   * where the route guard should send the person if this status moves them out
   * of the current screen, instead of the default.
   */
  setStatus: (status: GuardianStatus, landing?: string) => void;
  /** The landing path given to `setStatus` for exactly this status object, if any. */
  landingFor: (status: GuardianStatus) => string | undefined;
}

const GuardianContext = createContext<GuardianContextValue | null>(null);

const STATUS_POLL_MS = 15_000;

export function GuardianProvider({ children }: { children: ReactNode }) {
  const state = useApi(() => api.getStatus(), [], STATUS_POLL_MS);
  const landing = useRef<{ status: GuardianStatus; to: string } | undefined>(undefined);
  const { set } = state;
  const value = useMemo<GuardianContextValue>(
    () => ({
      status: state.data,
      error: state.data ? undefined : state.error,
      loading: state.loading && !state.data,
      refresh: state.reload,
      setStatus: (next, to) => {
        landing.current = to ? { status: next, to } : undefined;
        set(next);
      },
      landingFor: (current) => (landing.current?.status === current ? landing.current.to : undefined),
    }),
    [state.data, state.error, state.loading, state.reload, set],
  );
  return <GuardianContext.Provider value={value}>{children}</GuardianContext.Provider>;
}

export function useGuardian(): GuardianContextValue {
  const ctx = useContext(GuardianContext);
  if (!ctx) throw new Error('useGuardian must be used inside GuardianProvider');
  return ctx;
}
