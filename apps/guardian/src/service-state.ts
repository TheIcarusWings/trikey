/**
 * What the service keeps next to the policy engine's state: the relays chosen
 * at setup, the paired phone's name, co-signed sweeps waiting to be (or that
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
  | { type: 'recovery_waiting'; recoveryId: string; reason: string; detail: string }
  | { type: 'cancel_by_dm'; recoveryId: string; contact: string; ok: boolean; detail?: string }
  | { type: 'clock_skew'; systemTime: number; chainTime: number }
  | { type: 'recovery_access'; phone: string; until: number };

export type ServiceActivity = { id: number; at: number } & ServiceEvent;

export interface ServiceStateData {
  version: 1;
  relays: string[];
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
  return { version: 1, relays: [], phones: [], sweeps: [], activity: [], nextActivityId: 1, requests: [], recoveryPeers: [] };
}

export class ServiceState {
  private data: ServiceStateData = emptyServiceState();
  private readonly mutex = new Mutex();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as ServiceStateData | undefined;
    if (raw === undefined) return;
    if (raw.version !== 1 || !Array.isArray(raw.relays) || !Array.isArray(raw.activity)) throw new Error('unsupported service state file');
    this.data = { ...emptyServiceState(), ...raw };
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
