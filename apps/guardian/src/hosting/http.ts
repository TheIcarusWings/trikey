/**
 * The web UI's hosting endpoints (apps/guardian-web/API.md, "Hosting for family"). The host sees names, states and
 * dates of the wallets it hosts, and a weekly count of co-signed payments; never an amount, a balance or an address.
 */
import { encodeInviteUri } from '@trikey/protocol';
import type { Guardian } from '../guardian.js';
import { HttpError, type Route, type RouteResult } from '../http/server.js';
import type { FamilyInvite, HostedWallet, HostingOverview } from '../http/types.js';
import { MAX_HOSTED_WALLETS, MAX_PENDING_INVITES, type SlotRecord } from './types.js';
import type { HostedEngine } from './engine.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body: unknown, status = 200): RouteResult => ({ status, body });
const WEEK = 7 * 86_400_000;

function requireUnlocked(g: Guardian): void {
  if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
  if (g.locked) throw new HttpError(409, 'locked', 'The guardian is locked. Unlock it first.');
}

function inviteOf(s: SlotRecord, now: number, link?: string): FamilyInvite {
  const inv = s.invite!;
  const status = s.state === 'invited' ? (inv.expiresAt > now ? 'pending' : 'expired') : s.state === 'cancelled' ? 'cancelled' : s.state === 'expired' ? 'expired' : 'accepted';
  return { id: inv.id, name: s.name, ...(link ? { link } : {}), createdAt: iso(s.createdAt), expiresAt: iso(inv.expiresAt), status };
}

export function hostedWalletOf(s: SlotRecord, engine: HostedEngine | undefined, now: number): HostedWallet | undefined {
  if (s.state === 'cancelled' || s.state === 'expired') return undefined;
  if (s.state === 'invited') return { id: s.slotId, name: s.name, state: 'invited', ...(s.invite ? { inviteId: s.invite.id } : {}) };
  const rec = engine?.activeRecord();
  const rules = engine?.rules();
  const state = s.state === 'ended' || s.state === 'left' ? s.state : rec ? 'recovering' : s.state === 'leaving' ? 'leaving' : 'active';
  return {
    id: s.slotId,
    name: s.name,
    state,
    ...(s.acceptedAt !== undefined ? { since: iso(s.acceptedAt) } : {}),
    ...(rules ? { recoveryDelayDays: rules.recoveryDelayDays } : {}),
    ...(engine && (state === 'active' || state === 'leaving' || state === 'recovering') ? { paymentsThisWeek: engine.cosignCount(now - WEEK) } : {}),
    ...(rec ? { recoveryReadyAt: iso(rec.readyAt) } : {}),
    ...(s.state === 'leaving' && s.endsAt !== undefined ? { endsAt: iso(s.endsAt) } : {}),
    ...(s.endedAt !== undefined && (s.state === 'ended' || s.state === 'left') ? { endedAt: iso(s.endedAt) } : {}),
  };
}

export function hostingOverview(g: Guardian): HostingOverview {
  const now = g.clock.now();
  const h = g.hosting;
  const wallets = h.overview().flatMap(({ slot, engine }) => {
    const w = hostedWalletOf(slot, engine, now);
    return w ? [w] : [];
  });
  const pending = h.registry.pending(now).at(-1);
  return {
    available: h.enabled,
    wallets,
    pendingInvite: pending ? inviteOf(pending, now) : null,
    limits: { maxWallets: MAX_HOSTED_WALLETS, maxPendingInvites: MAX_PENDING_INVITES },
  };
}

export function hostingRoutes(g: Guardian): Route[] {
  const requireHosting = () => {
    requireUnlocked(g);
    if (!g.hosting.enabled) throw new HttpError(501, 'not_available', 'Hosting is turned off on this guardian (FAMILY_HOSTING=false).');
  };
  return [
    {
      method: 'GET',
      path: '/hosting',
      handler: () => {
        requireUnlocked(g);
        return ok(hostingOverview(g));
      },
    },
    {
      method: 'POST',
      path: '/hosting/invites',
      handler: async ({ body }) => {
        requireHosting();
        if (!g.identity) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
        const now = g.clock.now();
        const r = await g.hosting.registry.createInvite((body as { name?: unknown } | undefined)?.name, now);
        if (!r.ok) throw new HttpError(r.code === 'invalid' ? 400 : 409, r.code, r.message);
        const link = encodeInviteUri(
          { guardianPubkey: g.identity.pubkey, relays: g.service.get().relays, secret: r.secret, expiresAt: Math.floor(r.slot.invite!.expiresAt / 1000), network: g.config.network, label: 'Trikey Guardian' },
          Math.floor(now / 1000),
        );
        await g.logEvent({ type: 'hosting_invite_created', name: r.slot.name, expiresAt: r.slot.invite!.expiresAt });
        g.log.info('hosting.invite_created', { slot: r.slot.slotId });
        return ok(inviteOf(r.slot, now, link), 201);
      },
    },
    {
      method: 'DELETE',
      path: '/hosting/invites/:id',
      handler: async ({ params }) => {
        requireUnlocked(g);
        const s = await g.hosting.registry.cancelInvite(params.id);
        if (!s) throw new HttpError(404, 'not_found', 'No such invite, or it was already accepted.');
        await g.logEvent({ type: 'hosting_invite_cancelled', name: s.name });
        return ok(hostingOverview(g));
      },
    },
    {
      method: 'POST',
      path: '/hosting/wallets/:id/stop',
      handler: async ({ params, body }) => {
        requireUnlocked(g);
        const input = (body ?? {}) as { now?: unknown; confirm?: unknown };
        const r = await g.hosting.stop(params.id, { now: input.now === true, confirm: input.confirm });
        if (!r.ok) throw new HttpError(r.code === 'not_found' ? 404 : r.code === 'invalid' ? 400 : 409, r.code, r.message);
        return ok(hostedWalletOf(r.slot, g.hosting.engines.get(r.slot.slotId), g.clock.now()));
      },
    },
    {
      method: 'DELETE',
      path: '/hosting/wallets/:id',
      handler: async ({ params }) => {
        requireUnlocked(g);
        if (!(await g.hosting.remove(params.id))) throw new HttpError(409, 'still_hosted', 'Only an ended, left or expired wallet can be removed from the list.');
        return ok(hostingOverview(g));
      },
    },
  ];
}
