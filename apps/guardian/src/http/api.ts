/**
 * The web UI's API (apps/guardian-web/API.md), backed by the engine and the
 * service state. Which endpoints work when:
 *
 *   without a session: GET /status (reduced: `PublicStatus`), POST /session, DELETE /session,
 *                      and before setup GET /setup/preflight, POST /setup (which signs the browser in)
 *   locked:            GET /status, POST /unlock, POST /reset
 *   unlocked:          everything (GET and PUT /relays included)
 *
 * Without a session anything else answers 401 `unauthenticated`; with one, 409 `setup_required` or
 * `locked` as before (security review 2026-10, finding 10b).
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { getNetwork, parsePsbt } from '@trikey/core';
import { MAX_RELAYS, encodePairingUri, encodeRecoveryUri } from '@trikey/protocol';
import { MAX_RETIRING_RELAYS, type Guardian } from '../guardian.js';
import { isContactLockOn, isLimitOff, type RecoveryRecord } from '../policy/index.js';
import { npubEncode } from 'nostr-tools/nip19';
import { engineEntry, serviceEntry, shortNpub } from './activity.js';
import { HttpError, type Route, type RouteResult } from './server.js';
import type {
  ActivityEntry,
  ChannelHealth,
  GuardianStatus,
  NotificationSettings,
  NotifyTestResult,
  PairingSession,
  PublicStatus,
  RecoveryCode,
  RecoveryInProgress,
  RelaySettings,
  Rules,
  SavingsSummary,
  SetupPreflight,
} from './types.js';
import type { Health, HealthState } from '../notify/notifier.js';
import { sessionCookie } from './sessions.js';
import { hostingRoutes } from '../hosting/http.js';

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

/** `GET /api/status` without a session: which screen to show, nothing about the wallet. */
export function publicStatus(g: Guardian): PublicStatus {
  return { authenticated: false, setupComplete: g.setupComplete, state: g.locked ? 'locked' : 'unlocked', network: g.config.network, version: g.version };
}

/** Signs the browser in: a new session and its cookie. */
function signedIn(g: Guardian, secure: boolean): Record<string, string> {
  return { 'Set-Cookie': sessionCookie(g.sessions.create(g.clock.now()), secure) };
}

/** The watched Savings wallet for the web UI's card: the engine's record, the last scan, the last movement. */
export function savingsSummary(g: Guardian): SavingsSummary | undefined {
  const sv = g.engine.savings();
  if (!sv) return undefined;
  const last = g.savingsWatch.last?.walletId === sv.walletId ? g.savingsWatch.last : undefined;
  const moved = g.engine.activity({ limit: 5000 }).find((e) => e.type === 'savings_moved' && e.walletId === sv.walletId);
  return {
    id: sv.walletId,
    watchedSince: iso(sv.since),
    ...(last ? { balanceSats: Number(last.confirmedSats + last.unconfirmedSats), unconfirmedSats: Number(last.unconfirmedSats), scannedAt: iso(last.at) } : {}),
    ...(moved && moved.type === 'savings_moved' ? { lastMoved: { at: iso(moved.at), sats: Number(moved.amountSats), txid: moved.txid } } : {}),
  };
}

export async function guardianStatus(g: Guardian): Promise<GuardianStatus> {
  const s = g.engine.status();
  const reg = g.engine.registration();
  const locked = g.locked;
  return {
    authenticated: true,
    setupComplete: g.setupComplete,
    state: locked ? 'locked' : 'unlocked',
    ...(locked && g.lockedAt !== undefined ? { lockedAt: iso(g.lockedAt), lockReason: g.lockReason } : {}),
    ...(locked && g.lockReason === 'contact' && g.lockedBy ? { lockedBy: npubEncode(g.lockedBy) } : {}),
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
    dailySpend: { usedSats: Number(s.dailyLimit?.used ?? 0n), limitSats: Number(s.dailyLimit?.limit ?? 0n), ...(s.dailyLimit?.off ? { limitOff: true as const } : {}) },
    ...(reg && g.engine.savings() ? { savings: savingsSummary(g) } : {}),
    recoveryInProgress: s.recoveryStatus !== 'none',
    ...(reg ? { phoneSpending: s.phoneSpending } : {}),
    network: g.config.network,
    ...(g.setupComplete && g.identity ? { npub: g.identity.npub } : {}),
    version: g.version,
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
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
    ...(isLimitOff(r) ? { dailyLimitOff: true as const } : {}),
    recoveryDelayDays: r.recoveryDelayDays,
    contacts: [
      { id: reg.appNostrPubkey, name: phoneName(g), kind: 'paired-phone' },
      ...r.alertContacts.map((pk) => ({ id: pk, name: shortNpub(pk), kind: 'contact' as const })),
    ],
    sweepFeeCapSats: Number(r.sweepFeeCapSats),
    contactLock: isContactLockOn(r),
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
  const engine = g.engine.activity({ limit }).map((e) => {
    const entry = engineEntry(e);
    // A repeated identical refusal is one entry with a count (engine.ts, `log`).
    const repeated = e.count && e.count > 1 ? { ...entry, event: `${entry.event} (${e.count} times, the last ${iso(e.lastAt ?? e.at)})` } : entry;
    return { at: e.lastAt ?? e.at, entry: repeated };
  });
  const service = g.service
    .get()
    .activity.slice(-limit)
    .map((e) => ({ at: e.at, entry: serviceEntry(e) }));
  return [...engine, ...service]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((x) => x.entry);
}

/** `GET` and `PUT /api/relays`. */
export function relaySettings(g: Guardian): RelaySettings {
  const change = g.service.get().relaysChange;
  return {
    relays: g.relayStatus(),
    retiring: g.retiringRelayStatus().map((r) => ({ url: r.url, connected: r.connected, since: iso(r.since) })),
    options: g.config.relayOptions.map((r) => ({ ...r })),
    ...(change ? { lastChange: { at: iso(change.at), ...(change.confirmedAt !== undefined ? { phoneConfirmedAt: iso(change.confirmedAt) } : {}) } } : {}),
    max: MAX_RELAYS,
    maxRetiring: MAX_RETIRING_RELAYS,
  };
}

function healthBody(h: Health & { state: HealthState }): ChannelHealth {
  return {
    state: h.state,
    ...(h.lastOkAt !== undefined ? { lastOkAt: iso(h.lastOkAt) } : {}),
    ...(h.lastErrorAt !== undefined ? { lastErrorAt: iso(h.lastErrorAt) } : {}),
    ...(h.lastError ? { lastError: h.lastError } : {}),
  };
}

/** `GET` and `PUT /api/notifications` (secrets never leave the guardian: only "set" and hints). */
export function notificationSettings(g: Guardian): NotificationSettings {
  const v = g.notifier.view();
  const contacts = g.engine.status().rules?.alertContacts ?? [];
  return {
    guardianName: v.guardianName,
    ...(v.smtp ? { smtp: { ...v.smtp, health: healthBody(v.smtp.health) } } : {}),
    destinations: v.destinations.map((d) => ({ ...d, ...(d.contact ? { contactNpub: npubEncode(d.contact) } : {}), health: healthBody(d.health) })),
    contacts: contacts.map((pubkey) => ({ pubkey, npub: npubEncode(pubkey) })),
    recoveryRunning: !!g.activeRecord(),
    pending: v.pending,
    defaultNtfyServer: v.defaultNtfyServer,
    limits: v.limits,
  };
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
    // Without a session (after setup): only what picks the screen.
    {
      method: 'GET',
      path: '/status',
      public: true,
      handler: async ({ session }) => ok(session.authenticated || !g.setupComplete ? await guardianStatus(g) : publicStatus(g)),
    },

    // Sign in with the unlock passphrase (its own throttle). `unlock: true` on a locked guardian unlocks it
    // too (one passphrase entry): that goes through the web unlock and its throttle instead.
    {
      method: 'POST',
      path: '/session',
      public: true,
      handler: async ({ body, session }) => {
        if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
        const input = (body ?? {}) as { passphrase?: unknown; unlock?: unknown };
        const r = input.unlock === true && g.locked ? await g.unlock(input.passphrase, 'web') : await g.checkWebPassphrase(input.passphrase);
        if (r.ok) return { status: 200, body: await guardianStatus(g), headers: signedIn(g, session.secure) };
        if (r.code === 'bad_passphrase') throw new HttpError(401, 'bad_passphrase', 'That passphrase is not right.', r.retryAfterSeconds);
        if (r.code === 'rate_limited') throw new HttpError(429, 'rate_limited', 'Too many tries. Wait and try again.', r.retryAfterSeconds);
        throw new HttpError(r.code === 'setup_required' ? 409 : 400, r.code, 'message' in r ? r.message : 'Sign-in failed.');
      },
    },

    {
      method: 'DELETE',
      path: '/session',
      public: true,
      handler: ({ session }) => {
        g.sessions.destroy(session.token);
        return { status: 200, body: publicStatus(g), headers: { 'Set-Cookie': sessionCookie(undefined, session.secure) } };
      },
    },

    {
      method: 'GET',
      path: '/setup/preflight',
      // First-run setup is open only until setup completes.
      public: () => !g.setupComplete,
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
      public: () => !g.setupComplete,
      handler: async ({ body, session }) => {
        requireNotSetUp(g);
        // `entropy`: 32 bytes from the browser's generator (hex), mixed into the new seed; never logged or kept.
        const input = (body ?? {}) as { passphrase?: unknown; relays?: unknown; entropy?: unknown };
        const r = await g.setup({ passphrase: input.passphrase, relays: input.relays, entropy: input.entropy });
        if (!r.ok) throw new HttpError(r.code === 'already_setup' ? 409 : 400, r.code, r.message);
        // The browser that set the guardian up is signed in.
        return { status: 200, body: await guardianStatus(g), headers: signedIn(g, session.secure) };
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
      path: '/relays',
      handler: () => {
        requireUnlocked(g);
        return ok(relaySettings(g));
      },
    },

    // Changing relays: the guardian moves at once, keeps the old ones until the owner stops them and tells the phone (guardian.ts).
    {
      method: 'PUT',
      path: '/relays',
      handler: async ({ body }) => {
        requireUnlocked(g);
        const r = await g.changeRelays((body as { relays?: unknown } | undefined)?.relays);
        if (!r.ok) throw new HttpError(r.code === 'invalid' ? 400 : 409, r.code, r.message);
        return ok(relaySettings(g));
      },
    },

    // Stop watching the old relays: all of them, or one (its URL, percent-encoded). Same checks as PUT /relays.
    {
      method: 'DELETE',
      path: '/relays/retiring',
      handler: async () => {
        requireUnlocked(g);
        const r = await g.stopWatchingRelays();
        if (!r.ok) throw new HttpError(r.code === 'setup_required' ? 409 : 400, r.code, r.message);
        return ok(relaySettings(g));
      },
    },
    {
      method: 'DELETE',
      path: '/relays/retiring/:url',
      handler: async ({ params }) => {
        requireUnlocked(g);
        const r = await g.stopWatchingRelays(params.url);
        if (!r.ok) throw new HttpError(r.code === 'not_found' ? 404 : r.code === 'setup_required' ? 409 : 400, r.code, r.message);
        return ok(relaySettings(g));
      },
    },

    // Extra alert channels: email (the owner's own account), ntfy, webhook. Unlocked only, like the relays.
    {
      method: 'GET',
      path: '/notifications',
      handler: () => {
        requireUnlocked(g);
        return ok(notificationSettings(g));
      },
    },
    {
      method: 'PUT',
      path: '/notifications',
      handler: async ({ body }) => {
        requireUnlocked(g);
        const r = await g.updateNotifications(body);
        if (!r.ok) {
          if (r.code === 'rate_limited') throw new HttpError(429, 'rate_limited', r.message, r.retryAfterSeconds);
          throw new HttpError(r.code === 'invalid' ? 400 : 409, r.code, r.message);
        }
        return ok(notificationSettings(g));
      },
    },
    {
      method: 'POST',
      path: '/notifications/test',
      handler: async ({ body }) => {
        requireUnlocked(g);
        const r = await g.testNotification(body);
        if (r.ok) {
          const res: NotifyTestResult = { ok: true, health: healthBody(r.health) };
          return ok(res);
        }
        if (r.code === 'not_found') throw new HttpError(404, 'not_found', r.message);
        if (r.code === 'rate_limited') throw new HttpError(429, 'rate_limited', r.message, r.retryAfterSeconds);
        // The send failed: an answer, not an error of the API (the page shows it next to the channel).
        const res: NotifyTestResult = { ok: false, error: r.message, health: healthBody(r.health ?? { state: 'failing' }) };
        return ok(res);
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
          // With the wallet id, the new phone signs the access text bound to this wallet (recovery.access v2).
          uri: encodeRecoveryUri({ guardianPubkey: g.identity.pubkey, relays, network: g.config.network, label: 'Trikey Guardian', walletId: reg.walletId }),
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
      handler: async ({ body, session }) => {
        if (!g.setupComplete) throw new HttpError(409, 'setup_required', 'Set up the guardian first.');
        const input = (body ?? {}) as { passphrase?: unknown; confirm?: unknown; entropy?: unknown };
        const r = await g.reset({ passphrase: input.passphrase, confirm: input.confirm, entropy: input.entropy });
        // A reset ends every session; the browser that did it (with the passphrase) is signed in again.
        if (r.ok) return { status: 200, body: await guardianStatus(g), headers: signedIn(g, session.secure) };
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

    // Hosting for family (docs/design/family-hosting.md): hosting/http.ts.
    ...hostingRoutes(g),
  ];
}
