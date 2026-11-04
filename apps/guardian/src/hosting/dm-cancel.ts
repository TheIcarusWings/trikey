/**
 * "CANCEL <recovery id>" DMs for a guest wallet's recovery (`<slotId>g<n>-<txid12>`): the id names the slot, so the
 * cancel reaches that slot's engine only, and only from that wallet's phone or one of its alert contacts. The host's
 * wallet and its DM handling (dm-cancel.ts) are not involved.
 */
import type { Guardian } from '../guardian.js';
import type { IncomingDm } from '../nostr/dm.js';
import { hostedRefusalText } from './handlers.js';
import { slotOfRecoveryId } from './service.js';

const ANSWER_WINDOW_SEC = 600;

export async function onHostedCancelDm(g: Guardian, dm: IncomingDm, id: string): Promise<void> {
  const slotId = slotOfRecoveryId(id);
  const live = slotId ? g.hosting.liveSlots().find((x) => x.slot.slotId === slotId) : undefined;
  if (!live) return;
  const { slot, engine } = live;
  const reply = async (text: string) => {
    try {
      await g.dm?.send(dm.sender, text);
    } catch {
      /* best effort */
    }
  };
  await g.recoveryMutex.run(async () => {
    const reg = engine.registration();
    if (!reg) return;
    if (dm.sender !== reg.appNostrPubkey && !engine.isAlertContact(dm.sender)) {
      g.log.info('dm.cancel_ignored', { reason: 'not a contact of this hosted wallet' });
      return;
    }
    const fresh = dm.createdAt >= g.nowSec() - ANSWER_WINDOW_SEC;
    const active = engine.activeRecord();
    if (!active || active.id !== id) {
      if (fresh) await reply(`Trikey: there is no running recovery ${id}, so nothing was cancelled.`);
      return;
    }
    if (dm.createdAt < Math.floor(active.startedAt / 1000) - ANSWER_WINDOW_SEC) return;
    const res = await engine.cancelRecovery({ kind: 'nostr', pubkey: dm.sender });
    if (!res.ok) {
      await reply(`Trikey: could not cancel recovery ${id}: ${hostedRefusalText(res.refusal)}.`);
      return;
    }
    await g.logEvent({ type: 'hosting_recovery', name: slot.name, recoveryId: id, state: 'cancelled' });
    await reply(`Trikey: recovery ${id} is cancelled. No funds will move. Thank you for checking.`);
  });
  void g.hosting.alerts.run();
}
