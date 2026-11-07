/**
 * The owner's escape hatch for own wallets, in the web page (apps/guardian-web/API.md, "Wallets and hardware unlock";
 * security review 2026-11). Every route needs a web session, which only the passphrase gives:
 *
 * - `GET /api/own-wallets`: every wallet of the box (the first included) with its hardware unlock slot and a running
 *   recovery, so the owner sees a wallet or a slot they did not add;
 * - `DELETE /api/unlock-slots/:walletId`: turns hardware unlock off for that wallet (the passphrase still unlocks);
 * - `POST /api/own-wallets/:walletId/remove` with `{ confirm: "REMOVE WALLET" }`: stops guarding an own wallet after the
 *   first without its hardware wallet (retired; its money stays with its phone key and its hardware wallet). Refused
 *   (`409 recovery_pending` / `sweep_pending`) while a recovery of it runs or its sweep waits.
 *
 * Why a web session may do this: it can already reset the whole guardian (forgetting every wallet and key 3); this does
 * less, and lets the owner drop a wallet they no longer want guarded (one added before `add_wallet_approval`, say)
 * without losing the others. It gives no power over recoveries: like Reset, it is refused while one of that wallet runs,
 * and every removal is announced (DESIGN.md, threat model).
 */
import type { Guardian } from '../guardian.js';
import { HttpError, type Route, type RouteResult } from '../http/server.js';
import { walletOf } from '../nostr/handlers.js';
import type { WalletRuntime } from '../runtime.js';
import { DEFAULT_FIRST_NAME } from './service.js';

/** Typed to remove an own wallet after the first in the web page, without its hardware wallet. */
export const REMOVE_WALLET_CONFIRMATION = 'REMOVE WALLET';

const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body: unknown, status = 200): RouteResult => ({ status, body });

/** One wallet of the box as the escape hatch lists it. */
export interface OwnWalletSecurity {
  walletId: string;
  name: string;
  /** The first wallet: it holds the pairing; it cannot be removed here (Reset forgets every wallet). */
  first: boolean;
  account: number;
  hardwareFingerprint: string;
  addedAt?: string;
  /** Hardware unlock is on for this wallet (its slot opens the whole box). */
  unlockSlot?: { addedAt: string };
  recovery?: { id: string; readyAt: string };
}

export function ownWalletsSecurity(g: Guardian): { wallets: OwnWalletSecurity[]; removeConfirmation: string } {
  const out: OwnWalletSecurity[] = [];
  const entry = (w: WalletRuntime, name: string, first: boolean, addedAt?: number): void => {
    const reg = w.engine.registration();
    if (!reg) return;
    const slot = g.unlockSlots.get(reg.walletId);
    const rec = w.activeRecord();
    out.push({
      walletId: reg.walletId,
      name,
      first,
      account: w.account,
      hardwareFingerprint: walletOf(reg).keys.hardware.fingerprint,
      ...(addedAt !== undefined ? { addedAt: iso(addedAt) } : {}),
      ...(slot ? { unlockSlot: { addedAt: iso(slot.addedAt) } } : {}),
      ...(rec ? { recovery: { id: rec.id, readyAt: iso(rec.readyAt) } } : {}),
    });
  };
  entry(g, g.wallets.registry.firstName ?? DEFAULT_FIRST_NAME, true);
  for (const w of g.wallets.active()) entry(w, w.name, false, w.record.addedAt);
  return { wallets: out, removeConfirmation: REMOVE_WALLET_CONFIRMATION };
}

function requireSetUp(g: Guardian): void {
  if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
}

export function ownWalletRoutes(g: Guardian): Route[] {
  return [
    {
      method: 'GET',
      path: '/own-wallets',
      handler: () => {
        requireSetUp(g);
        return ok(ownWalletsSecurity(g));
      },
    },
    {
      method: 'DELETE',
      path: '/unlock-slots/:walletId',
      handler: async ({ params }) => {
        requireSetUp(g);
        const w = g.wallets.byWalletId(params.walletId) ?? (g.engine.registration()?.walletId === params.walletId ? g : undefined);
        if (!w || !g.unlockSlots.get(params.walletId)) throw new HttpError(404, 'not_found', 'Hardware unlock is not on for that wallet.');
        await g.unlockSlots.remove([params.walletId]);
        g.log.warn('unlock_slots.removed', { walletIds: params.walletId, reason: 'web' });
        await w.logEvent({ type: 'unlock_slot_removed', walletIds: [params.walletId], by: 'web' });
        g.notifyOwner('unlock_slot_removed', `Unlocking your guardian with the hardware wallet of wallet ${params.walletId} was turned off in its web page. The passphrase still unlocks it.`, params.walletId);
        return ok(ownWalletsSecurity(g));
      },
    },
    {
      method: 'POST',
      path: '/own-wallets/:walletId/remove',
      handler: async ({ params, body }) => {
        requireSetUp(g);
        const input = (body ?? {}) as { confirm?: unknown };
        if (g.engine.registration()?.walletId === params.walletId)
          throw new HttpError(409, 'first_wallet', 'The first wallet holds the pairing: it is not removed here. Reset the guardian to forget every wallet.');
        const w = g.wallets.byWalletId(params.walletId);
        if (!w || w.engine.registration()?.walletId !== params.walletId) throw new HttpError(404, 'not_found', 'No such wallet on this guardian.');
        // Never while its recovery runs or its sweep waits: the web session gets no power over recoveries.
        const blocked = g.wallets.removalBlocker(w);
        if (blocked) throw new HttpError(409, blocked.code, blocked.message);
        if (input.confirm !== REMOVE_WALLET_CONFIRMATION) throw new HttpError(400, 'invalid', `Type ${REMOVE_WALLET_CONFIRMATION} to confirm.`);
        const res = await g.wallets.removeByOwner(params.walletId);
        if ('refused' in res) throw new HttpError(409, res.refused.code, res.refused.message);
        return ok(ownWalletsSecurity(g));
      },
    },
  ];
}
