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
 */
import type { Alert } from '@trikey/protocol';
import { formatBtc, formatWhen } from '../alerts.js';
import type { Guardian } from '../guardian.js';
import { errorText } from '../log.js';
import type { DueAlert } from '../policy/index.js';
import { stampOf, toSeconds } from '../nostr/wire.js';
import type { HostedEngine } from './engine.js';
import type { Hosting } from './service.js';
import type { HostedNotice, HostedRecoveryRecord } from './types.js';

const SURVIVOR = { hardware: 'hardware wallet', app: 'phone' } as const;

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
export function hostedAlertText(a: DueAlert, rec: HostedRecoveryRecord | undefined, label: string, form: 'long' | 'short' = 'long'): string {
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
  const howToCancel = `To stop it, reply to this message with:\n\nCANCEL ${id}\n\nor cancel it in the Trikey app.`;
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
    for (const n of engine.dueNotices()) {
      const delivered: string[] = [];
      for (const to of n.recipients) {
        try {
          const ok = to === phone ? n.kind === 'hosting_ending' && (await g.notifyPeer(to, hostingEndingWire(n))) : (await g.dm.send(to, hostingEndingText(n, label))).some((o) => o.ok);
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
          const ok = phones.has(to) ? await g.notifyPeer(to, hostedAlertToWire(a, rec, label)) : (await g.dm.send(to, hostedAlertText(a, rec, label))).some((o) => o.ok);
          if (ok) delivered.push(to);
        } catch (e) {
          g.log.warn('hosting.alert_failed', { error: errorText(e) });
        }
      }
      if (delivered.length) await engine.markAlertSent(a.id, delivered);
    }
  }
}
