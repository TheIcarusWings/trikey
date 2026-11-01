/**
 * Extra alert channels: email through the owner's own account, ntfy, a generic webhook (docs/design/notifications.md).
 * Notify-only: they carry the same warnings as the nostr alerts, never a control (`CANCEL` and `LOCK` stay nostr DMs).
 *
 * **Settings** (`notifications.json`, secrets sealed under `notifications-key.json`: secrets.ts) are the owner's
 * delivery settings, outside the hardware-approved rules: only the web UI changes them (a signed-in session on an
 * unlocked guardian), never the phone, and every change is announced on every channel, the removed ones included and
 * over the email account as it was before the change, plus the paired phone (`notifications_changed`). While a
 * recovery runs, removing or changing a channel or the email account is refused; adding is allowed, and so is changing
 * only the email account's app password (a revoked one must be fixable when warnings matter most), announced as well.
 *
 * **Delivery** has the semantics of the nostr notices (engine.ts `LimitNotice`): every alert becomes an outbox item
 * with one delivery per destination, persisted before the first try; a delivery is retried with backoff until it is
 * sent or `NOTIFY_TTL_MS` (7 days) old; an item counts once (its id is remembered for longer than the TTL, so the
 * engine listing the same alert again does not send it twice); a newer recovery reminder replaces an undelivered older
 * one. Per-channel failures are kept (`health`, shown in the web UI) and logged when a channel starts failing, works
 * again, or a message expires undelivered. Rate limits: per channel, for the email account as a whole, for test
 * messages and for settings changes.
 *
 * Works while the guardian is locked: nothing here needs key 3 or the passphrase.
 */
import { join } from 'node:path';
import { hex } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';
import { Mutex, readJsonFile, writeFileAtomic } from '../files.js';
import { errorText, silentLogger, type Logger } from '../log.js';
import { SlidingWindowLimiter, type RateLimitOptions } from '../rate-limit.js';
import type { ServiceEvent } from '../service-state.js';
import { sendEmail, sendNtfy, sendWebhook, type SmtpAccount, type SmtpTestOptions, type WebhookPayload } from './channels.js';
import { checkHttpUrl, type NetPolicy } from './net.js';
import { DEFAULT_GUARDIAN_NAME, PRIORITIES, TITLES, checkGuardianName, finish, maskEmail, topicHint, type Message } from './render.js';
import { SecretBox, isSealed, type Sealed } from './secrets.js';
import {
  DEFAULT_NTFY_SERVER,
  MAX_CONTACT_ONLY,
  MAX_DESTINATIONS,
  MAX_OWNER_PER_KIND,
  SettingsError,
  checkCaps,
  checkDestination,
  checkSmtp,
  type DestinationInput,
  type StoredDestination,
  type StoredSmtp,
} from './settings.js';

export const NOTIFY_FILE = 'notifications.json';
const DAY = 86_400_000;
const MINUTE = 60_000;
/** How long an undelivered message is retried: the nostr notices' TTL. */
export const NOTIFY_TTL_MS = 7 * DAY;
/** Item ids remembered after they are done: longer than the TTL, so an alert the engine still lists never goes twice. */
const DONE_KEEP_MS = NOTIFY_TTL_MS + DAY;
/** Waits between tries of one delivery; the last repeats until the TTL. */
export const RETRY_DELAYS_MS = [1, 2, 5, 10, 30, 60].map((m) => m * MINUTE);
export const MAX_OUTBOX_ITEMS = 100;
/** Deliveries attempted per pass (a pass runs again at the next tick). */
const MAX_SENDS_PER_PASS = 40;
export const CHANNEL_LIMIT: RateLimitOptions = { max: 20, windowMs: 60 * MINUTE };
export const SMTP_LIMIT: RateLimitOptions = { max: 60, windowMs: 60 * MINUTE };
export const TEST_LIMIT: RateLimitOptions = { max: 10, windowMs: 10 * MINUTE };
export const CHANGE_LIMIT: RateLimitOptions = { max: 30, windowMs: 60 * MINUTE };

export interface Health {
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** The last send failed (kept explicitly: an error and a success can share a millisecond). */
  failing?: boolean;
}

export type HealthState = 'ok' | 'failing' | 'untested';

export function healthState(h: Health | undefined): HealthState {
  if (!h || (h.lastOkAt === undefined && h.lastErrorAt === undefined)) return 'untested';
  return h.failing ? 'failing' : 'ok';
}

interface Delivery {
  dest: string;
  msg: Message;
  attempts: number;
  nextAt: number;
  sentAt?: number;
  /** Given up: the destination is gone (removed, nothing to send it with). */
  droppedAt?: number;
  lastError?: string;
  /**
   * A change announcement goes out over the channel and the email account as they were BEFORE the change (a removed
   * channel is told it was removed; a changed account cannot silence the announcement). Failing that, the current
   * account is tried on every other attempt (the owner may have just fixed a wrong password).
   */
  via?: { dest: StoredDestination; smtp?: StoredSmtp };
}

interface OutboxItem {
  id: string;
  type: string;
  at: number;
  walletId?: string;
  deliveries: Delivery[];
}

interface NotifyFile {
  version: 1;
  guardianName: string;
  smtp?: StoredSmtp;
  destinations: StoredDestination[];
  /** Per destination id, and `smtp` for the email account. */
  health: Record<string, Health>;
  outbox: OutboxItem[];
  done: { id: string; at: number }[];
  changes: number;
}

const empty = (): NotifyFile => ({ version: 1, guardianName: DEFAULT_GUARDIAN_NAME, destinations: [], health: {}, outbox: [], done: [], changes: 0 });

/** Who reads a contact's message, as far as controls go: a nostr key (CANCEL / LOCK on nostr) or none (warnings only). */
export type Reach = 'nostr' | 'none';

/** An alert to deliver: alerts.ts and guardian.ts build these from the same facts as the matching nostr alert. */
export interface NotifyEvent {
  /** Unique per alert (the engine's alert or notice id, or the service's). */
  id: string;
  /** The alert type (render.ts `TITLES`). */
  type: string;
  /** When it happened (ms). */
  at: number;
  walletId?: string;
  /** The owner's text (the phone's alert message); absent: not for the owner. */
  owner?: string;
  /** The contacts' text; absent: not for contacts. */
  contacts?: {
    text: (reach: Reach) => string;
    /** The nostr pubkeys the matching nostr alert goes to: a contact's channels get it only if the contact is one. Default: the rules' contacts. */
    recipients?: string[];
  };
}

export interface NotifierOptions {
  dataDir: string;
  now: () => number;
  log?: Logger;
  /** Logs to the activity log. */
  logEvent?: (e: ServiceEvent) => Promise<void> | void;
  /** The alert contacts of the active wallet's rules (nostr pubkeys). */
  contacts: () => string[];
  /** Test seams. */
  net?: NetPolicy;
  smtpTest?: SmtpTestOptions;
}

/** The web UI's view of one destination (types in apps/guardian-web/src/api/types.ts). */
export interface DestinationView {
  id: string;
  audience: 'owner' | 'contact';
  kind: 'email' | 'ntfy' | 'webhook';
  contact?: string;
  contactInRules?: boolean;
  email?: string;
  ntfy?: { server: string; topicHint: string; tokenSet: boolean };
  webhook?: { origin: string; secretSet: boolean };
  health: Health & { state: HealthState };
}

export interface SettingsView {
  guardianName: string;
  smtp?: Omit<StoredSmtp, 'password' | 'pin'> & {
    /** The pinned certificate's SHA-256, and whether the certificate itself was pasted (else only its fingerprint). */
    pin?: { sha256: string; certificate: boolean };
    passwordSet: true;
    health: Health & { state: HealthState };
  };
  destinations: DestinationView[];
  pending: number;
  limits: { destinations: number; ownerPerKind: number; contactOnly: number };
  defaultNtfyServer: string;
}

/** The phone's read-only summary (`guardian.status.notifications`): kinds and masked hints, no secret, no full address. */
export interface ChannelSummary {
  kind: 'email' | 'ntfy' | 'webhook';
  audience: 'owner' | 'contact';
  contact?: string;
  hint: string;
  failing?: true;
}

export type UpdateOutcome =
  | { ok: true; changed: false }
  | { ok: true; changed: true; changes: string[] }
  | { ok: false; code: 'invalid' | 'recovery_pending' | 'rate_limited'; message: string; retryAfterSeconds?: number };

export type TestOutcome = { ok: true; health: Health & { state: HealthState } } | { ok: false; code: 'not_found' | 'rate_limited' | 'failed'; message: string; health?: Health & { state: HealthState }; retryAfterSeconds?: number };

const newId = () => `d${hex.encode(secureRandomBytes(6))}`;
const shortNpubText = (pk: string) => `${pk.slice(0, 8)}…`;

function kindWords(d: Pick<StoredDestination, 'kind'>): string {
  return d.kind === 'email' ? 'email address' : d.kind === 'ntfy' ? 'ntfy topic' : 'webhook';
}

/** A destination in a message (masked: no domain, no topic). */
function messageLabel(d: StoredDestination): string {
  if (d.kind === 'email') return `email ${maskEmail(d.email ?? '')}`;
  if (d.kind === 'ntfy') return `ntfy topic ${d.ntfy?.hint ?? ''}`;
  return 'webhook';
}

function whoLabel(d: StoredDestination): string {
  return d.audience === 'owner' ? 'for you' : d.contact ? `for alert contact ${shortNpubText(d.contact)}` : 'for a contact without a nostr key';
}

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');

export class Notifier {
  private file: NotifyFile = empty();
  private readonly box: SecretBox;
  private readonly mutex = new Mutex();
  private readonly log: Logger;
  private running?: Promise<void>;
  private again = false;
  private readonly channelLimiter = new SlidingWindowLimiter(CHANNEL_LIMIT);
  private readonly smtpLimiter = new SlidingWindowLimiter(SMTP_LIMIT);
  private readonly testLimiter = new SlidingWindowLimiter(TEST_LIMIT);
  private readonly changeLimiter = new SlidingWindowLimiter(CHANGE_LIMIT);

  constructor(private readonly opts: NotifierOptions) {
    this.box = new SecretBox(opts.dataDir, opts.now);
    this.log = opts.log ?? silentLogger;
  }

  private get path(): string {
    return join(this.opts.dataDir, NOTIFY_FILE);
  }

  async load(): Promise<void> {
    await this.box.load();
    const raw = (await readJsonFile(this.path)) as NotifyFile | undefined;
    if (raw === undefined) return;
    if (raw.version !== 1 || !Array.isArray(raw.destinations) || !Array.isArray(raw.outbox)) throw new Error('unsupported notifications file');
    this.file = { ...empty(), ...raw };
  }

  private async save(next: NotifyFile): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(next)}\n`, { overwrite: true });
    this.file = next;
  }

  /** Runs `fn` on a copy under the lock and saves it when it returns true. */
  private change(fn: (draft: NotifyFile, now: number) => boolean | Promise<boolean>): Promise<void> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.file);
      if (await fn(draft, this.opts.now())) await this.save(draft);
    });
  }

  get guardianName(): string {
    return this.file.guardianName;
  }

  /** True when any channel is set up (a guardian without any does no work here). */
  get configured(): boolean {
    return this.file.destinations.length > 0;
  }

  /** Messages not delivered yet (and not given up). */
  get pending(): number {
    return this.file.outbox.reduce((n, i) => n + i.deliveries.filter((d) => d.sentAt === undefined && d.droppedAt === undefined).length, 0);
  }

  // ---------------------------------------------------------------------------
  // Views

  private healthView(id: string): Health & { state: HealthState } {
    const h = this.file.health[id] ?? {};
    return { ...h, state: healthState(h) };
  }

  view(): SettingsView {
    const f = this.file;
    const inRules = new Set(this.opts.contacts());
    return {
      guardianName: f.guardianName,
      ...(f.smtp
        ? {
            smtp: {
              host: f.smtp.host,
              port: f.smtp.port,
              security: f.smtp.security,
              username: f.smtp.username,
              from: f.smtp.from,
              ...(f.smtp.pin ? { pin: { sha256: f.smtp.pin.sha256, certificate: !!f.smtp.pin.pem } } : {}),
              passwordSet: true as const,
              health: this.healthView('smtp'),
            },
          }
        : {}),
      destinations: f.destinations.map((d) => ({
        id: d.id,
        audience: d.audience,
        kind: d.kind,
        ...(d.contact ? { contact: d.contact, contactInRules: inRules.has(d.contact) } : {}),
        ...(d.email ? { email: d.email } : {}),
        ...(d.ntfy ? { ntfy: { server: d.ntfy.server, topicHint: d.ntfy.hint, tokenSet: !!d.ntfy.token } } : {}),
        ...(d.webhook ? { webhook: { origin: d.webhook.origin, secretSet: !!d.webhook.secret } } : {}),
        health: this.healthView(d.id),
      })),
      pending: this.pending,
      limits: { destinations: MAX_DESTINATIONS, ownerPerKind: MAX_OWNER_PER_KIND, contactOnly: MAX_CONTACT_ONLY },
      defaultNtfyServer: DEFAULT_NTFY_SERVER,
    };
  }

  /** For the paired phone: what is set up, masked (no topic, no URL, no full address). */
  summary(): ChannelSummary[] {
    return this.file.destinations.map((d) => {
      const failing = healthState(this.file.health[d.id]) === 'failing' || (d.kind === 'email' && healthState(this.file.health.smtp) === 'failing');
      let hint: string;
      if (d.kind === 'email') {
        const [local = '', domain = ''] = (d.email ?? '').split('@');
        hint = `${local.slice(0, 1)}…@${domain}`;
      } else if (d.kind === 'ntfy') hint = new URL(d.ntfy!.server).host;
      else hint = new URL(d.webhook!.origin).host;
      return { kind: d.kind, audience: d.audience, ...(d.contact ? { contact: d.contact } : {}), hint: hint.slice(0, 64), ...(failing ? { failing: true as const } : {}) };
    });
  }

  /** A destination as the activity log names it (the owner's own log: full address, topic hint, webhook origin). */
  describe(d: StoredDestination): string {
    const what = d.kind === 'email' ? `email to ${d.email}` : d.kind === 'ntfy' ? `ntfy topic ${d.ntfy?.hint} on ${d.ntfy?.server}` : `webhook to ${d.webhook?.origin}`;
    const who = d.audience === 'owner' ? 'you' : d.contact ? `alert contact ${shortNpubText(d.contact)}` : 'a contact without a nostr key';
    return `${what} (${who})`;
  }

  // ---------------------------------------------------------------------------
  // Settings

  /**
   * `PUT /api/notifications`: replaces the settings. `recoveryRunning`: while true, removing or changing a channel or
   * the email account is refused (adding is allowed, and changing only the email account's app password). Every change
   * queues one `notifications_changed` announcement to every channel before and after it (see the file comment); the
   * caller logs it and tells the phone.
   */
  async update(input: unknown, ctx: { recoveryRunning: boolean }): Promise<UpdateOutcome> {
    let outcome = { ok: true, changed: false } as UpdateOutcome;
    await this.change(async (draft, now) => {
      const r = (input ?? {}) as { guardianName?: unknown; smtp?: unknown; destinations?: unknown };
      let name: string;
      let smtpIn: ReturnType<typeof checkSmtp> | null;
      let list: DestinationInput[];
      try {
        try {
          name = checkGuardianName(r.guardianName);
        } catch (e) {
          throw new SettingsError((e as Error).message);
        }
        smtpIn = r.smtp === null || r.smtp === undefined ? null : checkSmtp(r.smtp, !!draft.smtp);
        if (!Array.isArray(r.destinations)) throw new SettingsError('destinations must be a list.');
        if (r.destinations.length > MAX_DESTINATIONS) throw new SettingsError(`Use at most ${MAX_DESTINATIONS} channels.`);
        const byId = new Map(draft.destinations.map((d) => [d.id, d]));
        list = r.destinations.map((d) => checkDestination(d, typeof (d as { id?: unknown })?.id === 'string' ? byId.get((d as { id: string }).id) : undefined, this.opts.net));
        const ids = list.map((d) => d.id).filter(Boolean);
        if (new Set(ids).size !== ids.length) throw new SettingsError('A channel is in the list twice.');
        checkCaps(list.map((d) => ({ ...d, key: d.kind === 'email' ? `${d.audience}:${d.contact ?? ''}:${d.email}` : undefined })));
        if (list.some((d) => d.kind === 'email') && !smtpIn) throw new SettingsError('Set up the email account first: email channels send through it.');
      } catch (e) {
        if (e instanceof SettingsError) {
          outcome = { ok: false, code: 'invalid', message: e.message };
          return false;
        }
        throw e;
      }

      // The new list, sealing new secrets and keeping stored ones.
      const before = draft.destinations;
      const next: StoredDestination[] = [];
      for (const d of list) {
        const old = d.id ? before.find((b) => b.id === d.id) : undefined;
        const id = old?.id ?? newId();
        const stored: StoredDestination = { id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), createdAt: old?.createdAt ?? now };
        if (d.kind === 'email') stored.email = d.email;
        if (d.kind === 'ntfy' && d.ntfy) {
          const topic = d.ntfy.topic !== undefined ? await this.sealOrKeep(`${id}.topic`, d.ntfy.topic, old?.ntfy?.topic) : old!.ntfy!.topic;
          const hint = d.ntfy.topic !== undefined ? topicHint(d.ntfy.topic) : old!.ntfy!.hint;
          const token = d.ntfy.token === null ? undefined : d.ntfy.token !== undefined ? await this.sealOrKeep(`${id}.token`, d.ntfy.token, old?.ntfy?.token) : old?.ntfy?.token;
          stored.ntfy = { server: d.ntfy.server, topic, hint, ...(token ? { token } : {}) };
        }
        if (d.kind === 'webhook' && d.webhook) {
          const url = d.webhook.url !== undefined ? await this.sealOrKeep(`${id}.url`, d.webhook.url, old?.webhook?.url) : old!.webhook!.url;
          const origin = d.webhook.origin ?? old!.webhook!.origin;
          const secret = d.webhook.secret === null ? undefined : d.webhook.secret !== undefined ? await this.sealOrKeep(`${id}.secret`, d.webhook.secret, old?.webhook?.secret) : old?.webhook?.secret;
          stored.webhook = { url, origin, ...(secret ? { secret } : {}) };
        }
        next.push(stored);
      }
      let smtp: StoredSmtp | undefined;
      if (smtpIn) {
        const password = smtpIn.password !== undefined ? await this.sealOrKeep('smtp.password', smtpIn.password, draft.smtp?.password) : draft.smtp!.password;
        // The pin: absent keeps the stored one; the same certificate again (by fingerprint) keeps the stored one too,
        // unless the certificate itself now comes with it.
        const oldPin = draft.smtp?.pin;
        const pin = smtpIn.pin === undefined ? oldPin : smtpIn.pin === null ? undefined : oldPin?.sha256 === smtpIn.pin.sha256 && !smtpIn.pin.pem ? oldPin : smtpIn.pin;
        smtp = { host: smtpIn.host, port: smtpIn.port, security: smtpIn.security, username: smtpIn.username, from: smtpIn.from, password, ...(pin ? { pin } : {}) };
      }

      // What changed. A channel whose address changed counts as removed and added (the old address is told).
      const where = (d: StoredDestination) => JSON.stringify([d.kind, d.audience, d.contact ?? '', d.email ?? '', d.ntfy?.server ?? '', d.ntfy?.topic.c ?? '', d.webhook?.url.c ?? '']);
      const secretsOf = (d: StoredDestination) => JSON.stringify([d.ntfy?.token?.c ?? '', d.webhook?.secret?.c ?? '']);
      const removed: StoredDestination[] = [];
      const updated: { old: StoredDestination; now: StoredDestination }[] = [];
      const kept: { old: StoredDestination; now: StoredDestination }[] = [];
      const added: StoredDestination[] = [];
      for (const old of before) {
        const n = next.find((x) => x.id === old.id);
        if (!n || where(n) !== where(old)) removed.push(old);
        else if (secretsOf(n) !== secretsOf(old)) updated.push({ old, now: n });
        else kept.push({ old, now: n });
      }
      for (const n of next) {
        const old = before.find((b) => b.id === n.id);
        if (!old || where(old) !== where(n)) added.push(n);
      }
      // An address change keeps the id: give the new one its own id, so the old one's history and announcement stay apart.
      for (const a of added)
        if (before.some((b) => b.id === a.id)) {
          const fresh = newId();
          await this.reseal(a, fresh);
        }
      // What changed in the email account (the pin by its fingerprint: the same certificate is no change).
      const smtpParts: string[] = [];
      if (draft.smtp && smtp) {
        const a = draft.smtp;
        if (a.host !== smtp.host || a.port !== smtp.port || a.security !== smtp.security) smtpParts.push('server');
        if (a.username !== smtp.username) smtpParts.push('user name');
        if (a.from !== smtp.from) smtpParts.push('From address');
        if (a.pin?.sha256 !== smtp.pin?.sha256)
          smtpParts.push(!smtp.pin ? 'pinned certificate removed' : `pinned certificate ${a.pin ? 'changed' : 'set'} (SHA-256 ${smtp.pin.sha256.slice(0, 11)}…)`);
        if (a.password.c !== smtp.password.c) smtpParts.push('app password');
      }
      const smtpChanged = !!draft.smtp !== !!smtp || smtpParts.length > 0;
      // While a recovery runs, the one change of the account allowed: a new app password, everything else the same.
      const passwordOnly = smtpParts.length === 1 && smtpParts[0] === 'app password';
      const nameChanged = draft.guardianName !== name;

      const changes: string[] = [];
      if (nameChanged) changes.push(`guardian name changed to ${name}`);
      if (smtpChanged) changes.push(!smtp ? 'email account removed' : !draft.smtp ? `email account set up (${smtp.username}${smtp.pin ? ', with a pinned certificate' : ''})` : `email account changed: ${smtpParts.join(', ')}`);
      for (const d of removed) changes.push(`${messageLabel(d)} removed ${whoLabel(d)}`);
      for (const d of added) changes.push(`${messageLabel(d)} added ${whoLabel(d)}`);
      for (const u of updated) changes.push(`${messageLabel(u.now)} ${whoLabel(u.now)}: ${u.now.kind === 'ntfy' ? 'access token' : 'signing secret'} changed`);
      if (!changes.length) {
        outcome = { ok: true, changed: false };
        return false;
      }
      if (ctx.recoveryRunning && (removed.length || updated.length || (smtpChanged && draft.smtp && !passwordOnly))) {
        outcome = {
          ok: false,
          code: 'recovery_pending',
          message: "A recovery is running: alert channels and the email account can be added to, not removed or changed, until it ends. Only the email account's app password can be changed meanwhile.",
        };
        return false;
      }
      const limit = this.changeLimiter.take('settings', now);
      if (!limit.ok) {
        outcome = { ok: false, code: 'rate_limited', message: 'Too many changes. Wait and try again.', retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000) };
        return false;
      }

      // The announcement, to every channel before (over its old self and the old email account) and after the change.
      const oldSmtp = draft.smtp;
      const at = now;
      const deliveries: Delivery[] = [];
      const push = (dest: StoredDestination, text: string, via?: Delivery['via']) =>
        deliveries.push({ dest: dest.id, msg: finish({ title: TITLES.notifications_changed!, body: text, priority: PRIORITIES.notifications_changed! }, name), attempts: 0, nextAt: at, ...(via ? { via } : {}) });
      const ownerAction = 'If you did not make this change, check your guardian now: someone may know its passphrase.';
      const contactAction = 'If you did not expect this, contact the owner.';
      const list2 = changes.map((c) => `- ${c}`).join('\n');
      for (const d of removed)
        push(
          d,
          `This ${kindWords(d)} will no longer get alerts from ${name}: it was removed from the guardian's alert channels on ${when(at)}, in the guardian's web page.\n\n${d.audience === 'owner' ? `All changes:\n${list2}\n\n${ownerAction}` : contactAction}`,
          { dest: d, ...(d.kind === 'email' && oldSmtp ? { smtp: oldSmtp } : {}) },
        );
      for (const { old, now: d } of [...kept, ...updated])
        push(
          d,
          d.audience === 'owner'
            ? `The alert channels of ${name} were changed in its web page on ${when(at)}:\n${list2}\n\n${ownerAction}`
            : `The owner of ${name} changed where the guardian sends its alerts, on ${when(at)}. This ${kindWords(d)} still gets them.\n\n${contactAction}`,
          { dest: old, ...(d.kind === 'email' && oldSmtp && smtpChanged ? { smtp: oldSmtp } : {}) },
        );
      for (const d of added)
        push(
          d,
          d.audience === 'owner'
            ? `This ${kindWords(d)} now gets the alerts of ${name} (added on ${when(at)}). All changes:\n${list2}\n\n${ownerAction}`
            : [
                `This ${kindWords(d)} now gets alerts from ${name}, the Trikey Guardian of a bitcoin wallet whose owner chose you as an alert contact (added on ${when(at)}).`,
                '',
                'You will hear when someone starts a recovery of the wallet, when its daily limit is turned off, and similar warnings. Messages here are warnings only.',
                d.contact ? 'To cancel a recovery or lock the guardian, use your nostr app, as the guardian\'s nostr messages explain.' : 'If one ever looks wrong, contact the owner.',
                '',
                contactAction,
              ].join('\n'),
        );
      draft.changes += 1;
      const item: OutboxItem = { id: `change-${draft.changes}-${at}`, type: 'notifications_changed', at, deliveries };
      // Pending messages to removed channels go nowhere now (except their announcement, which carries the old channel).
      const gone = new Set(removed.map((d) => d.id));
      for (const it of draft.outbox) for (const d of it.deliveries) if (gone.has(d.dest) && d.sentAt === undefined && !d.via) d.droppedAt = at;
      draft.outbox = [...draft.outbox, item].slice(-MAX_OUTBOX_ITEMS);
      draft.guardianName = name;
      draft.smtp = smtp;
      draft.destinations = next;
      if (smtpChanged) delete draft.health.smtp;
      for (const id of gone) delete draft.health[id];
      for (const u of updated) delete draft.health[u.now.id];
      outcome = { ok: true, changed: true, changes };
      return true;
    });
    if (outcome.ok && outcome.changed) {
      await this.opts.logEvent?.({ type: 'notifications_changed', changes: outcome.changes });
      this.log.warn('notify.settings_changed', { changes: outcome.changes.length });
    }
    return outcome;
  }

  /** Seals `value`, or keeps `old` when it already holds the same value (typing a secret again is no change). */
  private async sealOrKeep(field: string, value: string, old: Sealed | undefined): Promise<Sealed> {
    if (old) {
      try {
        if ((await this.box.open(field, old)) === value) return old;
      } catch {
        /* unreadable: seal anew */
      }
    }
    return this.box.seal(field, value);
  }

  /** Gives a destination whose address changed a new id (its secrets sealed again under it). */
  private async reseal(d: StoredDestination, id: string): Promise<void> {
    const old = d.id;
    if (d.ntfy) {
      d.ntfy.topic = await this.box.seal(`${id}.topic`, await this.box.open(`${old}.topic`, d.ntfy.topic));
      if (d.ntfy.token) d.ntfy.token = await this.box.seal(`${id}.token`, await this.box.open(`${old}.token`, d.ntfy.token));
    }
    if (d.webhook) {
      d.webhook.url = await this.box.seal(`${id}.url`, await this.box.open(`${old}.url`, d.webhook.url));
      if (d.webhook.secret) d.webhook.secret = await this.box.seal(`${id}.secret`, await this.box.open(`${old}.secret`, d.webhook.secret));
    }
    d.id = id;
  }

  // ---------------------------------------------------------------------------
  // Queueing

  /**
   * Queues an alert for every destination it is for (none: nothing happens). Idempotent by `ev.id`; an alert older
   * than the TTL is not queued. A recovery reminder replaces the undelivered older reminders of the same recovery.
   */
  async enqueue(ev: NotifyEvent): Promise<boolean> {
    if (!this.file.destinations.length) return false;
    let queued = false;
    await this.change((draft, now) => {
      if (ev.at <= now - NOTIFY_TTL_MS) return false;
      if (draft.outbox.some((i) => i.id === ev.id) || draft.done.some((d) => d.id === ev.id)) return false;
      const inRules = new Set(this.opts.contacts());
      const title = TITLES[ev.type] ?? 'Alert';
      const priority = PRIORITIES[ev.type] ?? 'default';
      const deliveries: Delivery[] = [];
      for (const d of draft.destinations) {
        let body: string | undefined;
        if (d.audience === 'owner') body = ev.owner;
        else if (ev.contacts) {
          if (d.contact) {
            const ok = ev.contacts.recipients ? ev.contacts.recipients.includes(d.contact) : inRules.has(d.contact);
            if (ok) body = ev.contacts.text('nostr');
          } else body = ev.contacts.text('none');
        }
        if (body === undefined) continue;
        deliveries.push({ dest: d.id, msg: finish({ title, body, priority }, draft.guardianName), attempts: 0, nextAt: now });
      }
      if (!deliveries.length) return false;
      if (ev.type === 'recovery_reminder') {
        const prefix = ev.id.slice(0, ev.id.lastIndexOf('/') + 1);
        for (const it of draft.outbox)
          if (it.type === 'recovery_reminder' && it.id.startsWith(prefix)) for (const d of it.deliveries) if (d.sentAt === undefined) d.droppedAt = now;
      }
      draft.outbox = [...draft.outbox, { id: ev.id, type: ev.type, at: ev.at, ...(ev.walletId ? { walletId: ev.walletId } : {}), deliveries }].slice(-MAX_OUTBOX_ITEMS);
      queued = true;
      return true;
    });
    return queued;
  }

  // ---------------------------------------------------------------------------
  // Delivery

  /** Resolves once a pass in flight (if any) has finished. Starts none. */
  async idle(): Promise<void> {
    await this.running?.catch(() => {});
  }

  /** Runs `run()` in the background (the tick must not wait for a slow mail server). */
  kick(): void {
    void this.run();
  }

  /** Delivers what is due. Overlapping calls coalesce into one more pass. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (e) {
          this.log.error('notify.failed', { error: errorText(e) });
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const now = this.opts.now();
    const events: ServiceEvent[] = [];
    // Work on a snapshot; results are merged back under the lock (settings may change meanwhile).
    const due: { item: OutboxItem; d: Delivery }[] = [];
    for (const item of this.file.outbox)
      for (const d of item.deliveries) if (d.sentAt === undefined && d.droppedAt === undefined && d.nextAt <= now && item.at > now - NOTIFY_TTL_MS) due.push({ item, d });
    const results = new Map<string, { ok: boolean; error?: string; at: number; dropped?: boolean; retryAt?: number; healthKeys: string[] }>();
    let sends = 0;
    for (const { item, d } of due) {
      if (sends >= MAX_SENDS_PER_PASS) break; // the rest at the next pass
      const key = `${item.id}|${d.dest}`;
      const dest = this.file.destinations.find((x) => x.id === d.dest && (!d.via || JSON.stringify(x) === JSON.stringify(d.via.dest))) ?? d.via?.dest;
      if (!dest) {
        results.set(key, { ok: false, at: now, dropped: true, healthKeys: [] });
        continue;
      }
      const limit = this.channelLimiter.take(dest.id, now);
      if (!limit.ok) {
        results.set(key, { ok: false, at: now, retryAt: now + limit.retryAfterMs, healthKeys: [] });
        continue;
      }
      // A change announcement tries the old email account first, the current one on every other attempt.
      const smtp = dest.kind === 'email' ? (d.via?.smtp && (d.attempts % 2 === 0 || !this.file.smtp) ? d.via.smtp : this.file.smtp) : undefined;
      if (dest.kind === 'email') {
        const s = this.smtpLimiter.take('smtp', now);
        if (!s.ok) {
          results.set(key, { ok: false, at: now, retryAt: now + s.retryAfterMs, healthKeys: [] });
          continue;
        }
      }
      sends++;
      const healthKeys = dest.kind === 'email' && smtp === this.file.smtp ? [dest.id, 'smtp'] : [dest.id];
      try {
        await this.deliver(dest, smtp, d.msg, { id: `${item.id}/${dest.id}`, type: item.type, at: item.at, walletId: item.walletId });
        results.set(key, { ok: true, at: this.opts.now(), healthKeys });
      } catch (e) {
        results.set(key, { ok: false, error: errorText(e).slice(0, 200), at: this.opts.now(), healthKeys });
      }
    }

    await this.change((draft) => {
      let dirty = false;
      for (const item of draft.outbox)
        for (const d of item.deliveries) {
          const r = results.get(`${item.id}|${d.dest}`);
          if (!r || d.sentAt !== undefined || d.droppedAt !== undefined) continue;
          dirty = true;
          if (r.dropped) {
            d.droppedAt = r.at;
            continue;
          }
          if (r.retryAt !== undefined && r.error === undefined && !r.ok) {
            d.nextAt = r.retryAt;
            continue;
          }
          const dest = draft.destinations.find((x) => x.id === d.dest) ?? d.via?.dest;
          if (r.ok) {
            d.sentAt = r.at;
            delete d.lastError;
          } else {
            d.attempts += 1;
            d.lastError = r.error;
            d.nextAt = r.at + RETRY_DELAYS_MS[Math.min(d.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
          }
          for (const k of r.healthKeys) {
            // A removed channel's last message (its announcement) leaves no health record behind.
            if (k !== 'smtp' && !draft.destinations.some((x) => x.id === k)) continue;
            const was = healthState(draft.health[k]);
            const h = (draft.health[k] ??= {});
            if (r.ok) h.lastOkAt = r.at;
            else {
              h.lastErrorAt = r.at;
              h.lastError = r.error;
            }
            h.failing = !r.ok;
            const is = healthState(h);
            const label = k === 'smtp' ? `email account ${draft.smtp?.username ?? ''}`.trim() : dest ? this.describe(dest) : k;
            if (is === 'failing' && was !== 'failing') events.push({ type: 'notification_failing', channel: label, error: r.error ?? 'failed' });
            if (is === 'ok' && was === 'failing') events.push({ type: 'notification_ok', channel: label });
          }
        }
      // Done items (every delivery sent or dropped) and expired ones leave the outbox; their ids are remembered.
      const keep: OutboxItem[] = [];
      for (const item of draft.outbox) {
        const open = item.deliveries.filter((d) => d.sentAt === undefined && d.droppedAt === undefined);
        const expired = item.at <= now - NOTIFY_TTL_MS;
        if (open.length && !expired) {
          keep.push(item);
          continue;
        }
        dirty = true;
        for (const d of open) {
          const dest = draft.destinations.find((x) => x.id === d.dest) ?? d.via?.dest;
          events.push({ type: 'notification_expired', channel: dest ? this.describe(dest) : d.dest, alert: item.type, ...(d.lastError ? { error: d.lastError } : {}) });
        }
        draft.done.push({ id: item.id, at: now });
      }
      draft.outbox = keep;
      const before = draft.done.length;
      draft.done = draft.done.filter((x) => x.at > now - DONE_KEEP_MS).slice(-2000);
      return dirty || before !== draft.done.length;
    });
    for (const e of events) await this.opts.logEvent?.(e);
    for (const e of events) if (e.type === 'notification_failing') this.log.warn('notify.channel_failing', { error: e.error });
  }

  /** Sends one message to one destination (secrets opened just for this send). */
  private async deliver(dest: StoredDestination, smtp: StoredSmtp | undefined, msg: Message, meta: { id: string; type: string; at: number; walletId?: string }): Promise<void> {
    if (dest.kind === 'email') {
      if (!smtp) throw new Error('No email account is set up.');
      const password = await this.box.open('smtp.password', smtp.password);
      const account: SmtpAccount = { host: smtp.host, port: smtp.port, security: smtp.security, username: smtp.username, from: smtp.from, password, ...(smtp.pin ? { pin: smtp.pin } : {}) };
      await sendEmail(account, dest.email!, msg, { guardianName: this.file.guardianName, type: meta.type }, this.opts.smtpTest);
      return;
    }
    if (dest.kind === 'ntfy') {
      const n = dest.ntfy!;
      const topic = await this.box.open(`${dest.id}.topic`, n.topic);
      const token = n.token ? await this.box.open(`${dest.id}.token`, n.token) : undefined;
      checkHttpUrl(n.server, this.opts.net);
      await sendNtfy({ server: n.server, topic, ...(token ? { token } : {}) }, msg, { type: meta.type }, this.opts.net);
      return;
    }
    const w = dest.webhook!;
    const url = await this.box.open(`${dest.id}.url`, w.url);
    const secret = w.secret ? await this.box.open(`${dest.id}.secret`, w.secret) : undefined;
    checkHttpUrl(url, this.opts.net);
    const payload: WebhookPayload = {
      version: 1,
      id: meta.id,
      type: meta.type,
      guardian: this.file.guardianName,
      ...(meta.walletId ? { wallet: meta.walletId.slice(0, 8) } : {}),
      time: new Date(meta.at).toISOString(),
      title: msg.title,
      message: msg.body,
      priority: msg.priority,
    };
    await sendWebhook({ url, ...(secret ? { secret } : {}) }, payload, this.opts.now(), this.opts.net);
  }

  // ---------------------------------------------------------------------------
  // Test messages

  /** "Send a test message": one channel (`destination`), or the email account to its own From address (`smtp`). */
  async test(input: unknown): Promise<TestOutcome> {
    const r = (input ?? {}) as { destination?: unknown; smtp?: unknown };
    const now = this.opts.now();
    let dest: StoredDestination | undefined;
    if (r.smtp === true) {
      if (!this.file.smtp) return { ok: false, code: 'not_found', message: 'No email account is set up.' };
      dest = { id: 'smtp', audience: 'owner', kind: 'email', email: this.file.smtp.from, createdAt: now };
    } else {
      dest = this.file.destinations.find((d) => d.id === r.destination);
      if (!dest) return { ok: false, code: 'not_found', message: 'No such channel (it may have been removed).' };
    }
    const limit = this.testLimiter.take('test', now);
    if (!limit.ok) return { ok: false, code: 'rate_limited', message: 'Too many test messages. Wait a few minutes.', retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000) };
    const name = this.file.guardianName;
    const body = [
      `This is a test message from ${name}, sent on ${when(now)} from its web page.`,
      '',
      dest.audience === 'owner'
        ? 'If you can read this, alerts will reach you here.'
        : 'The owner of this Trikey Guardian chose you as an alert contact. If you can read this, its alerts will reach you here. Nothing else is needed.',
    ].join('\n');
    const msg = finish({ title: TITLES.test!, body, priority: 'low' }, name);
    const keys = dest.id === 'smtp' ? ['smtp'] : dest.kind === 'email' ? [dest.id, 'smtp'] : [dest.id];
    let error: string | undefined;
    try {
      await this.deliver(dest, this.file.smtp, msg, { id: `test-${now}/${dest.id}`, type: 'test', at: now });
    } catch (e) {
      error = errorText(e).slice(0, 200);
    }
    const at = this.opts.now();
    await this.change((draft) => {
      for (const k of keys) {
        if (k !== 'smtp' && !draft.destinations.some((d) => d.id === k)) continue;
        const h = (draft.health[k] ??= {});
        if (error === undefined) h.lastOkAt = at;
        else {
          h.lastErrorAt = at;
          h.lastError = error;
        }
        h.failing = error !== undefined;
      }
      return true;
    });
    const label = dest.id === 'smtp' ? `email account ${this.file.smtp?.username ?? ''}` : this.describe(dest);
    await this.opts.logEvent?.({ type: 'notification_test', channel: label, ok: error === undefined, ...(error ? { error } : {}) });
    const health = this.healthView(keys[0]!);
    return error === undefined ? { ok: true, health } : { ok: false, code: 'failed', message: error, health };
  }
}

export { isSealed, type Sealed };
