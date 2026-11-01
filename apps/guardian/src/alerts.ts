/**
 * Delay & Notify alerts. The engine says which alerts are due and to whom
 * (`dueAlerts()`); this sends them and reports back (`markAlertSent`):
 *
 * - to the paired phone as a protocol notification (`RpcServer.notify`);
 * - to every alert contact as a NIP-17 DM in plain words: what happened, when
 *   it completes, and how to cancel (reply "CANCEL <recovery id>" or use the
 *   Trikey app). dm-cancel.ts handles such replies.
 *
 * A recipient is marked as sent once at least one relay accepted the event;
 * otherwise the alert stays due and the next tick retries it. Fields the
 * engine's `DueAlert` lacks (`cancelledBy`, `contested`, the txid) come from
 * the recovery record and the engine's activity log.
 */
import type { Alert } from '@trikey/protocol';
import type { Guardian } from './guardian.js';
import { errorText } from './log.js';
import type { DueAlert, LimitNotice, RecoveryRecord } from './policy/index.js';
import { stampOf, toSeconds } from './nostr/wire.js';
import { npubEncode } from 'nostr-tools/nip19';

export function formatBtc(sats: bigint | number): string {
  const s = BigInt(sats);
  const whole = s / 100_000_000n;
  const frac = (s % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${frac} BTC (${s.toLocaleString('en-US')} sats)`;
}

export function formatWhen(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
}

const SURVIVOR: Record<RecoveryRecord['survivingRole'], string> = { hardware: 'hardware wallet', app: 'phone' };
const CANCELLER = { app: "the owner's phone", contact: 'an alert contact', hardware: 'the hardware wallet', superseded: 'the guardian, because another recovery already swept the wallet' } as const;

function contestedOf(g: Guardian, rec: RecoveryRecord): boolean {
  const entry = g.engine.activity({ limit: 5000 }).find((e) => e.type === 'recovery_cancelled' && e.recoveryId === rec.id);
  if (entry && entry.type === 'recovery_cancelled') return entry.contested;
  // Same rule as the engine: only the key that started the recovery cancels it uncontested.
  const by = rec.cancelledBy?.kind;
  if (by === 'superseded') return false;
  return !((by === 'app' && rec.survivingRole === 'app') || (by === 'hardware' && rec.survivingRole === 'hardware'));
}

/** The wire alert for the phone. */
export function alertToWire(g: Guardian, a: DueAlert, rec: RecoveryRecord | undefined): Alert {
  const stamp = stampOf(a.dueAt);
  const message = alertText(g, a, rec, 'short');
  switch (a.kind) {
    case 'recovery_started':
    case 'recovery_ready':
      return { type: a.kind, ...stamp, recoveryId: a.recoveryId, readyAt: toSeconds(a.readyAt), survivingRole: a.survivingRole, amountSats: Number(a.amountSats), message };
    case 'recovery_reminder':
      return {
        type: 'recovery_reminder',
        ...stamp,
        recoveryId: a.recoveryId,
        readyAt: toSeconds(a.readyAt),
        survivingRole: a.survivingRole,
        amountSats: Number(a.amountSats),
        daysLeft: a.daysLeft,
        message,
      };
    case 'recovery_cancelled':
      return {
        type: 'recovery_cancelled',
        ...stamp,
        recoveryId: a.recoveryId,
        cancelledBy: rec?.cancelledBy?.kind ?? 'app',
        ...(rec ? { contested: contestedOf(g, rec) } : {}),
        message,
      };
    case 'recovery_completed':
      return { type: 'recovery_completed', ...stamp, recoveryId: a.recoveryId, ...(rec ? { txid: rec.sweepTxid } : {}), message };
  }
}

/** Plain-language text: `long` for contacts' DMs, `short` (at most 500 chars) for the phone's `message`. */
export function alertText(g: Guardian, a: DueAlert, rec: RecoveryRecord | undefined, form: 'long' | 'short' = 'long'): string {
  const id = a.recoveryId;
  const amount = formatBtc(a.amountSats);
  const ends = formatWhen(a.readyAt);
  // While the rules let the contacts lock the guardian (rule 8), a running recovery's DMs say so too: locking does
  // not stop the recovery, but it stops the guardian co-signing anything, the recovery's sweep included.
  const lockHint = g.engine.status().rules?.contactLock ? `\n\nCANCEL stops this recovery. ${LOCK_HINT}` : '';
  const howToCancel = `To stop it, reply to this message with:\n\nCANCEL ${id}\n\nor cancel it in the Trikey app.${lockHint}`;
  if (form === 'short') {
    switch (a.kind) {
      case 'recovery_started':
        return `A recovery started with the ${SURVIVOR[a.survivingRole]}. It moves ${amount} on ${ends} unless cancelled.`;
      case 'recovery_reminder':
        return `Recovery ${id} is still waiting: ${a.daysLeft} day(s) left, completes ${ends}.`;
      case 'recovery_ready':
        return `The waiting period of recovery ${id} has ended; the guardian will now complete it.`;
      case 'recovery_cancelled':
        return `Recovery ${id} was cancelled.`;
      case 'recovery_completed':
        return `Recovery ${id} completed: the funds moved to the new wallet.`;
    }
  }
  switch (a.kind) {
    case 'recovery_started':
      return [
        'Trikey alert: someone started a recovery of the bitcoin wallet you help protect.',
        '',
        `What happened: on ${formatWhen(rec?.startedAt ?? a.dueAt)}, the wallet's ${SURVIVOR[a.survivingRole]} asked the owner's Trikey Guardian to move ${amount} to a new wallet.`,
        `When it completes: ${ends} (in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}), unless someone cancels it.`,
        '',
        'If the owner did not ask for this, or you are not sure, cancel it now and talk to them.',
        howToCancel,
      ].join('\n');
    case 'recovery_reminder':
      return [
        `Trikey reminder: the recovery ${id} of the wallet you help protect is still waiting.`,
        '',
        `It moves ${amount} to a new wallet on ${ends} (${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left), unless someone cancels it.`,
        howToCancel,
      ].join('\n');
    case 'recovery_ready':
      return [
        `Trikey alert: the waiting period of recovery ${id} ended on ${ends}.`,
        '',
        `The guardian will now co-sign and broadcast the move of ${amount} to the new wallet.`,
        'If this is unexpected, cancel it right away.',
        howToCancel,
      ].join('\n');
    case 'recovery_cancelled': {
      const by = rec?.cancelledBy ? CANCELLER[rec.cancelledBy.kind] : 'someone';
      const when = rec?.cancelledAt !== undefined ? ` on ${formatWhen(rec.cancelledAt)}` : '';
      const paused = rec && contestedOf(g, rec) ? ' Phone-only payments stay paused until the owner confirms with their hardware wallet.' : '';
      return `Trikey: the recovery ${id} was cancelled by ${by}${when}. No funds moved.${paused}`;
    }
    case 'recovery_completed': {
      const when = rec?.completedAt !== undefined ? ` on ${formatWhen(rec.completedAt)}` : '';
      return `Trikey: the recovery ${id} completed${when}. ${amount} moved to the new wallet in transaction ${rec?.sweepTxid ?? '(unknown)'}.`;
    }
  }
}

const satsText = (sats: bigint | number) => `${BigInt(sats).toLocaleString('en-US')} sats`;

/** A contact as the alerts name it: its npub (the guardian knows no names; the phone shows its own). */
function npubOf(pubkey: string): string {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/** What a contact can do while the rules let the contacts lock the guardian (rule 8): one line for their DMs. */
export const LOCK_HINT = 'If something looks wrong and you cannot reach the owner, you can lock the guardian (it then co-signs nothing until the owner unlocks it) by replying with: LOCK';

/** The wire alert of a limit change or a contact lock, for the paired phone (`undefined`: a notice for contacts only). */
export function noticeToWire(n: LimitNotice): Alert | undefined {
  const stamp = stampOf(n.at);
  if (n.kind === 'contact_lock_on' || n.kind === 'contact_lock_off') return undefined;
  if (n.kind === 'contact_lock')
    return {
      type: 'guardian_locked',
      ...stamp,
      reason: 'contact',
      ...(n.contact ? { contact: n.contact } : {}),
      message: 'An alert contact locked your guardian: it co-signs nothing until you unlock it. If you did not expect this, check what they saw.',
    };
  if (n.kind === 'limit_off')
    return {
      type: 'limit_off',
      ...stamp,
      sequence: n.sequence ?? 1,
      ...(n.limitSats !== undefined ? { limitBeforeSats: Number(n.limitSats) } : {}),
      message: 'The daily limit is off, approved on your hardware wallet. Your phone and your guardian together can now send everything.',
    };
  const limit = n.limitSats ?? 0n;
  return {
    type: 'limit_on',
    ...stamp,
    limitSats: Number(limit),
    reason: n.reason ?? 'phone',
    message:
      n.reason === 'recovery'
        ? `After the recovery the daily limit is back on, at ${satsText(limit)}. Your hardware wallet can turn it off again once it has confirmed the new wallet.`
        : `The daily limit is back on: ${satsText(limit)} in 24 hours without your hardware wallet.`,
  };
}

/**
 * The NIP-17 DM to an alert contact (`limit_off`, `contact_lock`, `contact_lock_on` and `contact_lock_off` go to
 * contacts). `canLock`: the rules let the contacts lock the guardian now, so a `limit_off` DM says how.
 */
export function noticeText(n: LimitNotice, canLock = false): string {
  if (n.kind === 'contact_lock_on')
    return [
      'Trikey: the owner of the bitcoin wallet you help protect now lets you lock their Trikey Guardian.',
      '',
      'If you ever see something they did not do (a recovery they did not start, their limit turned off, a message that looks wrong), you can send this guardian the single word:',
      '',
      'LOCK',
      '',
      'It then co-signs nothing until the owner unlocks it, and the owner and the other alert contacts are told it was you. You cannot unlock it, change its rules or see the wallet; locking moves no funds.',
    ].join('\n');
  if (n.kind === 'contact_lock_off')
    return `Trikey: on ${formatWhen(n.at)} the owner's hardware wallet approved that alert contacts can no longer lock the guardian of the wallet you help protect. LOCK messages now do nothing. You still get its alerts and can still cancel a recovery. If the owner did not mean to do this, talk to them.`;
  if (n.kind === 'contact_lock')
    return [
      'Trikey alert: the Trikey Guardian of the bitcoin wallet you help protect was locked by another alert contact.',
      '',
      `Who and when: ${n.contact ? npubOf(n.contact) : 'an alert contact'}, on ${formatWhen(n.at)}, by sending LOCK to the guardian.`,
      'While it is locked the guardian co-signs nothing, so the owner can only pay with their hardware wallet. No funds moved. Only the owner can unlock it.',
      '',
      'If you know why, nothing else is needed. If not, talk to the owner.',
    ].join('\n');
  if (n.kind === 'limit_on') return `Trikey: the daily limit of the wallet you help protect is back on (${satsText(n.limitSats ?? 0n)} in 24 hours).`;
  return [
    'Trikey alert: the daily limit of the bitcoin wallet you help protect was turned off.',
    '',
    `What happened: on ${formatWhen(n.at)}, the owner's hardware wallet approved turning off the daily limit${n.limitSats !== undefined ? ` (it was ${formatBtc(n.limitSats)})` : ''}. From now on, their phone and their Trikey Guardian together can send everything in the wallet at once.`,
    '',
    'If the owner did not mean to do this, or you are not sure, talk to them now. They can turn the limit back on from their phone alone.',
    ...(canLock ? ['', LOCK_HINT] : []),
  ].join('\n');
}

export class Alerter {
  private running?: Promise<void>;
  private again = false;

  constructor(private readonly g: Guardian) {}

  /** Sends every due alert. Overlapping calls coalesce into one more pass. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.once();
        } catch (e) {
          this.g.log.error('alerts.failed', { error: errorText(e) });
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Limit changes (`limit_off`, `limit_on`): a protocol alert to the phone among the recipients (the wallet's paired
   * phone), a NIP-17 DM to the alert contacts. Undelivered ones are retried at the next pass, as recovery alerts are.
   */
  private async sendNotices(): Promise<void> {
    const g = this.g;
    const canLock = !!g.engine.status().rules?.contactLock;
    for (const n of g.engine.dueNotices()) {
      const phone = g.engine.walletById(n.walletId)?.appNostrPubkey;
      const delivered: string[] = [];
      for (const to of n.recipients) {
        try {
          const wire = to === phone ? noticeToWire(n) : undefined;
          const ok = to === phone ? !!wire && (await g.notifyPeer(to, wire)) : (await g.dm!.send(to, noticeText(n, canLock))).some((o) => o.ok);
          if (ok) delivered.push(to);
          else g.log.warn('alert.not_delivered', { alertId: n.id, to: to === phone ? 'phone' : 'contact' });
        } catch (e) {
          g.log.warn('alert.send_failed', { alertId: n.id, error: errorText(e) });
        }
      }
      if (delivered.length) {
        const res = await g.engine.markNoticeSent(n.id, delivered);
        if (res.ok) g.log.info('alert.sent', { alertId: n.id, kind: n.kind, recipients: delivered.length });
      }
    }
  }

  /** `${alertId}:${pubkey}` already sent to a phone with recovery access (not tracked by the engine). */
  private readonly sentToPeers = new Set<string>();

  private async once(): Promise<void> {
    const g = this.g;
    const due = g.engine.dueAlerts();
    if (!g.rpc || !g.dm) return;
    await this.sendNotices();
    if (!due.length) return;
    const current = g.engine.registration()?.appNostrPubkey;
    for (const a of due) {
      const rec = g.records.find((r) => r.id === a.recoveryId);
      // Phones get protocol alerts, contacts NIP-17 DMs. After a rotation the swept wallet's phone is no
      // longer the paired one, but it is still a phone.
      const phones = new Set([current, rec ? g.engine.walletById(rec.walletId)?.appNostrPubkey : undefined].filter((x): x is string => !!x));
      // A phone recovering the wallet with the hardware wallet (recovery.access), and the phone that started
      // this recovery, get the protocol alert too, best effort.
      const extra = new Set([...g.recoveryPeers(), ...(rec?.initiator ? [rec.initiator] : [])]);
      for (const peer of extra) {
        const key = `${a.id}:${peer}`;
        if (phones.has(peer) || a.recipients.includes(peer) || rec?.recipients.includes(peer) || this.sentToPeers.has(key)) continue;
        try {
          if ((await g.rpc.notify(peer, alertToWire(g, a, rec))).some((o) => o.ok)) this.sentToPeers.add(key);
        } catch (e) {
          g.log.warn('alert.peer_failed', { alertId: a.id, error: errorText(e) });
        }
      }
      const delivered: string[] = [];
      for (const to of a.recipients) {
        try {
          const ok = phones.has(to) ? await g.notifyPeer(to, alertToWire(g, a, rec)) : (await g.dm.send(to, alertText(g, a, rec))).some((o) => o.ok);
          if (ok) delivered.push(to);
          else g.log.warn('alert.not_delivered', { alertId: a.id, to: phones.has(to) ? 'phone' : 'contact' });
        } catch (e) {
          g.log.warn('alert.send_failed', { alertId: a.id, error: errorText(e) });
        }
      }
      if (delivered.length) {
        const res = await g.engine.markAlertSent(a.id, delivered);
        if (res.ok) g.log.info('alert.sent', { alertId: a.id, kind: a.kind, recipients: delivered.length });
      }
    }
  }
}
