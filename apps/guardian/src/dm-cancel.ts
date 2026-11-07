/**
 * "CANCEL <recovery id>" replies from alert contacts, as NIP-17 DMs.
 *
 * Alert contacts are not paired peers and usually have nothing but a normal
 * nostr app, so a plain-text reply to the alert DM is how they cancel. The
 * sender is the verified author of the sealed rumor (dm.ts). Only registered
 * alert contacts and the running recovery's recipients count; the named
 * recovery must be the running one (the engine cancels whichever recovery is
 * running, so the id check is what keeps an old or replayed reply from
 * cancelling a newer recovery). Anything else is ignored without an answer,
 * except for a short reply to known contacts. A `LOCK` message goes to
 * dm-lock.ts instead (opt-in: the alert contacts may lock the guardian).
 *
 * The command is the whole message: one line `CANCEL <id>` (any case, an
 * optional `.` or `!`), apart from blank lines and quoted ones (`> ...`), as
 * for `LOCK`. The guardian's own alert names `CANCEL <id>`, so a client that
 * quotes it in a reply ("> CANCEL 2-... / Was this you?") must not cancel the
 * recovery, nor may "don't CANCEL 2-..." or "CANCEL 2-... please". A message
 * that names a running recovery's CANCEL line but is not the command gets,
 * from a known contact while fresh, a short answer saying how to cancel.
 *
 * Answers are decided under the wallet's recovery mutex but sent after it is
 * released: a DM goes to relays the contact chose (their kind-10050 list), and
 * a slow relay must not hold up the wallet's recoveries (up to 0.1.21 every
 * answer was awaited inside the mutex). Answers are also limited per sender
 * (`DEFAULT_CONTACT_REPLY_LIMIT`; a cancel itself is never limited), and only
 * a message whose own timestamp is within 10 minutes of the guardian's clock,
 * either way, gets one.
 */
import type { Guardian } from './guardian.js';
import type { IncomingDm } from './nostr/dm.js';
import { refusalText } from './nostr/wire.js';
import { commandLines, isLockCommand, onLockDm } from './dm-lock.js';
import { onHostedCancelDm } from './hosting/dm-cancel.js';
import { slotOfRecoveryId } from './hosting/service.js';
import type { WalletRuntime } from './runtime.js';
import { shortNpub } from './http/activity.js';

/** The command line: `cancel <recovery id>`, any case, nothing else but an optional `.` or `!`. */
const CANCEL_LINE_RE = /^cancel\s+([0-9a-z]+-[0-9a-f]{12})[.!]?$/i;
/** `cancel <recovery id>` anywhere in the message (quoted, or with other words): never a command, at most a hint. */
const CANCEL_MENTION_RE = /\bcancel\s+([0-9a-z]+-[0-9a-f]{12})\b/i;
/**
 * Only answer messages this close to the guardian's clock (either way), so old DMs re-delivered after a restart stay
 * quiet and a sender cannot make every message "fresh" with a timestamp in the future.
 */
export const ANSWER_WINDOW_SEC = 600;

/** Whether a contact's DM written at `createdAt` (its own timestamp) may get an answer at `now` (both unix seconds). */
export function mayAnswer(createdAt: number, now: number): boolean {
  return Math.abs(createdAt - now) <= ANSWER_WINDOW_SEC;
}

/**
 * Sends `text` to a contact who wrote a CANCEL DM, outside any mutex, at most `DEFAULT_CONTACT_REPLY_LIMIT` per sender
 * (more are dropped: the sender is flooding). Best effort.
 */
export async function answerContact(g: Guardian, to: string, text: string): Promise<void> {
  const turn = g.contactReplyLimiter.take(to, g.clock.now());
  if (!turn.ok) {
    g.log.debug('dm.reply_rate_limited', { contact: shortNpub(to) });
    return;
  }
  try {
    await g.dm?.send(to, text);
  } catch {
    /* best effort */
  }
}

/**
 * The recovery id when `content` is the cancel command: exactly one line `CANCEL <id>` (optional `.` or `!`) once blank
 * and quoted (`>`) lines are dropped. Anything else, a quoted alert's `CANCEL <id>` included, is not a command.
 */
export function parseCancel(content: string): string | undefined {
  const lines = commandLines(content);
  if (lines.length !== 1) return undefined;
  const m = CANCEL_LINE_RE.exec(lines[0]!);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** A recovery id named after "cancel" anywhere in `content`, quoted lines included (for the hint, never to cancel). */
export function mentionedCancel(content: string): string | undefined {
  const m = CANCEL_MENTION_RE.exec(content);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** The answer to a message that names a running recovery's CANCEL line but is not the command. */
export function cancelHintText(id: string): string {
  return `Trikey: nothing was cancelled. To cancel recovery ${id}, reply with exactly this line and nothing else:\n\nCANCEL ${id}`;
}

export async function onContactDm(g: Guardian, dm: IncomingDm): Promise<void> {
  if (isLockCommand(dm.content)) return onLockDm(g, dm);
  const command = parseCancel(dm.content);
  const id = command ?? mentionedCancel(dm.content);
  if (!id) return;
  const hintOnly = command === undefined;
  // A guest wallet's recovery id names its slot: that slot handles it (hosting/dm-cancel.ts), never the host's wallet.
  if (slotOfRecoveryId(id)) return onHostedCancelDm(g, dm, id, hintOnly);
  // An own wallet's recovery id names its wallet (`<slotId>w<n>-...`): that wallet's engine handles it, nothing else.
  const own = g.wallets.byRecoveryId(id);
  return cancelByDm(g, own ?? g, dm, id, hintOnly);
}

/** `hintOnly`: the message names `CANCEL <id>` but is not the command (quoted, or more words): never cancels. */
async function cancelByDm(g: Guardian, w: WalletRuntime, dm: IncomingDm, id: string, hintOnly: boolean): Promise<void> {
  // Decided under the mutex, sent after it (see the file comment).
  const answer = await w.recoveryMutex.run(async (): Promise<string | undefined> => {
    const reg = w.engine.registration();
    if (!reg) return undefined;
    if (dm.sender !== reg.appNostrPubkey && !w.isAlertContact(dm.sender)) {
      g.log.info('dm.cancel_ignored', { reason: 'not an alert contact' });
      return undefined;
    }
    const fresh = mayAnswer(dm.createdAt, g.nowSec());
    const active = w.activeRecord();
    if (hintOnly) {
      g.log.info('dm.cancel_ignored', { reason: 'not the command' });
      return fresh && active?.id === id ? cancelHintText(id) : undefined;
    }
    if (!active || active.id !== id) return fresh ? `Trikey: there is no running recovery ${id}, so nothing was cancelled.` : undefined;
    // A reply written before the recovery even started cannot be about it.
    if (dm.createdAt < Math.floor(active.startedAt / 1000) - ANSWER_WINDOW_SEC) return undefined;
    const res = await w.engine.cancelRecovery({ kind: 'nostr', pubkey: dm.sender });
    if (!res.ok) {
      await w.logEvent({ type: 'cancel_by_dm', recoveryId: id, contact: dm.sender, ok: false, detail: res.refusal.reason });
      return `Trikey: could not cancel recovery ${id}: ${refusalText(res.refusal)}.`;
    }
    g.log.info('recovery.cancelled', { recoveryId: id, by: 'contact_dm', contested: res.contested });
    await w.logEvent({ type: 'cancel_by_dm', recoveryId: id, contact: dm.sender, ok: true });
    return `Trikey: recovery ${id} is cancelled. No funds will move. Thank you for checking.`;
  });
  void w.alerts.run();
  if (answer) await answerContact(g, dm.sender, answer);
}
