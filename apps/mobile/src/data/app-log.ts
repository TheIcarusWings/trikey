/**
 * What the app itself knows about a wallet that the guardian's history does not say: who signed a payment and where it
 * went, when the phone first saw an unconfirmed one, which rule changes were made and how, and which recoveries the
 * person has already looked at. Kept in the (non-secret) `KeyValueStore`, next to the wallet's own state.
 */
import type { HistoryEntry } from '@trikey/protocol';
import type { KeyValueStore } from '@trikey/wallet';
import type { ActivityItem, GuardianHost, IsoDate, Sats, SecurityEvent, Transaction, TxSigners } from './types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StoredEvent = DistributiveOmit<SecurityEvent, 'at'> & { at: number };

export interface SendRecord {
  txid: string;
  address: string;
  amountSats: Sats;
  feeSats: Sats;
  signedBy: TxSigners;
  /** ms */
  at: number;
}

export interface AppLog {
  v: 1;
  /** Payments this phone made, by txid. */
  sends: Record<string, SendRecord>;
  /** Rule changes and guardian alerts, newest first. `at` in ms. */
  events: StoredEvent[];
  /** First time an unconfirmed transaction was seen (ms), by txid. */
  seen: Record<string, number>;
  /** Recovery ids the person has seen the alert for. */
  acknowledged: string[];
}

const MAX_EVENTS = 100;
const MAX_SENDS = 200;

export const emptyLog = (): AppLog => ({ v: 1, sends: {}, events: [], seen: {}, acknowledged: [] });

export async function loadLog(kv: KeyValueStore, key: string): Promise<AppLog> {
  try {
    const raw = await kv.get(key);
    if (!raw) return emptyLog();
    const j = JSON.parse(raw) as Partial<AppLog>;
    if (j.v !== 1) return emptyLog();
    return { ...emptyLog(), ...j };
  } catch {
    return emptyLog();
  }
}

export async function saveLog(kv: KeyValueStore, key: string, log: AppLog): Promise<void> {
  try {
    await kv.set(key, JSON.stringify(log));
  } catch {
    /* the log is a convenience; the wallet does not depend on it */
  }
}

export function addSend(log: AppLog, rec: SendRecord): void {
  log.sends[rec.txid] = rec;
  const keys = Object.keys(log.sends);
  if (keys.length > MAX_SENDS) for (const k of keys.sort((a, b) => log.sends[a]!.at - log.sends[b]!.at).slice(0, keys.length - MAX_SENDS)) delete log.sends[k];
}

let counter = 0;
export function addEvent(log: AppLog, event: DistributiveOmit<SecurityEvent, 'id' | 'at'> & { at: number }): void {
  counter += 1;
  log.events = [{ ...event, id: `ev-${event.at}-${counter}` } as StoredEvent, ...log.events].slice(0, MAX_EVENTS);
}

const iso = (ms: number): IsoDate => new Date(ms).toISOString();

/**
 * The guardian's history as the Activity list: payments (with what the app knows about them), payments the phone
 * just made that the guardian has not listed yet, and the security events.
 */
export function buildActivity(history: HistoryEntry[], log: AppLog, nowMs: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  const listed = new Set<string>();
  for (const h of history) {
    listed.add(h.txid);
    const sendInfo = log.sends[h.txid];
    const confirmed = h.confirmations > 0;
    const at = confirmed && h.time ? h.time * 1000 : (sendInfo?.at ?? log.seen[h.txid] ?? nowMs);
    const sent = h.netSats < 0;
    const fee = h.feeSats;
    const amountSats = sent ? Math.max(0, -h.netSats - (fee ?? 0)) : h.netSats;
    const tx: Transaction = {
      id: h.txid,
      kind: sent ? 'sent' : 'received',
      amountSats: sendInfo && sent ? sendInfo.amountSats : amountSats,
      ...(sent ? { feeSats: fee ?? sendInfo?.feeSats } : {}),
      status: confirmed ? 'confirmed' : 'pending',
      at: iso(at),
      ...(sendInfo ? { address: sendInfo.address, signedBy: sendInfo.signedBy } : {}),
      txid: h.txid,
    };
    items.push({ type: 'payment', at: tx.at, tx });
  }
  // Sent a moment ago and not in the guardian's list yet.
  for (const rec of Object.values(log.sends)) {
    if (listed.has(rec.txid) || nowMs - rec.at > 3_600_000) continue;
    const tx: Transaction = {
      id: rec.txid,
      kind: 'sent',
      amountSats: rec.amountSats,
      feeSats: rec.feeSats,
      status: 'pending',
      at: iso(rec.at),
      address: rec.address,
      txid: rec.txid,
      signedBy: rec.signedBy,
    };
    items.push({ type: 'payment', at: tx.at, tx });
  }
  for (const e of log.events) {
    const event = { ...e, at: iso(e.at) } as SecurityEvent;
    items.push({ type: 'security', at: event.at, event });
  }
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** The platform of a guardian from the name it gave itself when pairing. */
export function hostFromLabel(label: string | undefined): GuardianHost {
  if (!label) return 'other';
  if (/umbrel/i.test(label)) return 'umbrel';
  if (/start\s?9|startos/i.test(label)) return 'start9';
  return 'other';
}
