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
import { safeName, type Alert } from '@trikey/protocol';
import type { Guardian } from './guardian.js';
import { labelled, type WalletRuntime } from './runtime.js';
import { errorText } from './log.js';
import type { DueAlert, LimitNotice, RecoveryRecord } from './policy/index.js';
import { stampOf, toSeconds } from './nostr/wire.js';
import { contactId } from './policy/authorizer.js';
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

function contestedOf(w: WalletRuntime, rec: RecoveryRecord): boolean {
  const entry = w.engine.activity({ limit: 5000 }).find((e) => e.type === 'recovery_cancelled' && e.recoveryId === rec.id);
  if (entry && entry.type === 'recovery_cancelled') return entry.contested;
  // Same rule as the engine: only the key that started the recovery cancels it uncontested.
  const by = rec.cancelledBy?.kind;
  if (by === 'superseded') return false;
  return !((by === 'app' && rec.survivingRole === 'app') || (by === 'hardware' && rec.survivingRole === 'hardware'));
}

/** The wire alert for the phone. */
export function alertToWire(w: WalletRuntime, a: DueAlert, rec: RecoveryRecord | undefined): Alert {
  // Wallets after the first: the wallet the alert is about, so the phone files it there.
  const walletId = w.alertWalletId();
  const stamp = { ...stampOf(a.dueAt), ...(walletId ? { walletId } : {}) };
  const message = alertText(w, a, rec, 'short');
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
        ...(rec ? { contested: contestedOf(w, rec) } : {}),
        message,
      };
    case 'recovery_completed':
      return { type: 'recovery_completed', ...stamp, recoveryId: a.recoveryId, ...(rec ? { txid: rec.sweepTxid } : {}), message };
  }
}

/**
 * Where a contact reads an alert: `dm`, the NIP-17 DM itself (reply CANCEL / LOCK to it); `nostr`, an email or ntfy
 * channel of a contact with a nostr key (reply on nostr, not here); `none`, a contact reachable only by email or ntfy
 * (warnings only: contact the owner). notify/ renders the last two (docs/design/notifications.md, "Content").
 */
export type ContactReach = 'dm' | 'nostr' | 'none';

/**
 * Plain-language text: `long` for contacts' DMs, `short` (at most 500 chars) for the phone's `message`. `reach`: where
 * a contact reads the long text (`ContactReach`); only the "how to stop it" part differs.
 */
export function alertText(w: WalletRuntime, a: DueAlert, rec: RecoveryRecord | undefined, form: 'long' | 'short' = 'long', reach: ContactReach = 'dm'): string {
  // Once the box has several wallets, every text names the wallet ("Business: ..."); with one it reads as before.
  return labelled(w, plainAlertText(w, a, rec, form, reach));
}

function plainAlertText(w: WalletRuntime, a: DueAlert, rec: RecoveryRecord | undefined, form: 'long' | 'short', reach: ContactReach): string {
  const id = a.recoveryId;
  const amount = formatBtc(a.amountSats);
  const ends = formatWhen(a.readyAt);
  // While the rules let the contacts lock the guardian (rule 8), a running recovery's DMs say so too: locking does
  // not stop the recovery, but it stops the guardian co-signing anything, the recovery's sweep included.
  const canLock = !!w.engine.status().rules?.contactLock;
  const lockHint = canLock ? `\n\nCANCEL stops this recovery. ${reach === 'nostr' ? LOCK_HINT_NOSTR : LOCK_HINT}` : '';
  const howToCancel =
    reach === 'dm'
      ? `To stop it, reply to this message with exactly this line and nothing else:\n\nCANCEL ${id}\n\nor cancel it in the Trikey app.${lockHint}`
      : reach === 'nostr'
        ? `To stop it, reply to the guardian's nostr message about it, in your nostr app, with exactly this line and nothing else:\n\nCANCEL ${id}\n\nReplying here does nothing. You can also contact the owner.${lockHint}`
        : 'Contact the owner: they, or an alert contact with a nostr app, can cancel it. Replying here does nothing.';
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
        reach === 'none' ? 'If the owner did not ask for this, or you are not sure, contact them now.' : 'If the owner did not ask for this, or you are not sure, cancel it now and talk to them.',
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
        reach === 'none' ? 'If this is unexpected, contact the owner right away.' : 'If this is unexpected, cancel it right away.',
        howToCancel,
      ].join('\n');
    case 'recovery_cancelled': {
      const by = rec?.cancelledBy ? CANCELLER[rec.cancelledBy.kind] : 'someone';
      const when = rec?.cancelledAt !== undefined ? ` on ${formatWhen(rec.cancelledAt)}` : '';
      const paused = rec && contestedOf(w, rec) ? ' Phone-only payments stay paused until the owner confirms with their hardware wallet.' : '';
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
/** The same, on a contact's email or ntfy channel: the reply goes to the guardian's nostr message, not here. */
export const LOCK_HINT_NOSTR =
  "If something looks wrong and you cannot reach the owner, you can lock the guardian (it then co-signs nothing until the owner unlocks it) by replying LOCK to the guardian's nostr message, in your nostr app.";

/** Contacts as the device showed them (`contactId`), for messages and the activity log. */
export function contactIds(contacts: readonly string[] | undefined): string {
  const ids = (contacts ?? []).map((c) => {
    try {
      return contactId(c);
    } catch {
      return c.slice(0, 12);
    }
  });
  return ids.length ? ids.join(', ') : 'none';
}

/** Where a contact change came from, in words. */
function contactChangeHow(n: Pick<LimitNotice, 'pairing' | 'sequence'>): string {
  return n.pairing ? 'when the wallet was set up on this guardian' : n.sequence !== undefined ? "approved on the owner's hardware wallet" : "from the owner's phone";
}

/**
 * The owner's own channels' line for a change of the alert contacts (`contact_added` / `contact_removed`): one per
 * change, carried by the `contact_added` notice (or `contact_removed` when nobody was added).
 */
export function contactChangeOwnerText(n: LimitNotice): string | undefined {
  if (n.kind !== 'contact_added' && n.kind !== 'contact_removed') return undefined;
  if (n.kind === 'contact_removed' && n.added?.length) return undefined;
  const parts = [n.added?.length ? `added ${contactIds(n.added)}` : '', n.removed?.length ? `removed ${contactIds(n.removed)}` : ''].filter(Boolean).join('; ');
  return n.pairing
    ? `Your wallet was set up on your guardian with these alert contacts: ${contactIds(n.added)}. Each of them is told. If one of them is not a contact you chose, check the guardian now.`
    : `Alert contacts changed on your guardian (${contactChangeHow(n)}): ${parts}. Each of them is told. If you did not do this, check the guardian now.`;
}

/**
 * The NIP-17 DM to a contact added (`contact_added`) or removed (`contact_removed`): what they are now, who else changed,
 * and that a change the owner did not tell them about is the alarm (a phone thief swapping the owner's contact for its
 * own, so that a recovery is heard by nobody else). `who`: the owner's name for the guardian, or a guest wallet's label.
 */
export function contactChangeText(
  n: Pick<LimitNotice, 'at' | 'added' | 'removed' | 'pairing' | 'sequence'> & { kind: 'contact_added' | 'contact_removed' },
  who: { guardian: string } | { wallet: string },
  reach: ContactReach = 'dm',
): string {
  const reply = reach === 'dm' ? 'by replying with the line it gives you' : "by replying, in your nostr app, to the guardian's nostr message with the line it gives you";
  const wallet = 'wallet' in who ? `the bitcoin wallet "${who.wallet}"` : `the bitcoin wallet that "${who.guardian}" guards`;
  const others = (list: string[] | undefined, what: string) => (list?.length ? [`${what}: ${contactIds(list)}.`] : []);
  if (n.kind === 'contact_added')
    return [
      `Trikey: you are now an alert contact of ${wallet} (a Trikey Guardian keeps one of its keys).`,
      '',
      `What happened: on ${formatWhen(n.at)}, ${contactChangeHow(n)}, its rules made you one of its alert contacts.`,
      ...others(n.added, 'Alert contacts added'),
      ...others(n.removed, 'Alert contacts removed at the same time'),
      '',
      `What it means: if anyone starts a recovery of this wallet (moving all its money to a new wallet after a waiting period) or turns its daily limit off, this guardian tells you first, and you can cancel the recovery ${reply}.`,
      '',
      'If you do not know who owns this wallet, or they did not ask you, tell them: someone may have chosen you without them. This message needs no answer.',
    ].join('\n');
  return [
    `Trikey alert: you are no longer an alert contact of ${wallet} (a Trikey Guardian keeps one of its keys).`,
    '',
    `What happened: on ${formatWhen(n.at)}, ${contactChangeHow(n)}, its rules stopped naming you. You will not hear of its recoveries any more and cannot cancel them.`,
    ...others(n.added, 'Alert contacts added at the same time'),
    '',
    'If the owner did not tell you about this, call them now: someone with their phone may have replaced their contacts with their own, so that a recovery of the wallet is heard by nobody else. They can cancel a recovery from their hardware wallet and check the guardian\'s web page.',
  ].join('\n');
}

/**
 * The NIP-17 DM to the first wallet's (and the wallet's own) alert contacts about the box: a wallet added
 * (`wallet_added`), an own wallet removed by the owner in the web page (`wallet_removed`), hardware unlock turned on for
 * a wallet (`unlock_slot_added`). The phone's own alerts and the owner's channels say it in their own words.
 */
export function boxNoticeText(n: Pick<LimitNotice, 'at' | 'subjectWalletId' | 'name' | 'approved'> & { kind: 'wallet_added' | 'wallet_removed' | 'unlock_slot_added' }, guardian: string): string {
  // The phone chose the name (a thief's phone can): only its letters, digits, spaces, `-` and `'` (protocol names.ts).
  const name = safeName(n.name, 16);
  const wallet = `${name ? `"${name}" (${n.subjectWalletId ?? ''})` : (n.subjectWalletId ?? 'a wallet')}`;
  if (n.kind === 'wallet_added')
    return [
      `Trikey alert: a wallet was added to the guardian "${guardian}", which also guards the bitcoin wallet you help protect.`,
      '',
      `What happened: on ${formatWhen(n.at)}, the owner's phone added the wallet ${wallet}, with its own hardware wallet${n.approved ? ", approved on the hardware wallet of the wallet you help protect" : ''}. The wallet you help protect is unchanged.`,
      '',
      'If the owner did not do this, or you are not sure, call them now: someone may hold their phone and their hardware wallet.',
    ].join('\n');
  if (n.kind === 'wallet_removed')
    return [
      `Trikey alert: the owner removed the wallet ${wallet} from the guardian "${guardian}" in its web page.`,
      '',
      `What happened: on ${formatWhen(n.at)}, the guardian stopped guarding that wallet: it co-signs nothing for it any more (no recovery of it was running: that would have been refused). Its money stays with its own phone key and hardware wallet. Removing it needs the guardian's passphrase.`,
      '',
      'If the owner did not do this, or you are not sure, call them: someone may know the guardian\'s passphrase.',
    ].join('\n');
  return [
    `Trikey alert: unlocking with a hardware wallet was turned on for the guardian "${guardian}" of the bitcoin wallet you help protect.`,
    '',
    `What happened: on ${formatWhen(n.at)}, the owner's phone and the hardware wallet of ${wallet} added a way to unlock the guardian after a restart or a lock without its passphrase.`,
    '',
    'If the owner did not do this, or you are not sure, call them now: whoever did it can unlock the guardian, also after you or the owner locked it.',
  ].join('\n');
}

/** The wire alert of a limit change or a contact lock, for the paired phone (`undefined`: a notice for contacts only). */
export function noticeToWire(n: LimitNotice): Alert | undefined {
  const stamp = stampOf(n.at);
  if (
    n.kind === 'contact_lock_on' ||
    n.kind === 'contact_lock_off' ||
    n.kind === 'contact_added' ||
    n.kind === 'contact_removed' ||
    n.kind === 'wallet_added' ||
    n.kind === 'wallet_removed' ||
    n.kind === 'unlock_slot_added'
  )
    return undefined;
  if (n.kind === 'savings_unwatched')
    return n.savingsWalletId
      ? {
          type: 'savings_unwatched',
          ...stamp,
          walletId: n.savingsWalletId,
          ...(n.replacedBy ? { replacedBy: n.replacedBy } : {}),
          message: n.replacedBy
            ? `Your guardian now watches another Savings wallet (${n.replacedBy.slice(0, 8)}) instead of ${n.savingsWalletId.slice(0, 8)}: it no longer says when that one moves. If you did not replace a Savings key, act now.`
            : `Your guardian no longer watches Savings (${n.savingsWalletId.slice(0, 8)}): it will not say when Savings moves. If you did not do this, act now.`,
        }
      : undefined;
  if (n.kind === 'savings_unchecked')
    return n.savingsWalletId
      ? {
          type: 'savings_unchecked',
          ...stamp,
          walletId: n.savingsWalletId,
          ...(n.pending ? { pending: n.pending } : {}),
          message: n.pending
            ? `Your guardian cannot check every Savings transaction right now: ${n.pending} payments into Savings wait unchecked, more than it reads at once. A payment out of Savings may be hidden among them. If you did not expect this, check Savings and act now.`
            : 'Your guardian cannot read Savings right now, so it would not see a payment out of it. If this lasts, check Savings and your guardian\'s server.',
        }
      : undefined;
  if (n.kind === 'savings_moved')
    return n.savingsWalletId && n.txid
      ? {
          type: 'savings_moved',
          ...stamp,
          walletId: n.savingsWalletId,
          txid: n.txid,
          amountSats: Number(n.amountSats ?? 0n),
          ...(n.replacesTxid ? { replaces: n.replacesTxid, ...(n.previousAmountSats !== undefined ? { previousAmountSats: Number(n.previousAmountSats) } : {}) } : {}),
          message: n.replacesTxid
            ? `A payment out of Savings was replaced: it now moves ${satsText(n.amountSats ?? 0n)}${n.previousAmountSats !== undefined ? ` instead of ${satsText(n.previousAmountSats)}` : ''}, and pays out something else. Only one of the two can confirm. That needs your hardware wallet or your Recovery Key with another key: if you did not do this, act now.`
            : n.consolidated
              ? `Savings consolidated: coins merged into one, still in Savings. Only the network fee, ${satsText(n.amountSats ?? 0n)}, left. That needs your hardware wallet or your Recovery Key with another key: if you did not do this, act now.`
              : `${satsText(n.amountSats ?? 0n)} moved out of Savings. That needs your hardware wallet or your Recovery Key with another key: if you did not do this, act now.`,
        }
      : undefined;
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
export function noticeText(n: LimitNotice, canLock = false, reach: ContactReach = 'dm', guardian = 'Trikey Guardian'): string {
  if (n.kind === 'contact_added' || n.kind === 'contact_removed') return contactChangeText({ ...n, kind: n.kind }, { guardian }, reach);
  if (n.kind === 'wallet_added' || n.kind === 'wallet_removed' || n.kind === 'unlock_slot_added') return boxNoticeText({ ...n, kind: n.kind }, guardian);
  if (n.kind === 'savings_unwatched')
    return [
      n.replacedBy
        ? 'Trikey alert: the guardian of the bitcoin wallet you help protect now watches a different Savings wallet.'
        : 'Trikey alert: the guardian of the bitcoin wallet you help protect stopped watching its Savings wallet.',
      '',
      n.replacedBy
        ? `What happened: on ${formatWhen(n.at)}, the owner's phone told the guardian to watch Savings wallet ${(n.replacedBy ?? '').slice(0, 8)} instead of ${(n.savingsWalletId ?? '').slice(0, 8)}. The guardian will no longer say when the old one moves.`
        : `What happened: on ${formatWhen(n.at)}, the owner's phone told the guardian to stop watching Savings wallet ${(n.savingsWalletId ?? '').slice(0, 8)}. The guardian will no longer say when Savings moves.`,
      '',
      n.replacedBy
        ? 'This is expected when the owner replaced a lost Savings key. If not, or you are not sure, call them now: someone with their phone may be about to move Savings unseen.'
        : 'If the owner did not do this, or you are not sure, call them now: someone with their phone may be about to move Savings unseen.',
    ].join('\n');
  if (n.kind === 'savings_unchecked')
    return [
      'Trikey alert: the guardian of the bitcoin wallet you help protect cannot check everything that happens in its Savings wallet.',
      '',
      n.pending
        ? `What happened: since ${formatWhen(n.at)}, ${n.pending} transactions of the Savings wallet wait unchecked: more arrived than the guardian reads at once (someone may be flooding Savings with small payments). A payment out of Savings may be hidden among them; the guardian tells you once it finds one.`
        : `What happened: since ${formatWhen(n.at)}, the guardian has not been able to read the Savings wallet, so it would not see a payment out of it.`,
      '',
      'If the owner knows why, nothing else is needed. If not, or you are not sure, call them: someone may hold two of their keys.',
    ].join('\n');
  if (n.kind === 'savings_moved' && n.replacesTxid)
    return [
      'Trikey alert: a payment out of the Savings wallet of the bitcoin wallet you help protect was replaced.',
      '',
      `What happened: on ${formatWhen(n.at)}, transaction ${n.txid ?? '(unknown)'} replaced transaction ${n.replacesTxid}${n.previousAmountSats !== undefined ? `, which moved ${formatBtc(n.previousAmountSats)}` : ''} and which you were told about. It spends the same Savings coins but pays out something else: ${formatBtc(n.amountSats ?? 0n)} now leaves Savings. Only one of the two can confirm, so this is not a second payment.`,
      "The guardian cannot sign for Savings: this took two of the owner's other keys (their phone with their hardware wallet, or one of them with their Recovery Key).",
      '',
      'If the owner changed the payment, nothing else is needed. If not, or you are not sure, call them now: they may need to move what is left with their hardware wallet and Recovery Key.',
    ].join('\n');
  if (n.kind === 'savings_moved' && n.consolidated)
    return [
      'Trikey alert: the Savings wallet of the bitcoin wallet you help protect was consolidated.',
      '',
      `What happened: on ${formatWhen(n.at)}, coins of the Savings wallet were merged into one, still in Savings, in transaction ${n.txid ?? '(unknown)'}. Only the network fee, ${formatBtc(n.amountSats ?? 0n)}, left Savings.`,
      "The guardian cannot sign for Savings: this took two of the owner's other keys (their phone with their hardware wallet, or one of them with their Recovery Key).",
      '',
      'If the owner did this (tidying up small coins while fees are low), nothing else is needed. If not, or you are not sure, call them now: someone may hold two of their keys.',
    ].join('\n');
  if (n.kind === 'savings_moved')
    return [
      "Trikey alert: money moved out of the Savings wallet of the bitcoin wallet you help protect.",
      '',
      `What happened: on ${formatWhen(n.at)}, ${formatBtc(n.amountSats ?? 0n)} left Savings in transaction ${n.txid ?? '(unknown)'}.`,
      "The guardian cannot sign for Savings: this took two of the owner's other keys (their phone with their hardware wallet, or one of them with their Recovery Key).",
      '',
      'If the owner moved it, nothing else is needed. If not, or you are not sure, call them now: they may need to move what is left with their hardware wallet and Recovery Key.',
    ].join('\n');
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
    ...(canLock && reach !== 'none' ? ['', reach === 'nostr' ? LOCK_HINT_NOSTR : LOCK_HINT] : []),
  ].join('\n');
}

export class Alerter {
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly g: Guardian,
    private readonly w: WalletRuntime,
  ) {}

  /** A notice as the phone gets it: with this wallet's id and name once the box has several. */
  private noticeWire(n: LimitNotice): Alert | undefined {
    const wire = noticeToWire(n);
    if (!wire) return undefined;
    const walletId = this.w.alertWalletId();
    return { ...wire, ...(walletId && !('walletId' in wire) ? { walletId } : {}), ...(wire.message ? { message: labelled(this.w, wire.message).slice(0, 500) } : {}) } as Alert;
  }

  /** A notice as the contacts get it: named once the box has several wallets. */
  private noticeDm(n: LimitNotice, canLock: boolean, reach: ContactReach = 'dm'): string {
    return labelled(this.w, noticeText(n, canLock, reach, this.g.notifier.guardianName));
  }

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
    const w = this.w;
    const canLock = !!w.engine.status().rules?.contactLock;
    for (const n of w.engine.dueNotices()) {
      await this.queueNotice(n, canLock);
      if (!g.rpc || !g.dm) continue;
      const phone = w.engine.walletById(n.walletId)?.appNostrPubkey;
      const delivered: string[] = [];
      for (const to of n.recipients) {
        try {
          const wire = to === phone ? this.noticeWire(n) : undefined;
          const ok = to === phone ? !!wire && (await g.notifyPeer(to, wire)) : (await g.dm!.send(to, this.noticeDm(n, canLock))).some((o) => o.ok);
          if (ok) delivered.push(to);
          else g.log.warn('alert.not_delivered', { alertId: n.id, to: to === phone ? 'phone' : 'contact' });
        } catch (e) {
          g.log.warn('alert.send_failed', { alertId: n.id, error: errorText(e) });
        }
      }
      if (delivered.length) {
        const res = await w.engine.markNoticeSent(n.id, delivered);
        if (res.ok) g.log.info('alert.sent', { alertId: n.id, kind: n.kind, recipients: delivered.length });
      }
    }
  }

  /** `${alertId}:${pubkey}` already sent to a phone with recovery access (not tracked by the engine). */
  private readonly sentToPeers = new Set<string>();

  /**
   * The extra channels (notify/notifier.ts) get the alert too, queued before the nostr sends so a notice the nostr
   * side finishes in this pass is not missed: the owner's channels the phone's text, a contact's channels the
   * contact's text, and only for contacts the nostr alert goes to. Queued once per alert id.
   */
  private async queueAlert(a: DueAlert, rec: RecoveryRecord | undefined): Promise<void> {
    const g = this.g;
    const w = this.w;
    if (!g.notifier.configured) return;
    try {
      const queued = await g.notifier.enqueue({
        id: a.id,
        type: a.kind,
        at: a.dueAt,
        ...(rec ? { walletId: rec.walletId } : {}),
        owner: alertText(w, a, rec, 'short'),
        contacts: { text: (reach) => alertText(w, a, rec, 'long', reach), ...(rec ? { recipients: rec.recipients } : {}) },
      });
      if (queued) g.notifier.kick();
    } catch (e) {
      g.log.error('notify.enqueue_failed', { alertId: a.id, error: errorText(e) });
    }
  }

  /** As `queueAlert`, for an engine notice. `contact_lock_on` / `_off` are about a nostr control: nostr DMs only. */
  private async queueNotice(n: LimitNotice, canLock: boolean): Promise<void> {
    const g = this.g;
    const w = this.w;
    if (!g.notifier.configured || n.kind === 'contact_lock_on' || n.kind === 'contact_lock_off') return;
    // Who the notice is for, as queued (the due list holds only those not reached yet).
    const all = w.store.state?.notices?.find((x) => x.id === n.id)?.recipients ?? n.recipients;
    const phone = w.engine.walletById(n.walletId)?.appNostrPubkey;
    const contacts = all.filter((r) => r !== phone && r !== n.contact);
    if (n.kind === 'contact_added' || n.kind === 'contact_removed' || n.kind === 'wallet_added' || n.kind === 'wallet_removed' || n.kind === 'unlock_slot_added') {
      // The owner's channels: one line for a contact change (a box event has the owner's own message, sent by the
      // service). A contact's channels: only for the contacts it is for, never for a channel without a nostr key (it would
      // not know which contact is meant).
      const owner = contactChangeOwnerText(n);
      try {
        const queued = await g.notifier.enqueue({
          id: n.id,
          type: n.kind,
          at: n.at,
          walletId: n.walletId,
          ...(owner ? { owner: labelled(w, owner) } : {}),
          contacts: { text: (reach) => (reach === 'nostr' ? this.noticeDm(n, canLock, 'nostr') : undefined), recipients: contacts },
        });
        if (queued) g.notifier.kick();
      } catch (e) {
        g.log.error('notify.enqueue_failed', { alertId: n.id, error: errorText(e) });
      }
      return;
    }
    try {
      const queued = await g.notifier.enqueue({
        id: n.id,
        type: n.kind,
        ...(n.kind === 'savings_moved' && n.consolidated && !n.replacesTxid ? { title: 'Savings consolidated' } : {}),
        at: n.at,
        walletId: n.kind === 'savings_moved' || n.kind === 'savings_unwatched' || n.kind === 'savings_unchecked' ? (n.savingsWalletId ?? n.walletId) : n.walletId,
        ...(all.includes(phone ?? '') ? { owner: this.noticeWire(n)?.message } : {}),
        ...(contacts.length || n.kind !== 'limit_on' ? { contacts: { text: (reach) => this.noticeDm(n, canLock, reach), recipients: contacts } } : {}),
      });
      if (queued) g.notifier.kick();
    } catch (e) {
      g.log.error('notify.enqueue_failed', { alertId: n.id, error: errorText(e) });
    }
  }

  private async once(): Promise<void> {
    const g = this.g;
    const w = this.w;
    const due = w.engine.dueAlerts();
    for (const a of due) await this.queueAlert(a, w.records.find((r) => r.id === a.recoveryId));
    await this.sendNotices();
    if (!g.rpc || !g.dm) return;
    if (!due.length) return;
    const current = w.engine.registration()?.appNostrPubkey;
    for (const a of due) {
      const rec = w.records.find((r) => r.id === a.recoveryId);
      // Phones get protocol alerts, contacts NIP-17 DMs. After a rotation the swept wallet's phone is no
      // longer the paired one, but it is still a phone.
      const phones = new Set([current, rec ? w.engine.walletById(rec.walletId)?.appNostrPubkey : undefined].filter((x): x is string => !!x));
      // A phone recovering the wallet with the hardware wallet (recovery.access), and the phone that started
      // this recovery, get the protocol alert too, best effort.
      const extra = new Set([...g.recoveryPeers(), ...(rec?.initiator ? [rec.initiator] : [])]);
      for (const peer of extra) {
        const key = `${a.id}:${peer}`;
        if (phones.has(peer) || a.recipients.includes(peer) || rec?.recipients.includes(peer) || this.sentToPeers.has(key)) continue;
        try {
          if ((await g.rpc.notify(peer, alertToWire(w, a, rec))).some((o) => o.ok)) this.sentToPeers.add(key);
        } catch (e) {
          g.log.warn('alert.peer_failed', { alertId: a.id, error: errorText(e) });
        }
      }
      const delivered: string[] = [];
      for (const to of a.recipients) {
        try {
          const ok = phones.has(to) ? await g.notifyPeer(to, alertToWire(w, a, rec)) : (await g.dm.send(to, alertText(w, a, rec))).some((o) => o.ok);
          if (ok) delivered.push(to);
          else g.log.warn('alert.not_delivered', { alertId: a.id, to: phones.has(to) ? 'phone' : 'contact' });
        } catch (e) {
          g.log.warn('alert.send_failed', { alertId: a.id, error: errorText(e) });
        }
      }
      if (delivered.length) {
        const res = await w.engine.markAlertSent(a.id, delivered);
        if (res.ok) g.log.info('alert.sent', { alertId: a.id, kind: a.kind, recipients: delivered.length });
      }
    }
  }
}
