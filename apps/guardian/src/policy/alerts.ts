/**
 * Delay & Notify alert schedule. The engine only says which alerts are due;
 * the service sends them (nostr DMs) and reports back with `markAlertSent`.
 *
 * For a running recovery: one alert when it starts, a reminder every 24 h,
 * and one when the delay has elapsed. If the guardian was offline and several
 * reminders were missed, only the latest one is due (no backlog of stale
 * reminders). A cancelled or completed recovery owes one final alert.
 */
import { DAY } from './clock.js';
import { RecoveryRecord, SurvivingRole } from './types.js';

export type AlertKind = 'recovery_started' | 'recovery_reminder' | 'recovery_ready' | 'recovery_cancelled' | 'recovery_completed';

export interface DueAlert {
  id: string;
  kind: AlertKind;
  recoveryId: string;
  dueAt: number;
  /** Recipients (nostr pubkeys) that have not been sent this alert yet. */
  recipients: string[];
  survivingRole: SurvivingRole;
  amountSats: bigint;
  readyAt: number;
  /** Whole days until the delay ends (0 once it has). */
  daysLeft: number;
}

interface Scheduled {
  id: string;
  kind: AlertKind;
  dueAt: number;
}

function scheduled(rec: RecoveryRecord, now: number): Scheduled[] {
  const id = rec.id;
  if (rec.status === 'cancelled') return [{ id: `${id}/cancelled`, kind: 'recovery_cancelled', dueAt: rec.cancelledAt! }];
  if (rec.status === 'completed') return [{ id: `${id}/completed`, kind: 'recovery_completed', dueAt: rec.completedAt! }];
  const out: Scheduled[] = [{ id: `${id}/started`, kind: 'recovery_started', dueAt: rec.startedAt }];
  if (now >= rec.readyAt) {
    out.push({ id: `${id}/ready`, kind: 'recovery_ready', dueAt: rec.readyAt });
    return out;
  }
  const k = Math.floor((now - rec.startedAt) / DAY);
  if (k >= 1) out.push({ id: `${id}/reminder-${k}`, kind: 'recovery_reminder', dueAt: rec.startedAt + k * DAY });
  return out;
}

export function dueAlerts(recoveries: RecoveryRecord[], now: number): DueAlert[] {
  const out: DueAlert[] = [];
  for (const rec of recoveries) {
    for (const s of scheduled(rec, now)) {
      if (s.dueAt > now) continue;
      const sent = new Set(rec.alertsSent[s.id] ?? []);
      const recipients = rec.recipients.filter((r) => !sent.has(r));
      if (!recipients.length) continue;
      out.push({
        ...s,
        recoveryId: rec.id,
        recipients,
        survivingRole: rec.survivingRole,
        amountSats: rec.amountSats,
        readyAt: rec.readyAt,
        // From the anchored start when the clock reads earlier (set back): the delay as it really runs.
        daysLeft: Math.max(0, Math.ceil((rec.readyAt - Math.max(now, rec.anchoredAt ?? now)) / DAY)),
      });
    }
  }
  return out;
}

/** The ids `dueAlerts` could ever return for `rec` (used to validate `markAlertSent`). */
export function isKnownAlertId(rec: RecoveryRecord, alertId: string): boolean {
  const rest = alertId.startsWith(`${rec.id}/`) ? alertId.slice(rec.id.length + 1) : undefined;
  if (rest === undefined) return false;
  if (['started', 'ready', 'cancelled', 'completed'].includes(rest)) return true;
  const m = /^reminder-(\d+)$/.exec(rest);
  return !!m && Number(m[1]) >= 1 && Number(m[1]) < rec.delayDays;
}
