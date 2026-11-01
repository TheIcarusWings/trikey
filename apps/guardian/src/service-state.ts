/**
 * What the service keeps next to the policy engine's state: the relays (chosen
 * at setup, changed in the web UI) and the ones still watched after a change,
 * the paired phone's name, co-signed sweeps waiting to be (or that
 * were) broadcast, and a log of service events (unlocks, broadcasts, ...) that
 * the engine's activity log does not cover. One JSON file, written atomically.
 */
import { readJsonFile, writeFileAtomic, Mutex } from './files.js';

export interface PairedPhoneRecord {
  /** Nostr pubkey, x-only hex. */
  pubkey: string;
  name: string;
  /** ms */
  pairedAt: number;
}

export interface SweepRecord {
  recoveryId: string;
  txid: string;
  /** The fully signed sweep: PSBT (base64) and raw tx (hex). */
  psbt: string;
  txHex: string;
  amountSats: number;
  completedAt: number;
  broadcastAt?: number;
  broadcastVia?: 'electrum' | 'bitcoind';
  lastError?: string;
  attempts: number;
  /**
   * Set once the sweep can never be broadcast: an input was spent by another transaction with
   * `DEAD_SWEEP_CONFIRMATIONS` confirmations, a later recovery's sweep of the same wallet was
   * broadcast, or the stored transaction does not even decode. A dead sweep is not retried and does
   * not hold back a reset.
   */
  deadAt?: number;
  deadReason?: 'inputs_spent' | 'superseded' | 'invalid';
  deadDetail?: string;
}

export type ServiceEvent =
  | { type: 'setup' }
  | { type: 'started' }
  | { type: 'unlocked'; via: 'web' | 'phone' }
  | { type: 'unlock_failed'; via: 'web' | 'phone' }
  | { type: 'locked'; reason: 'manual' | 'remote' }
  | { type: 'reset' }
  | { type: 'reset_refused'; detail: string }
  | { type: 'paired'; name: string }
  | { type: 'pair_refused'; detail: string }
  | { type: 'sweep_broadcast'; recoveryId: string; txid: string; via: 'electrum' | 'bitcoind'; amountSats: number }
  | { type: 'sweep_broadcast_failed'; recoveryId: string; txid: string; detail: string }
  | { type: 'sweep_dead'; recoveryId: string; txid: string; reason: 'inputs_spent' | 'superseded' | 'invalid'; detail: string }
  | { type: 'recovery_waiting'; recoveryId: string; reason: string; detail: string }
  | { type: 'cancel_by_dm'; recoveryId: string; contact: string; ok: boolean; detail?: string }
  /**
   * An alert contact's `LOCK` DM that did not lock (dm-lock.ts): the guardian was locked already, or the rules do not
   * let the contacts lock it. A lock itself is in the engine's log (`contact_locked`).
   */
  | { type: 'contact_lock_request'; contact: string; outcome: 'already_locked' | 'not_allowed' }
  | { type: 'clock_skew'; systemTime: number; chainTime: number }
  | { type: 'recovery_access'; phone: string; until: number }
  /** `PUT /api/relays`: a security event (the relays decide whether the phone can reach the guardian). */
  | { type: 'relays_changed'; from: string[]; to: string[]; /** Logged before 0.1.5: the end of the old 30-day watch, no longer used. */ retiringUntil?: number }
  /** The paired phone confirmed it uses the new relays (`relays.ack`). */
  | { type: 'relays_confirmed'; relays: string[] }
  /**
   * The guardian stopped watching old relays: the owner said so (`by: 'owner'`, web UI), or, in entries logged
   * before old relays stayed watched indefinitely, their 30 days were over (`by` absent).
   */
  | { type: 'relays_retired'; relays: string[]; by?: 'owner' };

/** A relay removed from `relays` that the guardian still watches (listens and publishes on) until the owner stops it. */
export interface RetiringRelay {
  url: string;
  /** When the change that removed it happened (ms). */
  since: number;
}

/** The 30 days an old relay was kept before old relays stayed watched until the owner stops them. */
const LEGACY_RETIRING_MS = 30 * 24 * 3_600_000;

/**
 * Old relays as service.json from before relays stayed watched indefinitely stored them: `{ url, until }`, `until`
 * being 30 days after the change. They are kept (an old recovery sheet must keep working, even when the guardian
 * was off past `until`) and get `since = until - 30 days`; the end date is dropped. Anything else is ignored.
 */
export function normalizeRetiringRelays(raw: unknown, fallbackSince: number): RetiringRelay[] {
  if (!Array.isArray(raw)) return [];
  const out: RetiringRelay[] = [];
  for (const r of raw as { url?: unknown; since?: unknown; until?: unknown }[]) {
    if (!r || typeof r.url !== 'string' || out.some((o) => o.url === r.url)) continue;
    const since =
      typeof r.since === 'number' && Number.isFinite(r.since)
        ? r.since
        : typeof r.until === 'number' && Number.isFinite(r.until)
          ? r.until - LEGACY_RETIRING_MS
          : fallbackSince;
    out.push({ url: r.url, since });
  }
  return out;
}

export type ServiceActivity = { id: number; at: number } & ServiceEvent;

export interface ServiceStateData {
  version: 1;
  /** The relays in use: in the pairing and recovery codes, listened and published on. */
  relays: string[];
  /**
   * Relays a change removed, still listened and published on until the owner stops watching them, so a phone, a
   * phone restored from an older backup or a recovery from an older recovery code or printed sheet that only knows
   * them still gets through (DESIGN.md, "Changing relays"). Absent in files from before relay changes; files from
   * before they stayed watched indefinitely hold `until` instead of `since` (`normalizeRetiringRelays`).
   */
  retiringRelays: RetiringRelay[];
  /** The last relay change (ms), and when the paired phone confirmed it (`relays.ack`). */
  relaysChange?: { at: number; confirmedAt?: number };
  setupAt?: number;
  phones: PairedPhoneRecord[];
  sweeps: SweepRecord[];
  activity: ServiceActivity[];
  nextActivityId: number;
  /** State-changing requests already run: `${sender}:${id}` -> keep until (ms). See `rememberRequest`. */
  requests: { key: string; until: number }[];
  /**
   * Recovery access grants as guardians before wallet rotation kept them. They now live in the
   * engine, per wallet (`GuardedWallet.accessGrants`); `Guardian.open` moves any found here.
   */
  recoveryPeers: { pubkey: string; until: number }[];
}

const MAX_ACTIVITY = 2000;
const MAX_REQUESTS = 4096;

export function emptyServiceState(): ServiceStateData {
  return { version: 1, relays: [], retiringRelays: [], phones: [], sweeps: [], activity: [], nextActivityId: 1, requests: [], recoveryPeers: [] };
}

export class ServiceState {
  private data: ServiceStateData = emptyServiceState();
  private readonly mutex = new Mutex();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as ServiceStateData | undefined;
    if (raw === undefined) return;
    if (raw.version !== 1 || !Array.isArray(raw.relays) || !Array.isArray(raw.activity)) throw new Error('unsupported service state file');
    this.data = { ...emptyServiceState(), ...raw, retiringRelays: normalizeRetiringRelays(raw.retiringRelays, raw.relaysChange?.at ?? raw.setupAt ?? 0) };
  }

  get(): Readonly<ServiceStateData> {
    return this.data;
  }

  /** Applies `fn` to a copy and persists it before it becomes visible. */
  update(fn: (draft: ServiceStateData) => void): Promise<void> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.data);
      fn(draft);
      if (draft.activity.length > MAX_ACTIVITY) draft.activity = draft.activity.slice(-MAX_ACTIVITY);
      await writeFileAtomic(this.path, `${JSON.stringify(draft)}\n`);
      this.data = draft;
    });
  }

  log(at: number, event: ServiceEvent): Promise<void> {
    return this.update((d) => {
      d.activity.push({ id: d.nextActivityId++, at, ...event } as ServiceActivity);
    });
  }

  /**
   * The protocol's replay guard lives in memory, so after a restart a relay
   * could re-deliver a request that is still within its TTL (up to an hour)
   * and it would run again: an old `guardian.unlock` would unlock a guardian
   * that was just restarted, an old `recovery.start` would restart a recovery
   * that was cancelled. State-changing requests are therefore recorded here,
   * durably, before they run. Returns false if this (sender, id) already ran.
   */
  /** Whether `rememberRequest(key, ...)` already ran and is still remembered at `now`, without writing anything. */
  hasRequest(key: string, now: number): boolean {
    return this.data.requests.some((r) => r.key === key && r.until > now);
  }

  async rememberRequest(key: string, until: number, now: number): Promise<boolean> {
    if (this.data.requests.some((r) => r.key === key && r.until > now)) return false;
    let fresh = true;
    await this.update((d) => {
      d.requests = d.requests.filter((r) => r.until > now);
      if (d.requests.some((r) => r.key === key)) {
        fresh = false;
        return;
      }
      d.requests.push({ key, until });
      if (d.requests.length > MAX_REQUESTS) d.requests = d.requests.slice(-MAX_REQUESTS);
    });
    return fresh;
  }

  sweep(recoveryId: string): SweepRecord | undefined {
    return this.data.sweeps.find((s) => s.recoveryId === recoveryId);
  }
}
