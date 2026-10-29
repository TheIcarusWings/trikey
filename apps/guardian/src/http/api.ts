/**
 * The web UI's API (apps/guardian-web/API.md), backed by the engine and the
 * service state. Which endpoints work when:
 *
 *   before setup: GET /status, GET /setup/preflight, POST /setup
 *   locked:       GET /status, POST /unlock, POST /reset
 *   unlocked:     everything
 *
 * Anything else answers 409 `setup_required` or `locked`.
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { getNetwork, parsePsbt } from '@trikey/core';
import { encodePairingUri, encodeRecoveryUri } from '@trikey/protocol';
import type { Guardian } from '../guardian.js';
import type { RecoveryRecord } from '../policy/index.js';
import { engineEntry, serviceEntry, shortNpub } from './activity.js';
import { HttpError, type Route, type RouteResult } from './server.js';
import type { ActivityEntry, GuardianStatus, PairingSession, RecoveryCode, RecoveryInProgress, Rules, SetupPreflight } from './types.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body: unknown, status = 200): RouteResult => ({ status, body });
const MAX_ACTIVITY = 500;

function requireUnlocked(g: Guardian): void {
  if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
  if (g.locked) throw new HttpError(409, 'locked', 'The guardian is locked. Unlock it first.');
}

function requireNotSetUp(g: Guardian): void {
  if (g.setupComplete) throw new HttpError(409, 'already_setup', 'This guardian is already set up.');
}

export async function guardianStatus(g: Guardian): Promise<GuardianStatus> {
  const s = g.engine.status();
  const reg = g.engine.registration();
  const locked = g.locked;
  return {
    setupComplete: g.setupComplete,
    state: locked ? 'locked' : 'unlocked',
    ...(locked && g.lockedAt !== undefined ? { lockedAt: iso(g.lockedAt), lockReason: g.lockReason } : {}),
    relays: g.relayStatus(),
    chain: await g.chain.syncStatus(),
    wallets: reg ? [{ id: reg.walletId, name: 'Main', phonesPaired: 1 }] : [],
    retiredWallets: g.engine.retiredWallets().map((r) => ({
      id: r.registration.walletId,
      retiredAt: iso(r.retiredAt),
      reason: r.retirement.reason,
      ...(r.retirement.reason === 'recovered' && r.retirement.successorWalletId ? { successorId: r.retirement.successorWalletId } : {}),
    })),
    ...(reg ? { hardwareConfirmRequired: s.hardwareConfirmRequired } : {}),
    dailySpend: { usedSats: Number(s.dailyLimit?.used ?? 0n), limitSats: Number(s.dailyLimit?.limit ?? 0n) },
    recoveryInProgress: s.recoveryStatus !== 'none',
    ...(reg ? { phoneSpending: s.phoneSpending } : {}),
    network: g.config.network,
    ...(g.setupComplete && g.identity ? { npub: g.identity.npub } : {}),
    version: g.version,
  };
}

function phoneName(g: Guardian): string {
  return g.service.get().phones[0]?.name ?? 'Paired phone';
}

function recipientName(g: Guardian, pubkey: string): string {
  return pubkey === g.engine.registration()?.appNostrPubkey ? `${phoneName(g)} (paired phone)` : `Contact ${shortNpub(pubkey)}`;
}

function rules(g: Guardian): Rules {
  const r = g.engine.status().rules;
  const reg = g.engine.registration();
  if (!r || !reg) throw new HttpError(404, 'not_found', 'No wallet is paired with this guardian yet.');
  return {
    walletName: 'Main',
    dailyLimitSats: Number(r.dailyLimitSats),
    recoveryDelayDays: r.recoveryDelayDays,
    contacts: [
      { id: reg.appNostrPubkey, name: phoneName(g), kind: 'paired-phone' },
      ...r.alertContacts.map((pk) => ({ id: pk, name: shortNpub(pk), kind: 'contact' as const })),
    ],
    sweepFeeCapSats: Number(r.sweepFeeCapSats),
    hardwarePayments: 'any-amount',
  };
}

function sweepDestination(g: Guardian, rec: RecoveryRecord): string {
  try {
    const net = getNetwork(g.config.network);
    const tx = parsePsbt(base64.decode(rec.sweepPsbt));
    const out: string[] = [];
    for (let i = 0; i < tx.outputsLength; i++) {
      const script = tx.getOutput(i).script;
      if (script) out.push(btc.Address(net.btc).encode(btc.OutScript.decode(script)));
    }
    return out.join(', ');
  } catch {
    return `wallet ${rec.destinationWalletId}`;
  }
}

export function recoveryInProgress(g: Guardian): RecoveryInProgress | null {
  const rec = g.activeRecord();
  if (!rec) return null;
  const now = g.clock.now();
  const sentLog = g.engine
    .activity({ limit: 5000 })
    .filter((e) => e.type === 'alert_sent' && e.alertId.startsWith(`${rec.id}/`))
    .reverse();
  const wait = g.recovery.wait?.recoveryId === rec.id ? g.recovery.wait.detail : undefined;
  return {
    id: rec.id,
    state: rec.status === 'ready' || now >= rec.readyAt ? 'ready' : 'pending',
    startedAt: iso(rec.startedAt),
    endsAt: iso(rec.readyAt),
    lostKey: rec.survivingRole === 'hardware' ? 'phone' : 'hardware',
    // The engine verified this signature on every input when the recovery started.
    survivingKey: { device: rec.survivingRole === 'hardware' ? 'Hardware wallet' : 'Phone', signatureValid: true },
    destination: sweepDestination(g, rec),
    destinationWalletId: rec.destinationWalletId,
    sweepSats: Number(rec.amountSats),
    feeSats: Number(rec.feeSats),
    feeCapSats: Number(rec.feeCapSats),
    alertsSent: rec.recipients.map((r) => ({
      recipient: recipientName(g, r),
      sentAt: sentLog.filter((e) => e.type === 'alert_sent' && e.recipients.includes(r)).map((e) => iso(e.at)),
    })),
    ...(wait ? { waitingFor: wait } : g.locked && now >= rec.readyAt ? { waitingFor: 'The guardian is locked. Unlock it so it can co-sign the recovery.' } : {}),
  };
}

export function activity(g: Guardian, limit: number): ActivityEntry[] {
  const engine = g.engine.activity({ limit }).map((e) => ({ at: e.at, entry: engineEntry(e) }));
  const service = g.service
    .get()
    .activity.slice(-limit)
    .map((e) => ({ at: e.at, entry: serviceEntry(e) }));
  return [...engine, ...service]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((x) => x.entry);
}

function pairingSessionBody(g: Guardian, id: string): PairingSession {
  const s = g.pairing.get(id, g.clock.now());
  if (!s) throw new HttpError(404, 'not_found', 'No such pairing session.');
  const uri = encodePairingUri(
    { guardianPubkey: g.identity!.pubkey, relays: g.service.get().relays, secret: s.secret, expiresAt: Math.floor(s.expiresAt / 1000), label: 'Trikey Guardian' },
    Math.floor(s.createdAt / 1000),
  );
  return { id: s.id, uri, expiresAt: iso(s.expiresAt), status: s.status };
}

export function buildRoutes(g: Guardian): Route[] {
  return [
    { method: 'GET', path: '/status', handler: async () => ok(await guardianStatus(g)) },

    {
      method: 'GET',
      path: '/setup/preflight',
      handler: async () => {
        requireNotSetUp(g);
        const p = await g.chain.preflight();
        const body: SetupPreflight = { ...p, relayOptions: g.config.relayOptions.map((r) => ({ ...r })) };
        return ok(body);
      },
    },

    {
      method: 'POST',
      path: '/setup',
      handler: async ({ body }) => {
        requireNotSetUp(g);
        const input = (body ?? {}) as { passphrase?: unknown; relays?: unknown };
        const r = await g.setup({ passphrase: input.passphrase, relays: input.relays });
        if (!r.ok) throw new HttpError(r.code === 'already_setup' ? 409 : 400, r.code, r.message);
        return ok(await guardianStatus(g));
      },
    },

    {
      method: 'POST',
      path: '/unlock',
      handler: async ({ body }) => {
        const r = await g.unlock((body as { passphrase?: unknown } | undefined)?.passphrase, 'web');
        if (r.ok) return ok(await guardianStatus(g));
        if (r.code === 'bad_passphrase') throw new HttpError(401, 'bad_passphrase', 'That passphrase is not right.', r.retryAfterSeconds);
        if (r.code === 'rate_limited') throw new HttpError(429, 'rate_limited', 'Too many tries. Wait and try again.', r.retryAfterSeconds);
        throw new HttpError(r.code === 'setup_required' ? 409 : 400, r.code, 'message' in r ? r.message : 'Unlock failed.');
      },
    },

    {
      method: 'POST',
      path: '/lock',
      handler: async () => {
        requireUnlocked(g);
        await g.lock();
        return ok(await guardianStatus(g));
      },
    },

    {
      method: 'GET',
      path: '/activity',
      handler: ({ query }) => {
        requireUnlocked(g);
        const raw = Number(query.get('limit') ?? 100);
        const limit = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_ACTIVITY, Math.floor(raw))) : 100;
        return ok({ entries: activity(g, limit) });
      },
    },

    {
      method: 'GET',
      path: '/rules',
      handler: () => {
        requireUnlocked(g);
        return ok(rules(g));
      },
    },

    {
      method: 'GET',
      path: '/recovery',
      handler: () => {
        requireUnlocked(g);
        return ok({ recovery: recoveryInProgress(g) });
      },
    },

    {
      method: 'GET',
      path: '/recovery-code',
      handler: () => {
        requireUnlocked(g);
        const reg = g.engine.registration();
        if (!reg || !g.identity) throw new HttpError(404, 'not_found', 'Pair a wallet first: the recovery code is for the wallet this guardian protects.');
        const relays = g.service.get().relays;
        const body: RecoveryCode = {
          uri: encodeRecoveryUri({ guardianPubkey: g.identity.pubkey, relays, network: g.config.network, label: 'Trikey Guardian' }),
          npub: g.identity.npub,
          relays: [...relays],
          network: g.config.network,
          walletId: reg.walletId,
        };
        return ok(body);
      },
    },

    {
      method: 'POST',
      path: '/reset',
      handler: async ({ body }) => {
        if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
        const input = (body ?? {}) as { passphrase?: unknown; confirm?: unknown };
        const r = await g.reset({ passphrase: input.passphrase, confirm: input.confirm });
        if (r.ok) return ok(await guardianStatus(g));
        if (r.code === 'bad_passphrase') throw new HttpError(401, 'bad_passphrase', 'That passphrase is not right.', r.retryAfterSeconds);
        if (r.code === 'rate_limited') throw new HttpError(429, 'rate_limited', 'Too many tries. Wait and try again.', r.retryAfterSeconds);
        const status = r.code === 'invalid' ? 400 : 409;
        throw new HttpError(status, r.code, 'message' in r ? r.message : 'Reset refused.');
      },
    },

    {
      method: 'POST',
      path: '/pairing',
      handler: () => {
        requireUnlocked(g);
        if (g.engine.registration()) throw new HttpError(409, 'already_paired', 'This guardian is already paired with a wallet.');
        const s = g.pairing.create(g.clock.now());
        g.log.info('pairing.session_created', { expiresAt: iso(s.expiresAt) });
        return ok(pairingSessionBody(g, s.id), 201);
      },
    },

    {
      method: 'GET',
      path: '/pairing/:id',
      handler: ({ params }) => {
        requireUnlocked(g);
        return ok(pairingSessionBody(g, params.id));
      },
    },

    {
      method: 'GET',
      path: '/phones',
      handler: () => {
        requireUnlocked(g);
        const reg = g.engine.registration();
        const phones = reg
          ? g.service
              .get()
              .phones.filter((p) => p.pubkey === reg.appNostrPubkey)
              .map((p) => ({ id: p.pubkey.slice(0, 16), name: p.name, pairedAt: iso(p.pairedAt) }))
          : [];
        return ok({ phones });
      },
    },

    // Hosting for family is a later feature (DESIGN.md): the engine holds one wallet.
    {
      method: 'GET',
      path: '/hosting',
      handler: () => {
        requireUnlocked(g);
        return ok({ wallets: [], pendingInvite: null });
      },
    },
    {
      method: 'POST',
      path: '/hosting/invites',
      handler: () => {
        requireUnlocked(g);
        throw new HttpError(501, 'not_available', 'Hosting a guardian for family is not available yet.');
      },
    },
    {
      method: 'DELETE',
      path: '/hosting/invites/:id',
      handler: () => {
        requireUnlocked(g);
        throw new HttpError(501, 'not_available', 'Hosting a guardian for family is not available yet.');
      },
    },
  ];
}
