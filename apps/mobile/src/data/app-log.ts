/**
 * What the app itself knows about a wallet that the wallet does not keep: when the phone first saw an unconfirmed
 * transaction, which rule changes and guardian events happened and how, and which recoveries the person has already
 * looked at. Kept in the (non-secret) `KeyValueStore`, next to the wallet's own state.
 *
 * Who signed a payment, where it went and its note are the wallet's own send log (`snapshot().history`), which the
 * backup carries too. An older app kept them here (`sends`); `takeLegacySends` hands those to the wallet once.
 */
import type { KeyValueStore, SendLogEntry, SilentPaymentCoin as WalletSilentCoin, WalletHistoryEntry } from '@trikey/wallet';
import type { ActivityItem, GuardianHost, IsoDate, SecurityEvent, Transaction, TxSigners } from './types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StoredEvent = DistributiveOmit<SecurityEvent, 'at'> & { at: number };

/** A payment as the app used to record it (before the wallet kept a send log). */
interface LegacySend {
  txid: string;
  address: string;
  amountSats: number;
  feeSats: number;
  signedBy: TxSigners;
  /** ms */
  at: number;
}

export interface AppLog {
  v: 1;
  /** Rule changes and guardian alerts, newest first. `at` in ms. */
  events: StoredEvent[];
  /** First time an unconfirmed transaction was seen (ms), by txid. */
  seen: Record<string, number>;
  /** Recovery ids the person has seen the alert for. */
  acknowledged: string[];
  /** Payments an older app version recorded here; moved into the wallet's send log on open. */
  sends?: Record<string, LegacySend>;
}

const MAX_EVENTS = 100;

export const emptyLog = (): AppLog => ({ v: 1, events: [], seen: {}, acknowledged: [] });

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

/** The older app's payment records, as the wallet's send log wants them (and removes them from `log`). */
export function takeLegacySends(log: AppLog): SendLogEntry[] {
  const out = Object.values(log.sends ?? {}).map(
    (r): SendLogEntry => ({
      txid: r.txid,
      at: r.at,
      recipient: r.address,
      amountSats: r.amountSats,
      feeSats: r.feeSats,
      signedBy: r.signedBy === 'phone+guardian' ? 'guardian' : 'hardware',
    }),
  );
  delete log.sends;
  return out;
}

let counter = 0;
export function addEvent(log: AppLog, event: DistributiveOmit<SecurityEvent, 'id' | 'at'> & { at: number }): void {
  counter += 1;
  log.events = [{ ...event, id: `ev-${event.at}-${counter}` } as StoredEvent, ...log.events].slice(0, MAX_EVENTS);
}

const iso = (ms: number): IsoDate => new Date(ms).toISOString();

/**
 * The wallet's history (the guardian's, with the wallet's send log merged in: recipient, signer, payments the
 * guardian has not listed yet) as the Activity list, plus the security events.
 */
export function buildActivity(history: WalletHistoryEntry[], log: AppLog, nowMs: number, silentReceived: readonly WalletSilentCoin[] = []): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const h of history) {
    const confirmed = h.confirmations > 0;
    const at = confirmed && h.time ? h.time * 1000 : (h.sentAt ?? log.seen[h.txid] ?? nowMs);
    const sent = h.netSats < 0;
    const fee = h.feeSats;
    // A received silent payment moved into the vault shows as the move, not as a payment from somebody.
    const move = h.silentSweep ? silentReceived.find((c) => c.txid === h.silentSweep!.fromTxid && c.vout === h.silentSweep!.fromVout) : undefined;
    const tx: Transaction = {
      id: h.txid,
      kind: h.silentSweep ? 'silent_sweep' : sent ? 'sent' : 'received',
      amountSats: sent ? (h.amountSats ?? Math.max(0, -h.netSats - (fee ?? 0))) : h.netSats,
      ...(sent ? { feeSats: fee } : {}),
      ...(h.silentSweep && move ? { feeSats: Math.max(0, move.valueSats - h.netSats) } : {}),
      status: confirmed ? 'confirmed' : 'pending',
      at: iso(at),
      ...(sent && h.recipient ? { address: h.recipient } : {}),
      ...(sent && h.signedBy ? { signedBy: h.signedBy === 'guardian' ? ('phone+guardian' as const) : ('phone+hardware' as const) } : {}),
      ...(sent && h.silentPayment ? { silentOutputAddress: h.silentPayment.outputAddress } : {}),
      txid: h.txid,
    };
    items.push({ type: 'payment', at: tx.at, tx });
  }
  // What was received to the silent payment address: found by a scan, waiting (or moved).
  for (const c of silentReceived) {
    const tx: Transaction = {
      id: `sp-rx-${c.txid}:${c.vout}`,
      kind: 'silent_received',
      amountSats: c.valueSats,
      status: c.height > 0 ? 'confirmed' : 'pending',
      at: iso(c.foundAt),
      txid: c.txid,
      ...(c.label !== undefined ? { silentLabel: c.label } : {}),
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
