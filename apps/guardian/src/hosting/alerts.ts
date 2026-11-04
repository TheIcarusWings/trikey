/**
 * Guest wallets' alerts (docs/design/family-hosting.md, section 8): the slots' recovery alerts and notices
 * (`hosting_ending`), sent with the guardian's one nostr identity through the existing transports (`notifyPeer` for
 * the guest's phone, the NIP-17 `DirectMessages` for the guest's contacts). Kept apart from the host's `Alerter`
 * (alerts.ts): a guest's alert names the wallet by the label the guest chose, never the host's private name for them,
 * and says nothing of the host's wallet; the host's alerts are untouched.
 *
 * Never the notifier (notify/notifier.ts): the host's email, ntfy and webhook channels are the host's, for its own wallet
 * and host-level events. A guest's alerts go to the guest's phone and the guest's own contacts as nostr DMs only, even
 * to a contact who also has channels as one of the host's contacts (guests' own channels are phase 2).
 *
 * Phase 2 (section 16) adds the slot's `limit_off` / `limit_on` notices (the host's rule, worded for the guest's wallet)
 * and the per-slot contact lock: `contact_lock` (a contact PAUSED this wallet: `wallet_paused` to the phone, a DM to the
 * other contacts) and `contact_lock_on` / `_off` (the contacts may now pause it, or no longer may).
 */
import type { Alert } from '@trikey/protocol';
import { formatBtc, formatWhen, noticeToWire } from '../alerts.js';
import { npubEncode } from 'nostr-tools/nip19';
import type { Guardian } from '../guardian.js';
import { errorText } from '../log.js';
import type { DueAlert } from '../policy/index.js';
import { stampOf, toSeconds } from '../nostr/wire.js';
import type { HostedEngine } from './engine.js';
import type { Hosting } from './service.js';
import type { HostedNotice, HostedRecoveryRecord } from './types.js';

const SURVIVOR = { hardware: 'hardware wallet', app: 'phone' } as const;

/** A guest wallet's contacts, while its rules let them pause it (section 16): one line for their DMs. */
export const PAUSE_HINT =
  'If something looks wrong and you cannot reach the owner, you can pause this wallet (its guardian then co-signs no payment for it until the owner resumes it with their hardware wallet) by replying with: LOCK';

function npubOf(pubkey: string): string {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

function abandonLine(rec: HostedRecoveryRecord | undefined): string {
  if (!rec || !rec.abandon.length) return '';
  return ` This recovery leaves ${rec.abandon.length} coin${rec.abandon.length === 1 ? '' : 's'} (${formatBtc(rec.abandonSats)}) behind on purpose: coins the hardware wallet cannot sign.`;
}

/** The phone's protocol alert for a guest wallet's recovery. */
export function hostedAlertToWire(a: DueAlert, rec: HostedRecoveryRecord | undefined, label: string): Alert {
  const stamp = stampOf(a.dueAt);
  const message = hostedAlertText(a, rec, label, 'short');
  switch (a.kind) {
    case 'recovery_started':
    case 'recovery_ready':
      return { type: a.kind, ...stamp, recoveryId: a.recoveryId, readyAt: toSeconds(a.readyAt), survivingRole: a.survivingRole, amountSats: Number(a.amountSats), message };
    case 'recovery_reminder':
      return { type: 'recovery_reminder', ...stamp, recoveryId: a.recoveryId, readyAt: toSeconds(a.readyAt), survivingRole: a.survivingRole, amountSats: Number(a.amountSats), daysLeft: a.daysLeft, message };
    case 'recovery_cancelled':
      return { type: 'recovery_cancelled', ...stamp, recoveryId: a.recoveryId, cancelledBy: rec?.cancelledBy?.kind ?? 'app', message };
    case 'recovery_completed':
      return { type: 'recovery_completed', ...stamp, recoveryId: a.recoveryId, ...(rec ? { txid: rec.sweepTxid } : {}), message };
  }
}

/** Plain words for a guest wallet's recovery: `long` for the contacts' DMs, `short` (at most 500 characters) for the phone. */
export function hostedAlertText(a: DueAlert, rec: HostedRecoveryRecord | undefined, label: string, form: 'long' | 'short' = 'long', canPause = false): string {
  const id = a.recoveryId;
  const amount = formatBtc(a.amountSats);
  const ends = formatWhen(a.readyAt);
  const left = abandonLine(rec);
  if (form === 'short') {
    switch (a.kind) {
      case 'recovery_started':
        return `A recovery of "${label}" started with the ${SURVIVOR[a.survivingRole]}. It moves ${amount} on ${ends} unless cancelled.${left}`.slice(0, 500);
      case 'recovery_reminder':
        return `Recovery ${id} of "${label}" is still waiting: ${a.daysLeft} day(s) left, completes ${ends}.`;
      case 'recovery_ready':
        return `The waiting period of recovery ${id} of "${label}" has ended; the guardian will now complete it.`;
      case 'recovery_cancelled':
        return `Recovery ${id} of "${label}" was cancelled.`;
      case 'recovery_completed':
        return `Recovery ${id} of "${label}" completed: the funds moved to the new wallet.`;
    }
  }
  const pauseHint = canPause ? `\n\nCANCEL stops this recovery. ${PAUSE_HINT}` : '';
  const howToCancel = `To stop it, reply to this message with:\n\nCANCEL ${id}\n\nor cancel it in the Trikey app.${pauseHint}`;
  switch (a.kind) {
    case 'recovery_started':
      return [
        `Trikey alert: someone started a recovery of the bitcoin wallet "${label}" you help protect.`,
        '',
        `What happened: on ${formatWhen(rec?.startedAt ?? a.dueAt)}, the wallet's ${SURVIVOR[a.survivingRole]} asked its Trikey Guardian to move ${amount} to a new wallet.${left}`,
        `When it completes: ${ends} (in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}), unless someone cancels it.`,
        '',
        'If the owner did not ask for this, or you are not sure, cancel it now and talk to them.',
        howToCancel,
      ].join('\n');
    case 'recovery_reminder':
      return [`Trikey reminder: the recovery ${id} of "${label}" is still waiting.`, '', `It moves ${amount} to a new wallet on ${ends} (${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left), unless someone cancels it.${left}`, howToCancel].join('\n');
    case 'recovery_ready':
      return [`Trikey alert: the waiting period of recovery ${id} of "${label}" ended on ${ends}.`, '', `The guardian will now co-sign and broadcast the move of ${amount} to the new wallet.`, 'If this is unexpected, cancel it right away.', howToCancel].join('\n');
    case 'recovery_cancelled':
      return `Trikey: the recovery ${id} of "${label}" was cancelled${rec?.cancelledAt !== undefined ? ` on ${formatWhen(rec.cancelledAt)}` : ''}. No funds moved.`;
    case 'recovery_completed':
      return `Trikey: the recovery ${id} of "${label}" completed${rec?.completedAt !== undefined ? ` on ${formatWhen(rec.completedAt)}` : ''}. ${amount} moved to the new wallet in transaction ${rec?.sweepTxid ?? '(unknown)'}.`;
  }
}

export function hostingEndingWire(n: HostedNotice): Alert {
  const ends = n.endsAt ?? n.at;
  return {
    type: 'hosting_ending',
    ...stampOf(n.at),
    walletId: n.walletId,
    endsAt: toSeconds(ends),
    message: `Your host stopped hosting this wallet. Its guardian key works until ${formatWhen(ends)}. Move your money before then: Settings > Replace guardian.`,
  };
}

export function hostingEndingText(n: HostedNotice, label: string): string {
  const ends = formatWhen(n.endsAt ?? n.at);
  return [
    `Trikey: the guardian that holds one key of the bitcoin wallet "${label}" you help protect will stop hosting it on ${ends}.`,
    '',
    'Its owner should move the wallet to another guardian before then (Replace guardian in the Trikey app). Their money stays safe either way: their phone and hardware wallet can always move it.',
  ].join('\n');
}

/** The phone's protocol alert for a slot notice (`undefined`: a notice for the contacts only). */
export function hostedNoticeToWire(n: HostedNotice): Alert | undefined {
  switch (n.kind) {
    case 'hosting_ending':
      return hostingEndingWire(n);
    case 'limit_off':
    case 'limit_on':
      // The host's wire alert; its words name no wallet, so they fit a guest's phone as they are.
      return noticeToWire({ id: n.id, kind: n.kind, walletId: n.walletId, at: n.at, ...(n.sequence !== undefined ? { sequence: n.sequence } : {}), ...(n.limitSats !== undefined ? { limitSats: n.limitSats } : {}), ...(n.reason ? { reason: n.reason } : {}), recipients: n.recipients, sent: n.sent });
    case 'contact_lock':
      return {
        type: 'wallet_paused',
        ...stampOf(n.at),
        walletId: n.walletId,
        by: 'contact',
        ...(n.contact ? { contact: n.contact } : {}),
        message: 'One of your alert contacts paused this wallet: your guardian co-signs no payment for it until your hardware wallet resumes it. If you did not expect this, check what they saw.',
      };
    case 'contact_lock_on':
    case 'contact_lock_off':
      return undefined;
  }
}

/** The NIP-17 DM to a guest wallet's contact about a slot notice, naming the wallet by the label its owner chose. */
export function hostedNoticeText(n: HostedNotice, label: string, canPause = false): string {
  switch (n.kind) {
    case 'hosting_ending':
      return hostingEndingText(n, label);
    case 'limit_off':
      return [
        `Trikey alert: the daily limit of the bitcoin wallet "${label}" you help protect was turned off.`,
        '',
        `What happened: on ${formatWhen(n.at)}, the owner's hardware wallet approved turning off the daily limit${n.limitSats !== undefined ? ` (it was ${formatBtc(n.limitSats)})` : ''}. From now on, their phone and their Trikey Guardian together can send everything in the wallet at once.`,
        '',
        'If the owner did not mean to do this, or you are not sure, talk to them now. They can turn the limit back on from their phone alone.',
        ...(canPause ? ['', PAUSE_HINT] : []),
      ].join('\n');
    case 'limit_on':
      return `Trikey: the daily limit of the wallet "${label}" you help protect is back on (${(n.limitSats ?? 0n).toLocaleString('en-US')} sats in 24 hours).`;
    case 'contact_lock':
      return [
        `Trikey alert: the bitcoin wallet "${label}" you help protect was paused by another alert contact.`,
        '',
        `Who and when: ${n.contact ? npubOf(n.contact) : 'an alert contact'}, on ${formatWhen(n.at)}, by sending LOCK to its guardian.`,
        'While it is paused the guardian co-signs no payment for it, so the owner can only pay with their hardware wallet. No funds moved. Only the owner can resume it, with their hardware wallet.',
        '',
        'If you know why, nothing else is needed. If not, talk to the owner.',
      ].join('\n');
    case 'contact_lock_on':
      return [
        `Trikey: the owner of the bitcoin wallet "${label}" you help protect now lets you pause it.`,
        '',
        'If you ever see something they did not do (a recovery they did not start, their limit turned off, a message that looks wrong), you can send its guardian the single word:',
        '',
        'LOCK',
        '',
        "Its guardian then co-signs no payment for this wallet until the owner resumes it with their hardware wallet, and the owner and the other alert contacts are told it was you. You cannot resume it, change its rules or see the wallet; pausing moves no funds.",
      ].join('\n');
    case 'contact_lock_off':
      return `Trikey: on ${formatWhen(n.at)} the owner's hardware wallet approved that alert contacts can no longer pause the wallet "${label}" you help protect. LOCK messages now do nothing for it. You still get its alerts and can still cancel a recovery. If the owner did not mean to do this, talk to them.`;
  }
}

export class HostedAlerter {
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly g: Guardian,
    private readonly h: Hosting,
  ) {}

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        for (const { engine } of this.h.liveSlots()) {
          try {
            await this.once(engine);
          } catch (e) {
            this.g.log.error('hosting.alerts_failed', { slot: engine.slotId, error: errorText(e) });
          }
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async once(engine: HostedEngine): Promise<void> {
    const g = this.g;
    if (!g.rpc || !g.dm) return;
    const reg = engine.registration();
    const label = reg?.walletLabel ?? 'your wallet';
    const phone = reg?.appNostrPubkey;
    const canPause = !!engine.rules()?.contactLock;
    for (const n of engine.dueNotices()) {
      const delivered: string[] = [];
      const wire = hostedNoticeToWire(n);
      for (const to of n.recipients) {
        try {
          const ok = to === phone ? !!wire && (await g.notifyPeer(to, wire)) : (await g.dm.send(to, hostedNoticeText(n, label, canPause))).some((o) => o.ok);
          if (ok) delivered.push(to);
        } catch (e) {
          g.log.warn('hosting.notice_failed', { error: errorText(e) });
        }
      }
      if (delivered.length) await engine.markNoticeSent(n.id, delivered);
    }
    for (const a of engine.dueAlerts()) {
      const rec = engine.records().find((r) => r.id === a.recoveryId);
      const phones = new Set([phone, rec ? engine.walletById(rec.walletId)?.appNostrPubkey : undefined, rec?.initiator].filter((x): x is string => !!x));
      const delivered: string[] = [];
      for (const to of a.recipients) {
        try {
          const ok = phones.has(to) ? await g.notifyPeer(to, hostedAlertToWire(a, rec, label)) : (await g.dm.send(to, hostedAlertText(a, rec, label, 'long', canPause))).some((o) => o.ok);
          if (ok) delivered.push(to);
        } catch (e) {
          g.log.warn('hosting.alert_failed', { error: errorText(e) });
        }
      }
      if (delivered.length) await engine.markAlertSent(a.id, delivered);
    }
  }
}
