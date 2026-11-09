/**
 * "LOCK" from an alert contact, as a NIP-17 DM (DESIGN.md, rule 8; docs/design/contact-lock.md).
 *
 * Opt-in: only while the active wallet's rules let the contacts lock the guardian (`Rules.contactLock`). A contact
 * sends the one word `LOCK` (any case; quoted lines of the alert it replies to are ignored) from any nostr app, and the
 * guardian locks exactly as the web UI or the phone's `guardian.lock` would: no co-signing until the owner unlocks it.
 * A contact can only lock: never unlock, change rules or see anything.
 *
 * Family hosting (docs/design/family-hosting.md, section 16): a guest wallet's contact pauses only that guest's wallet
 * (its slot co-signs nothing until the guest's hardware wallet resumes it), never the host's box; the host's own contacts
 * still lock the whole box, guests included. A contact of both does both. Each wallet's own setting decides for it.
 *
 * Who gets an answer:
 * - while the setting is on, a current alert contact of the active wallet: one short DM (locked, or already locked),
 *   for fresh messages only; a guest wallet's contact, likewise, about that wallet only (paused, already paused);
 * - while it is off, nobody (owner's decision, 2026-11-01): the command does not exist then, not even as a refusal,
 *   and nothing is logged;
 * - anyone else (strangers, the paired phone, a running recovery's snapshotted recipients who are no longer contacts):
 *   nothing at all, so the command cannot be used to learn whether a key is a contact or whether the setting is on.
 *
 * A message counts only once (durably, across restarts: relays re-deliver old gift wraps), only while it is fresh
 * (`LOCK_WINDOW_SEC` either side of the guardian's clock), and at most `DEFAULT_CONTACT_LOCK_LIMIT` per contact per hour.
 */
import { SUBSCRIPTION_LOOKBACK_SEC } from '@trikey/protocol';
import type { Guardian } from './guardian.js';
import type { IncomingDm } from './nostr/dm.js';
import { shortNpub } from './http/activity.js';

/** How far a `LOCK` message's own timestamp may be from the guardian's clock (the contact's clock may be off a little). */
export const LOCK_WINDOW_SEC = 600;
/**
 * A `LOCK` dated further ahead than this is never handled, and remembered only this far: the guardian's subscriptions
 * ask relays for wraps from `SUBSCRIPTION_LOOKBACK_SEC` back, so past it a relay no longer hands the same wrap over.
 */
export const LOCK_MAX_AHEAD_SEC = SUBSCRIPTION_LOOKBACK_SEC;
/** Clock skew allowed on top of the window when remembering a message (as the guardian's other replay guards). */
const SKEW_MS = 120_000;

/**
 * True when `content` is the lock command: the single word `lock`, any case, optionally followed by `.` or `!`, with
 * blank lines and quoted lines (`> ...`, a client quoting the alert) around it. Anything else is not: "don't lock it",
 * "lock?" or "LOCK 3-0123" do nothing, so a conversation in the guardian's DM thread cannot lock it by accident.
 */
export function isLockCommand(content: string): boolean {
  const lines = commandLines(content);
  return lines.length === 1 && /^lock[.!]?$/i.test(lines[0]!);
}

/**
 * The lines of a contact's DM that may carry a command (`LOCK`, `CANCEL <id>`): trimmed, without blank lines and
 * without quoted ones (`> ...`: a client quoting the guardian's alert, which itself names the command).
 */
export function commandLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>'));
}

/** How to stop a running recovery, for the answers: locking does not cancel it. */
function cancelHint(g: Guardian): string {
  const rec = g.activeRecord();
  return rec ? ` Locking does not stop the recovery ${rec.id} that is running: to cancel it, reply CANCEL ${rec.id}.` : '';
}

/** For a guest wallet the contact paused: how to stop its running recovery, if one runs (pausing does not cancel it). */
function hostedCancelHint(g: Guardian, contact: string): string {
  const ids = g.hosting
    .contactOfSlots(contact)
    .map(({ engine }) => engine.activeRecord()?.id)
    .filter((x): x is string => !!x);
  return ids.map((id) => ` Pausing does not stop the recovery ${id} that is running: to cancel it, reply CANCEL ${id}.`).join('');
}

const quoted = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');

export async function onLockDm(g: Guardian, dm: IncomingDm): Promise<void> {
  const reg = g.engine.registration();
  const rules = reg ? g.engine.status().rules : undefined;
  // The host's wallet's current alert contacts, and the guest wallets that list the sender as a current contact
  // (family hosting, section 16): anyone else gets no answer (no probing who is a contact, or the setting).
  const firstContact = !!reg && !!rules && dm.sender !== reg.appNostrPubkey && rules.alertContacts.includes(dm.sender);
  // The owner's own wallets that list the sender (docs/design/multi-wallet.md): their contacts lock the box too.
  const ownOf = g.wallets.active().filter((w) => w.phone() !== dm.sender && !!w.engine.status().rules?.alertContacts.includes(dm.sender));
  const hostContact = firstContact || ownOf.length > 0;
  const guestContact = g.hosting.contactOfSlots(dm.sender).length > 0;
  if (!hostContact && !guestContact) {
    g.log.debug('dm.lock_ignored', { reason: 'not an alert contact' });
    return;
  }
  const now = g.nowSec();
  // Too old: it can never be fresh again, so there is nothing to remember.
  if (!(dm.createdAt >= now - LOCK_WINDOW_SEC)) {
    g.log.info('dm.lock_ignored', { reason: 'stale', contact: shortNpub(dm.sender) });
    return;
  }
  // Each message once, also after a restart (relays re-deliver old wraps): an old LOCK must not lock again after the
  // owner unlocked. A message already handled is dropped before the rate limit, so re-deliveries do not use up the
  // contact's allowance. Remembered BEFORE the freshness check, a message dated ahead too (security sweep 3): one dropped
  // as "not fresh yet" without being remembered locked when a relay handed it over again later, inside the window,
  // even after the owner had turned the setting on, breaking "remembered while the setting is off". It is kept until it
  // can no longer be fresh (its date plus the window), or, dated beyond the relays' look-back, until a relay no longer
  // hands it over; such messages count against the contact's rate limit, so they cannot grow the memory without end.
  const key = `lock:${dm.sender}:${dm.rumorId}`;
  if (g.service.hasRequest(key, g.clock.now())) return;
  const verdict = g.contactLockLimiter.take(dm.sender, g.clock.now());
  if (!verdict.ok) {
    g.log.warn('dm.lock_rate_limited', { contact: shortNpub(dm.sender), retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) });
    return;
  }
  const until = (Math.max(now, Math.min(dm.createdAt, now + LOCK_MAX_AHEAD_SEC)) + LOCK_WINDOW_SEC) * 1000 + SKEW_MS;
  if (!(await g.service.rememberRequest(key, until, g.clock.now()))) return;
  if (dm.createdAt > now + LOCK_WINDOW_SEC) {
    g.log.info('dm.lock_ignored', { reason: dm.createdAt > now + LOCK_MAX_AHEAD_SEC ? 'too far ahead' : 'not fresh yet', contact: shortNpub(dm.sender) });
    return;
  }
  // Setting off (for the host's wallet and for every guest wallet that lists the sender): as if the command did not
  // exist, so no answer and nothing in the activity log. The message is still remembered (above): a relay handing it
  // over again after an owner turned the setting on must not lock or pause then.
  const hostOn = (firstContact && !!rules?.contactLock) || ownOf.some((w) => !!w.engine.status().rules?.contactLock);
  const guestOn = g.hosting.contactOfSlots(dm.sender).some(({ engine }) => engine.contactMayPause(dm.sender));
  if (!hostOn && !guestOn) {
    g.log.debug('dm.lock_ignored', { reason: 'setting off' });
    return;
  }

  const parts: string[] = [];
  // The host's wallet: the whole box locks (guests included), as before family hosting.
  if (hostOn) {
    const outcome = await g.lockByContact(dm.sender);
    if (outcome === 'locked') {
      g.log.info('dm.lock', { contact: shortNpub(dm.sender) });
      parts.push(
        `Trikey: the guardian is locked. It co-signs nothing until its owner unlocks it. The owner and the other alert contacts are being told that you locked it.${cancelHint(g)} Thank you for checking.`,
      );
    } else if (outcome === 'already_locked') {
      // `not_allowed` here means the owner turned the setting off a moment ago: silent, as above.
      await g.logEvent({ type: 'contact_lock_request', contact: dm.sender, outcome });
      parts.push(`Trikey: the guardian is already locked, so nothing changed.${cancelHint(g)}`);
    }
  }
  // Guest wallets (family hosting, section 16): a guest's contact pauses only that guest's wallet, never the host's box.
  if (guestOn) {
    const slots = await g.hosting.pauseByContact(dm.sender);
    if (slots.paused.length)
      parts.push(
        `Trikey: the wallet ${quoted(slots.paused)} is paused. Its guardian co-signs no payment for it until its owner resumes it with their hardware wallet. The owner and the other alert contacts are being told that you paused it.${hostedCancelHint(g, dm.sender)} Thank you for checking.`,
      );
    if (slots.already.length) parts.push(`Trikey: the wallet ${quoted(slots.already)} is already paused, so nothing changed.`);
  }
  if (!parts.length) return;
  try {
    await g.dm?.send(dm.sender, parts.join('\n\n'));
  } catch {
    /* best effort */
  }
}
