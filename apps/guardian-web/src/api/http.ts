import { BrowserRandomError, browserRandomHex } from '../lib/random';
import { ApiError, type GuardianApi } from './client';
import type {
  ActivityEntry,
  FamilyInvite,
  GuardianStatus,
  HostingOverview,
  NotificationSettings,
  NotifyTestResult,
  PairedPhone,
  PairingSession,
  PublicStatus,
  RecoveryCode,
  RecoveryInProgress,
  RelaySettings,
  Rules,
  SetupPreflight,
} from './types';

interface ErrorBody {
  error?: { code?: string; message?: string; retryAfterSeconds?: number };
}

/** Dispatched on `window` when the guardian answers 401 `unauthenticated` (the provider re-reads the status). */
export const SIGNED_OUT_EVENT = 'trikey:signed-out';

/** Bytes of browser randomness sent with setup and reset (the guardian requires exactly this many). */
export const SETUP_ENTROPY_BYTES = 32;

/**
 * `input` plus `entropy`: 32 fresh bytes from this browser's `crypto.getRandomValues`, as hex. The guardian
 * mixes them into the seed it makes for key 3 (apps/guardian/src/keystore.ts, `trikey/guardian-seed/v1`),
 * so that seed does not rest on the guardian's generator alone. They travel only over this local
 * connection, never over a nostr relay, and this module keeps no copy.
 */
export function withBrowserEntropy<T extends object>(input: T): T & { entropy: string } {
  let entropy: string;
  try {
    entropy = browserRandomHex(SETUP_ENTROPY_BYTES);
  } catch (e) {
    if (e instanceof BrowserRandomError) throw new ApiError('internal', e.message);
    throw e;
  }
  return { ...input, entropy };
}

/**
 * Talks to the guardian's own HTTP API. Endpoints are documented in API.md.
 * Request bodies are JSON only; the passphrase goes out in one POST and is
 * not logged, cached or kept anywhere by this module.
 *
 * Every POST, PUT and DELETE carries a JSON body (`{}` when there is nothing to
 * send): the guardian refuses state-changing requests without
 * `Content-Type: application/json`, which keeps cross-site requests out.
 */
export function createHttpApi(base = ''): GuardianApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const sent = body === undefined && method !== 'GET' ? {} : body;
    let response: Response;
    try {
      response = await fetch(`${base}/api${path}`, {
        method,
        headers: sent === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: sent === undefined ? undefined : JSON.stringify(sent),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('network', "Can't reach the guardian. Check that the box is on and on this network.");
    }

    if (response.status === 204) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const err = (payload as ErrorBody | undefined)?.error;
      // The session expired (or the guardian restarted): the app goes back to the sign-in screen.
      if (response.status === 401 && err?.code === 'unauthenticated') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      throw new ApiError(
        err?.code ?? (response.status === 404 ? 'not_found' : 'internal'),
        err?.message ?? `The guardian answered with an error (${response.status}).`,
        response.status,
        err?.retryAfterSeconds,
      );
    }
    return payload as T;
  }

  return {
    getStatus: () => request<GuardianStatus | PublicStatus>('GET', '/status'),
    signIn: (input) => request<GuardianStatus>('POST', '/session', input),
    signOut: () => request<PublicStatus>('DELETE', '/session'),

    getSetupPreflight: () => request<SetupPreflight>('GET', '/setup/preflight'),
    // Both make a new key 3, so each sends fresh browser randomness for its seed (async: a failed draw rejects).
    completeSetup: async (input) => request<GuardianStatus>('POST', '/setup', withBrowserEntropy(input)),

    unlock: (input) => request<GuardianStatus>('POST', '/unlock', input),
    lock: () => request<GuardianStatus>('POST', '/lock'),

    async listActivity(query) {
      const qs = query?.limit ? `?limit=${encodeURIComponent(String(query.limit))}` : '';
      const res = await request<{ entries: ActivityEntry[] }>('GET', `/activity${qs}`);
      return res.entries;
    },
    getRules: () => request<Rules>('GET', '/rules'),

    async getRecovery() {
      const res = await request<{ recovery: RecoveryInProgress | null }>('GET', '/recovery');
      return res.recovery;
    },

    getRecoveryCode: () => request<RecoveryCode>('GET', '/recovery-code'),
    getRelays: () => request<RelaySettings>('GET', '/relays'),
    setRelays: (input) => request<RelaySettings>('PUT', '/relays', input),
    stopWatchingRelays: (url) => request<RelaySettings>('DELETE', url === undefined ? '/relays/retiring' : `/relays/retiring/${encodeURIComponent(url)}`),
    getNotifications: () => request<NotificationSettings>('GET', '/notifications'),
    setNotifications: (input) => request<NotificationSettings>('PUT', '/notifications', input),
    testNotification: (input) => request<NotifyTestResult>('POST', '/notifications/test', input),
    resetGuardian: async (input) => request<GuardianStatus>('POST', '/reset', withBrowserEntropy(input)),

    startPairing: () => request<PairingSession>('POST', '/pairing'),
    getPairingSession: (id) => request<PairingSession>('GET', `/pairing/${encodeURIComponent(id)}`),
    async listPairedPhones() {
      const res = await request<{ phones: PairedPhone[] }>('GET', '/phones');
      return res.phones;
    },

    getHosting: () => request<HostingOverview>('GET', '/hosting'),
    createFamilyInvite: (input) => request<FamilyInvite>('POST', '/hosting/invites', input),
    cancelFamilyInvite: (id) => request<void>('DELETE', `/hosting/invites/${encodeURIComponent(id)}`),
  };
}
