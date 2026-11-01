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
 */
import type { Guardian } from './guardian.js';
import type { IncomingDm } from './nostr/dm.js';
import { refusalText } from './nostr/wire.js';
import { isLockCommand, onLockDm } from './dm-lock.js';
import { onHostedCancelDm } from './hosting/dm-cancel.js';
import { slotOfRecoveryId } from './hosting/service.js';

const CANCEL_RE = /\bcancel\s+([0-9a-z]+-[0-9a-f]{12})\b/i;
/** Only answer "no such recovery" to fresh messages, so old DMs re-delivered after a restart stay quiet. */
const ANSWER_WINDOW_SEC = 600;

export function parseCancel(content: string): string | undefined {
  const m = CANCEL_RE.exec(content);
  return m ? m[1].toLowerCase() : undefined;
}

export async function onContactDm(g: Guardian, dm: IncomingDm): Promise<void> {
  if (isLockCommand(dm.content)) return onLockDm(g, dm);
  const id = parseCancel(dm.content);
  if (!id) return;
  // A guest wallet's recovery id names its slot: that slot handles it (hosting/dm-cancel.ts), never the host's wallet.
  if (slotOfRecoveryId(id)) return onHostedCancelDm(g, dm, id);
  const reply = async (text: string) => {
    try {
      await g.dm?.send(dm.sender, text);
    } catch {
      /* best effort */
    }
  };
  await g.recoveryMutex.run(async () => {
    const reg = g.engine.registration();
    if (!reg) return;
    if (dm.sender !== reg.appNostrPubkey && !g.isAlertContact(dm.sender)) {
      g.log.info('dm.cancel_ignored', { reason: 'not an alert contact' });
      return;
    }
    const fresh = dm.createdAt >= g.nowSec() - ANSWER_WINDOW_SEC;
    const active = g.activeRecord();
    if (!active || active.id !== id) {
      if (fresh) await reply(`Trikey: there is no running recovery ${id}, so nothing was cancelled.`);
      return;
    }
    // A reply written before the recovery even started cannot be about it.
    if (dm.createdAt < Math.floor(active.startedAt / 1000) - ANSWER_WINDOW_SEC) return;
    const res = await g.engine.cancelRecovery({ kind: 'nostr', pubkey: dm.sender });
    if (!res.ok) {
      await g.logEvent({ type: 'cancel_by_dm', recoveryId: id, contact: dm.sender, ok: false, detail: res.refusal.reason });
      await reply(`Trikey: could not cancel recovery ${id}: ${refusalText(res.refusal)}.`);
      return;
    }
    g.log.info('recovery.cancelled', { recoveryId: id, by: 'contact_dm', contested: res.contested });
    await g.logEvent({ type: 'cancel_by_dm', recoveryId: id, contact: dm.sender, ok: true });
    await reply(`Trikey: recovery ${id} is cancelled. No funds will move. Thank you for checking.`);
  });
  void g.alerts.run();
}
