/**
 * "LOCK" from an alert contact, as a NIP-17 DM (DESIGN.md, rule 8; docs/design/contact-lock.md).
 *
 * Opt-in: only while the active wallet's rules let the contacts lock the guardian (`Rules.contactLock`). A contact
 * sends the one word `LOCK` (any case; quoted lines of the alert it replies to are ignored) from any nostr app, and the
 * guardian locks exactly as the web UI or the phone's `guardian.lock` would: no co-signing until the owner unlocks it.
 * A contact can only lock: never unlock, change rules or see anything.
 *
 * Who gets an answer:
 * - a current alert contact of the active wallet: one short DM (locked, already locked, or not allowed because the
 *   owner did not turn the setting on), for fresh messages only;
 * - anyone else (strangers, the paired phone, a running recovery's snapshotted recipients who are no longer contacts):
 *   nothing at all, so the command cannot be used to learn whether a key is a contact or whether the setting is on.
 *
 * A message counts only once (durably, across restarts: relays re-deliver old gift wraps), only while it is fresh
 * (`LOCK_WINDOW_SEC` either side of the guardian's clock), and at most `DEFAULT_CONTACT_LOCK_LIMIT` per contact per hour.
 */
import type { Guardian } from './guardian.js';
import type { IncomingDm } from './nostr/dm.js';
import { shortNpub } from './http/activity.js';

/** How far a `LOCK` message's own timestamp may be from the guardian's clock (the contact's clock may be off a little). */
export const LOCK_WINDOW_SEC = 600;

/**
 * True when `content` is the lock command: the single word `lock`, any case, optionally followed by `.` or `!`, with
 * blank lines and quoted lines (`> ...`, a client quoting the alert) around it. Anything else is not: "don't lock it",
 * "lock?" or "LOCK 3-0123" do nothing, so a conversation in the guardian's DM thread cannot lock it by accident.
 */
export function isLockCommand(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>'));
  return lines.length === 1 && /^lock[.!]?$/i.test(lines[0]!);
}

/** How to stop a running recovery, for the answers: locking does not cancel it. */
function cancelHint(g: Guardian): string {
  const rec = g.activeRecord();
  return rec ? ` Locking does not stop the recovery ${rec.id} that is running: to cancel it, reply CANCEL ${rec.id}.` : '';
}

export async function onLockDm(g: Guardian, dm: IncomingDm): Promise<void> {
  const reg = g.engine.registration();
  if (!reg) return;
  const rules = g.engine.status().rules;
  // Only the active wallet's alert contacts; anyone else gets no answer (no probing who is a contact, or the setting).
  if (!rules || dm.sender === reg.appNostrPubkey || !rules.alertContacts.includes(dm.sender)) {
    g.log.debug('dm.lock_ignored', { reason: 'not an alert contact' });
    return;
  }
  const now = g.nowSec();
  if (Math.abs(dm.createdAt - now) > LOCK_WINDOW_SEC) {
    g.log.info('dm.lock_ignored', { reason: 'stale', contact: shortNpub(dm.sender) });
    return;
  }
  // Each message once, also after a restart (relays re-deliver old wraps): an old LOCK must not lock again after the
  // owner unlocked. Kept until the message is no longer fresh, when the check above drops it anyway. A message already
  // handled is dropped before the rate limit, so re-deliveries do not use up the contact's allowance.
  const key = `lock:${dm.sender}:${dm.rumorId}`;
  if (g.service.hasRequest(key, g.clock.now())) return;
  const verdict = g.contactLockLimiter.take(dm.sender, g.clock.now());
  if (!verdict.ok) {
    g.log.warn('dm.lock_rate_limited', { contact: shortNpub(dm.sender), retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) });
    return;
  }
  const until = (Math.max(dm.createdAt, now) + LOCK_WINDOW_SEC) * 1000 + 120_000;
  if (!(await g.service.rememberRequest(key, until, g.clock.now()))) return;

  const outcome = await g.lockByContact(dm.sender);
  const reply = async (text: string) => {
    try {
      await g.dm?.send(dm.sender, text);
    } catch {
      /* best effort */
    }
  };
  if (outcome === 'locked') {
    g.log.info('dm.lock', { contact: shortNpub(dm.sender) });
    await reply(
      `Trikey: the guardian is locked. It co-signs nothing until its owner unlocks it. The owner and the other alert contacts are being told that you locked it.${cancelHint(g)} Thank you for checking.`,
    );
    return;
  }
  await g.logEvent({ type: 'contact_lock_request', contact: dm.sender, outcome });
  if (outcome === 'already_locked') await reply(`Trikey: the guardian is already locked, so nothing changed.${cancelHint(g)}`);
  else
    await reply(
      `Trikey: the owner has not allowed alert contacts to lock this guardian, so nothing changed. If something looks wrong, talk to the owner.${cancelHint(g)}`,
    );
}
