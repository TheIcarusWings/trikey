/**
 * "CANCEL <recovery id>" DMs for a guest wallet's recovery (`<slotId>g<n>-<txid12>`): the id names the slot, so the
 * cancel reaches that slot's engine only, and only from that wallet's phone or one of its alert contacts. The host's
 * wallet and its DM handling (dm-cancel.ts) are not involved.
 */
import type { Guardian } from '../guardian.js';
import type { IncomingDm } from '../nostr/dm.js';
import { ANSWER_WINDOW_SEC, answerContact, cancelHintText, mayAnswer } from '../dm-cancel.js';
import { hostedRefusalText } from './handlers.js';
import { slotOfRecoveryId } from './service.js';

/** `hintOnly`: the message names `CANCEL <id>` but is not the command (dm-cancel.ts `parseCancel`): never cancels. */
export async function onHostedCancelDm(g: Guardian, dm: IncomingDm, id: string, hintOnly = false): Promise<void> {
  const slotId = slotOfRecoveryId(id);
  const live = slotId ? g.hosting.liveSlots().find((x) => x.slot.slotId === slotId) : undefined;
  if (!live) return;
  const { slot, engine } = live;
  // Decided under this slot's recovery mutex (not the host's: each guest has its own), sent after it: dm-cancel.ts.
  const answer = await engine.recoveryMutex.run(async (): Promise<string | undefined> => {
    const reg = engine.registration();
    if (!reg) return undefined;
    if (dm.sender !== reg.appNostrPubkey && !engine.isAlertContact(dm.sender)) {
      g.log.info('dm.cancel_ignored', { reason: 'not a contact of this hosted wallet' });
      return undefined;
    }
    const fresh = mayAnswer(dm.createdAt, g.nowSec());
    const active = engine.activeRecord();
    if (hintOnly) {
      g.log.info('dm.cancel_ignored', { reason: 'not the command' });
      return fresh && active?.id === id ? cancelHintText(id) : undefined;
    }
    if (!active || active.id !== id) return fresh ? `Trikey: there is no running recovery ${id}, so nothing was cancelled.` : undefined;
    if (dm.createdAt < Math.floor(active.startedAt / 1000) - ANSWER_WINDOW_SEC) return undefined;
    const res = await engine.cancelRecovery({ kind: 'nostr', pubkey: dm.sender });
    if (!res.ok) return `Trikey: could not cancel recovery ${id}: ${hostedRefusalText(res.refusal)}.`;
    await g.logEvent({ type: 'hosting_recovery', name: slot.name, recoveryId: id, state: 'cancelled' });
    return `Trikey: recovery ${id} is cancelled. No funds will move. Thank you for checking.`;
  });
  void g.hosting.alerts.run();
  if (answer) await answerContact(g, dm.sender, answer);
}
