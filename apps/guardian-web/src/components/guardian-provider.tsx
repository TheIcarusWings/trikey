import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ApiError, GuardianStatus, PublicStatus } from '@/api';
import { api, SIGNED_OUT_EVENT } from '@/api';
import { useApi } from '@/hooks/use-api';

type AnyStatus = GuardianStatus | PublicStatus;

/** A status this browser may see in full (signed in, or before setup). */
export function isSignedIn(s: AnyStatus): s is GuardianStatus {
  return s.authenticated !== false;
}

interface GuardianContextValue {
  /** The guardian's status once this browser is signed in (undefined while signed out). */
  status: GuardianStatus | undefined;
  /** What the guardian says to a signed-out browser: enough to pick the screen. */
  signedOut: PublicStatus | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Fetch the status again right now. */
  refresh: () => void;
  /**
   * Use a status a mutation already returned (unlock, lock, setup, sign-in). `landing` is
   * where the route guard should send the person if this status moves them out
   * of the current screen, instead of the default.
   */
  setStatus: (status: AnyStatus, landing?: string) => void;
  /** The landing path given to `setStatus` for exactly this status object, if any. */
  landingFor: (status: AnyStatus) => string | undefined;
}

const GuardianContext = createContext<GuardianContextValue | null>(null);

const STATUS_POLL_MS = 15_000;

export function GuardianProvider({ children }: { children: ReactNode }) {
  const state = useApi(() => api.getStatus(), [], STATUS_POLL_MS);
  const landing = useRef<{ status: AnyStatus; to: string } | undefined>(undefined);
  const { set, reload } = state;
  // A request answered 401 `unauthenticated` (the session expired, the box restarted): read the status
  // again, and the route guard sends the person to the sign-in screen.
  useEffect(() => {
    const onSignedOut = () => reload();
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [reload]);
  const value = useMemo<GuardianContextValue>(
    () => ({
      status: state.data && isSignedIn(state.data) ? state.data : undefined,
      signedOut: state.data && !isSignedIn(state.data) ? state.data : undefined,
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

/** The bitcoin network from `/api/status`, signed in or not. */
export function useNetwork(): string | undefined {
  const { status, signedOut } = useGuardian();
  return status?.network ?? signedOut?.network;
}

export function useGuardian(): GuardianContextValue {
  const ctx = useContext(GuardianContext);
  if (!ctx) throw new Error('useGuardian must be used inside GuardianProvider');
  return ctx;
}
