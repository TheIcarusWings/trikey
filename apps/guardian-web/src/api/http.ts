import { ApiError, type GuardianApi } from './client';
import type {
  ActivityEntry,
  FamilyInvite,
  GuardianStatus,
  HostingOverview,
  PairedPhone,
  PairingSession,
  RecoveryInProgress,
  Rules,
  SetupPreflight,
} from './types';

interface ErrorBody {
  error?: { code?: string; message?: string; retryAfterSeconds?: number };
}

/**
 * Talks to the guardian's own HTTP API. Endpoints are documented in API.md.
 * Request bodies are JSON only; the passphrase goes out in one POST and is
 * not logged, cached or kept anywhere by this module.
 *
 * Every POST and DELETE carries a JSON body (`{}` when there is nothing to
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
    getStatus: () => request<GuardianStatus>('GET', '/status'),

    getSetupPreflight: () => request<SetupPreflight>('GET', '/setup/preflight'),
    completeSetup: (input) => request<GuardianStatus>('POST', '/setup', input),

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
