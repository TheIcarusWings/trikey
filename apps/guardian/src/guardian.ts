/**
 * The Trikey Guardian service: holds key 3 and wires the policy engine to the
 * world (HTTP for the local web UI, nostr for the phone and alert contacts,
 * Electrs for the chain).
 *
 * Lifecycle: `Guardian.open()` loads everything from the data directory;
 * `start()` starts the HTTP server, the chain client and (once set up) nostr;
 * after any start the guardian is LOCKED: key 3 is only decrypted by an unlock
 * (web UI or `guardian.unlock`) and only kept in memory, inside the engine's
 * signer, until `lock()` or `stop()`.
 *
 * Data directory (all files mode 0600, written atomically):
 *   keystore.json        key 3, encrypted (keystore.ts)
 *   nostr-identity.json  the guardian's nostr key, unencrypted (identity.ts)
 *   guardian-state.json  the policy engine's state
 *   service.json         relays (and those still watched after a change), paired
 *                        phone, co-signed sweeps, service log
 *   unlock-throttle.json unlock rate limit
 *   silent-payments.json, silent-payments-key.json
 *                        the silent payment scanner (silent/service.ts): its
 *                        registration, matches, and the key its scan key is
 *                        encrypted under (so it scans while locked)
 *   notifications.json, notifications-key.json
 *                        extra alert channels (notify/notifier.ts): email,
 *                        ntfy and webhook settings, their delivery outbox, and
 *                        the key their secrets are sealed under (so alerts go
 *                        out while locked)
 */
import { join } from 'node:path';
import type { Server } from 'node:http';
import { hex } from '@scure/base';
import type { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import { GUARDIAN_FEATURES, RpcServer, SimplePoolRelayPool, checkRelayList, checkRelayUrl, createSimplePool, sameRelays, type Alert, type MethodName } from '@trikey/protocol';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import { ChainService } from './chain/chain.js';
import { BitcoinRpc } from './chain/bitcoind.js';
import { ElectrumClient, type ElectrumClientOptions } from './chain/electrum.js';
import type { GuardianConfig } from './config.js';
import { ensureDataDir, Mutex } from './files.js';
import { loadOrCreateIdentity, loadIdentity, type GuardianIdentity } from './identity.js';
import {
  BadPassphraseError,
  GuardianSeed,
  MAX_PASSPHRASE_LENGTH,
  SETUP_ENTROPY_BYTES,
  checkPassphrase,
  generateSeed,
  key3Context,
  key3Mix,
  readKeystore,
  replaceKeystore,
  sealKeystore,
  unlockKeystoreSeed,
  writeKeystore,
  type CosignerPublic,
  type Key3Mix,
  type KeystoreFile,
  type KeystoreSigner,
} from './keystore.js';
import { errorText, silentLogger, type Logger } from './log.js';
import { ObservedStore } from './observed-store.js';
import { PairingSessions } from './pairing.js';
import { DAY, JsonFileStore, PolicyEngine, systemClock, type Clock, type RecoveryRecord, type StateStore } from './policy/index.js';
import { ServiceState, type RetiringRelay, type ServiceEvent } from './service-state.js';
import { UnlockThrottle, type ThrottleOptions } from './unlock-throttle.js';
import { DirectMessages } from './nostr/dm.js';
import { Inbox } from './nostr/inbox.js';
import { buildHandlers } from './nostr/handlers.js';
import { stampOf, toSeconds } from './nostr/wire.js';
import { DEFAULT_BROADCAST_LIMIT, DEFAULT_CONTACT_LOCK_LIMIT, DEFAULT_REFUSAL_LIMIT, SlidingWindowLimiter, type RateLimitOptions } from './rate-limit.js';
import { Alerter } from './alerts.js';
import { RecoveryRunner } from './recovery-runner.js';
import { onContactDm } from './dm-cancel.js';
import { startHttpServer } from './http/server.js';
import { buildRoutes } from './http/api.js';
import { WebSessions } from './http/sessions.js';
import { GUARDIAN_VERSION } from './version.js';
import { SilentPaymentService } from './silent/service.js';
import { SavingsMonitor } from './savings.js';
import { Notifier, type NotifyEvent, type TestOutcome, type UpdateOutcome } from './notify/notifier.js';
import type { NetPolicy } from './notify/net.js';
import type { SmtpTestOptions } from './notify/channels.js';

export const FILES = {
  keystore: 'keystore.json',
  identity: 'nostr-identity.json',
  engine: 'guardian-state.json',
  service: 'service.json',
  throttle: 'unlock-throttle.json',
  phoneThrottle: 'unlock-throttle-phone.json',
  resetThrottle: 'reset-throttle.json',
  sessionThrottle: 'session-throttle.json',
} as const;

/** After this many failed `guardian.unlock` passphrases in a row, the phone may not unlock until the web UI does. */
export const PHONE_UNLOCK_MAX_FAILURES = 5;

export interface GuardianOptions {
  config: GuardianConfig;
  /** Time source for the engine and the service (ms). Tests inject a ManualClock. */
  clock?: Clock;
  log?: Logger;
  throttle?: ThrottleOptions;
  /** How often the background tick runs (alerts, recovery completion, broadcasts). 0 = never (tests call `tick()`). */
  tickIntervalMs?: number;
  electrum?: Partial<ElectrumClientOptions>;
  /** Replace the engine's file store (tests). */
  store?: StateStore;
  /** Look up alert contacts' NIP-17 DM relays (kind 10050). Default true. */
  discoverDmRelays?: boolean;
  /** `tx.broadcast` calls allowed per paired phone per window. Default 20 per 10 minutes. */
  broadcastLimit?: RateLimitOptions;
  /** Refused `sign` / `recovery.start` / `recovery.update` allowed per sender per window. Default 30 per 10 minutes. */
  refusalLimit?: RateLimitOptions;
  /** `LOCK` DMs handled per alert contact per window (dm-lock.ts). Default 5 per hour. */
  contactLockLimit?: RateLimitOptions;
  /** How often the watched Savings wallet is scanned when no block came (savings.ts). Default 2 minutes. */
  savingsScanIntervalMs?: number;
  /** Test seams for the extra alert channels (notify/): local test servers on 127.0.0.1, a self-signed SMTP server. */
  notify?: { net?: NetPolicy; smtpTest?: SmtpTestOptions };
}

/** What a `LOCK` DM from an alert contact did (`Guardian.lockByContact`). */
export type ContactLockOutcome = 'locked' | 'already_locked' | 'not_allowed';

export type UnlockOutcome =
  | { ok: true }
  | { ok: false; code: 'bad_passphrase' | 'rate_limited'; retryAfterSeconds?: number }
  /**
   * `phone_unlock_disabled`: too many failed phone attempts in a row, until the web UI unlocks;
   * `recovery_pending`: the phone may not unlock while a recovery it did not start is running.
   */
  | { ok: false; code: 'setup_required' | 'invalid' | 'phone_unlock_disabled' | 'recovery_pending'; message: string };

export type SetupOutcome = { ok: true } | { ok: false; code: 'invalid' | 'already_setup'; message: string };

export type RelayChangeOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: 'invalid' | 'setup_required' | 'retiring_full'; message: string };

export type StopWatchingOutcome = { ok: true; dropped: string[] } | { ok: false; code: 'setup_required' | 'invalid' | 'not_found'; message: string };

/**
 * At most this many old ("retiring") relays are watched. Old relays are watched until the owner stops them
 * (DESIGN.md, "Changing relays"), so this only bounds how many an owner can pile up, and nothing is dropped
 * to stay under it: a change that would exceed it is refused (`retiring_full`) until the owner stops watching
 * some. Dropping the oldest automatically would silently break exactly the oldest printed recovery sheets, which
 * are the ones that must keep working.
 */
export const MAX_RETIRING_RELAYS = 16;

/** The relay list of a setup or a relay change: 1 to 8 entries, normalised, duplicates dropped (protocol `checkRelayList`). */
export function parseRelayList(input: unknown): { ok: true; relays: string[] } | { ok: false; message: string } {
  const r = checkRelayList(input);
  return 'error' in r ? { ok: false, message: r.error } : { ok: true, relays: r.relays };
}

export type ResetOutcome =
  | { ok: true; forgotten: string[] }
  | { ok: false; code: 'bad_passphrase' | 'rate_limited'; retryAfterSeconds?: number }
  | { ok: false; code: 'setup_required' | 'invalid' | 'recovery_pending' | 'sweep_pending'; message: string };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * What a phone admitted by `recovery.access` may call: read the wallet and its chain data, start,
 * follow and (with a hardware approval) cancel a recovery. Not `sign`, rule changes, `tx.broadcast`,
 * `phone.resume` or `guardian.unlock`: those stay with the paired phone.
 */
export const RECOVERY_PEER_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'guardian.status',
  'wallet.sync',
  'tx.get',
  'fees.estimate',
  'recovery.access',
  'recovery.start',
  'recovery.update',
  'recovery.status',
  'recovery.cancel',
]);
/** What the web UI's reset must be confirmed with, typed exactly. */
export const RESET_CONFIRMATION = 'RESET GUARDIAN';

/**
 * `entropy` of the web UI's setup and reset requests: optional, but exactly 32 bytes as 64 lowercase hex
 * characters when present (keystore.ts `trikey/guardian-seed/v1`). `undefined` when absent, `false` when
 * malformed. The caller zeroes the bytes.
 */
export function parseBrowserEntropy(v: unknown): Uint8Array | undefined | false {
  if (v === undefined) return undefined;
  if (!browserEntropyOk(v)) return false;
  return hex.decode(v as string);
}

const ENTROPY_HEX = new RegExp(`^[0-9a-f]{${SETUP_ENTROPY_BYTES * 2}}$`);

/** True when `entropy` is absent or well formed: the check before anything changes, without decoding it. */
function browserEntropyOk(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && ENTROPY_HEX.test(v));
}

const BAD_ENTROPY = `entropy must be ${SETUP_ENTROPY_BYTES} random bytes as ${SETUP_ENTROPY_BYTES * 2} lowercase hex characters.`;

/** The running (pending or ready) recovery of wallet `walletId` (the active one) in the engine's state, if any. */
export function activeRecovery(recoveries: readonly RecoveryRecord[] | undefined, walletId: string | undefined): RecoveryRecord | undefined {
  if (!recoveries || !walletId) return undefined;
  for (let i = recoveries.length - 1; i >= 0; i--) {
    const r = recoveries[i];
    if (r.walletId === walletId) return r.status === 'pending' || r.status === 'ready' ? r : undefined;
  }
  return undefined;
}

export class Guardian {
  readonly config: GuardianConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly chain: ChainService;
  readonly pairing = new PairingSessions();
  readonly alerts: Alerter;
  readonly recovery: RecoveryRunner;
  /** Per paired phone: each `tx.broadcast` may scan wallets on Electrs. */
  readonly broadcastLimiter: SlidingWindowLimiter;
  /** Per sender: refused `sign` / `recovery.start` / `recovery.update` (a flood is stopped before the engine). */
  readonly refusalLimiter: SlidingWindowLimiter;
  /** Per alert contact: `LOCK` DMs (dm-lock.ts), whatever they lead to. */
  readonly contactLockLimiter: SlidingWindowLimiter;
  /** The silent payment scanner (needs the node RPC; works while locked). */
  readonly sp: SilentPaymentService;
  /** Watches the phone's Savings wallet, if it registered one: chain data and the `savings_moved` tripwire (savings.ts). */
  readonly savingsWatch: SavingsMonitor;
  /** Email, ntfy and webhook alerts (notify/notifier.ts): owner-side settings from the web UI; works while locked. */
  readonly notifier: Notifier;

  engine!: PolicyEngine;
  store!: ObservedStore;
  service!: ServiceState;
  /**
   * Passphrase attempts, each with its own throttle so one cannot starve another: the web UI's unlock
   * (and setup), the phone's `guardian.unlock`, and the web UI's reset. A stolen phone guessing away
   * never delays the owner at the box.
   */
  throttle!: UnlockThrottle;
  phoneThrottle!: UnlockThrottle;
  resetThrottle!: UnlockThrottle;
  /** Web sign-ins (`POST /api/session`), throttled on their own. */
  sessionThrottle!: UnlockThrottle;
  /** The web UI's sessions (http/sessions.ts). In memory: a restart signs everyone out. */
  readonly sessions = new WebSessions();
  keystore?: KeystoreFile;
  identity?: GuardianIdentity;
  rpc?: RpcServer;
  dm?: DirectMessages;
  inbox?: Inbox;

  /** When and why the guardian last locked (undefined while unlocked). */
  lockedAt?: number = undefined;
  lockReason?: 'restart' | 'manual' | 'remote' | 'contact' = undefined;
  /** `lockReason: 'contact'`: the alert contact who locked it (nostr pubkey). In memory: a restart says `restart`. */
  lockedBy?: string = undefined;

  private signer?: KeystoreSigner;
  /** The setup seed while unlocked: every wallet's key 3 is derived from it (keystore.ts). Wiped on lock. */
  private seed?: GuardianSeed;
  private simplePool?: SimplePool;
  private pool?: SimplePoolRelayPool;
  private http?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private tickAgain = false;
  private stopped = false;
  private readonly unlockMutex = new Mutex();
  private readonly setupMutex = new Mutex();
  readonly pairMutex = new Mutex();
  /**
   * Serializes start / cancel / complete of recoveries. The engine's cancel acts
   * on whichever recovery is running, so "is this the recovery the request
   * names?" and the cancel itself must not interleave with a new start.
   */
  readonly recoveryMutex = new Mutex();
  private readonly opts: GuardianOptions;

  private constructor(opts: GuardianOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? silentLogger;
    const electrum = opts.config.electrum
      ? new ElectrumClient({ ...opts.config.electrum, log: this.log, ...opts.electrum })
      : undefined;
    const rpc = opts.config.bitcoinRpc ? new BitcoinRpc(opts.config.bitcoinRpc) : undefined;
    this.chain = new ChainService({ electrum, rpc, log: this.log });
    this.sp = new SilentPaymentService({
      dataDir: opts.config.dataDir,
      rpc,
      clock: this.clock,
      log: this.log,
      pairedPhone: () => this.engine?.registration()?.appNostrPubkey,
      notify: (alert) => this.notifyPhone(alert),
      stamp: () => this.stampNow(),
      scanThreads: opts.config.spScanThreads,
    });
    this.alerts = new Alerter(this);
    this.recovery = new RecoveryRunner(this);
    this.savingsWatch = new SavingsMonitor(this, opts.savingsScanIntervalMs);
    this.notifier = new Notifier({
      dataDir: opts.config.dataDir,
      now: () => this.clock.now(),
      log: this.log,
      logEvent: (e) => this.logEvent(e),
      contacts: () => this.engine?.status().rules?.alertContacts ?? [],
      net: opts.notify?.net,
      smtpTest: opts.notify?.smtpTest,
    });
    this.broadcastLimiter = new SlidingWindowLimiter(opts.broadcastLimit ?? DEFAULT_BROADCAST_LIMIT);
    this.refusalLimiter = new SlidingWindowLimiter(opts.refusalLimit ?? DEFAULT_REFUSAL_LIMIT);
    this.contactLockLimiter = new SlidingWindowLimiter(opts.contactLockLimit ?? DEFAULT_CONTACT_LOCK_LIMIT);
  }

  private path(name: keyof typeof FILES): string {
    return join(this.config.dataDir, FILES[name]);
  }

  /** Loads all state from the data directory. Refuses to run on the wrong network. */
  static async open(opts: GuardianOptions): Promise<Guardian> {
    // No key is made or unlocked from a random source or a crypto library that fails its start-up tests.
    assertRandomSourceHealthy('guardian start');
    const g = new Guardian(opts);
    await ensureDataDir(g.config.dataDir);
    g.keystore = await readKeystore(g.path('keystore'));
    g.identity = await loadIdentity(g.path('identity'));
    g.service = new ServiceState(g.path('service'));
    await g.service.load();
    g.throttle = new UnlockThrottle(g.path('throttle'), g.clock, opts.throttle);
    await g.throttle.load();
    g.phoneThrottle = new UnlockThrottle(g.path('phoneThrottle'), g.clock, opts.throttle);
    await g.phoneThrottle.load();
    g.resetThrottle = new UnlockThrottle(g.path('resetThrottle'), g.clock, opts.throttle);
    await g.resetThrottle.load();
    g.sessionThrottle = new UnlockThrottle(g.path('sessionThrottle'), g.clock, opts.throttle);
    await g.sessionThrottle.load();
    g.store = new ObservedStore(opts.store ?? new JsonFileStore(g.path('engine')));
    // The engine checks its clock against the chain (recovery delay, daily limit window): Electrs' tip.
    const chainTime = {
      tip: async () => {
        const t = await g.chain.tip();
        return { height: t.height, medianTimePastMs: t.medianTimePast * 1000 };
      },
    };
    g.engine = await PolicyEngine.open({ store: g.store, clock: g.clock, chain: chainTime });
    const net = g.config.network;
    if (g.keystore && g.keystore.public.network !== net)
      throw new ConfigError(`key 3 was created for ${g.keystore.public.network}, but BITCOIN_NETWORK is ${net}`);
    const reg = g.engine.registration();
    if (reg && reg.network !== net) throw new ConfigError(`the paired wallet is on ${reg.network}, but BITCOIN_NETWORK is ${net}`);
    // A key 3 mixed with the phone's contribution can only be checked once unlocked (`unlock` does).
    if (reg && g.keystore && !reg.key3Mix && reg.cosignerAccountPubkey !== g.keystore.public.accountPubkey)
      throw new ConfigError('the paired wallet does not use this guardian key');
    // Recovery access grants moved from service.json into the engine (per wallet, so a rotation revokes them).
    const legacy = g.service.get().recoveryPeers;
    if (legacy.length) {
      await g.engine.importAccessGrants(legacy);
      await g.service.update((d) => {
        d.recoveryPeers = [];
      });
    }
    await g.sp.load();
    await g.notifier.load();
    g.lockedAt = g.clock.now();
    g.lockReason = 'restart';
    return g;
  }

  get setupComplete(): boolean {
    return !!this.keystore;
  }

  get locked(): boolean {
    return this.engine.locked;
  }

  get version(): string {
    return GUARDIAN_VERSION;
  }

  /**
   * What `guardian.status.features` (and `pair.prepare`) report (`GUARDIAN_FEATURES`): the phone offers "no daily limit"
   * only when it lists `limit_off`, "alert contacts can lock the guardian" only when it lists `contact_lock`, and Savings
   * only when it lists `savings` (the guardian serves Savings' chain data). Tests clear it to see how a phone treats a
   * guardian from before a feature.
   */
  features: string[] = [GUARDIAN_FEATURES.limitOff, GUARDIAN_FEATURES.contactLock, GUARDIAN_FEATURES.savings, GUARDIAN_FEATURES.notifications];

  nowSec(): number {
    return toSeconds(this.clock.now());
  }

  /** `at` (seconds) and `atMs` (milliseconds) for an alert or a status answer raised now. */
  stampNow(): { at: number; atMs: number } {
    return stampOf(this.clock.now());
  }

  /** Engine state as last saved (read-only). */
  get records(): readonly RecoveryRecord[] {
    return this.store.state?.recoveries ?? [];
  }

  activeRecord(): RecoveryRecord | undefined {
    return activeRecovery(this.records, this.engine.registration()?.walletId);
  }

  async logEvent(event: ServiceEvent): Promise<void> {
    try {
      await this.service.log(this.clock.now(), event);
    } catch (e) {
      this.log.error('service_log.write_failed', { error: errorText(e) });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Starts HTTP (if `listen`), the chain client and, once set up, nostr. */
  async start(listen: { port?: number; host?: string } | false = {}): Promise<void> {
    this.log.info('guardian.starting', {
      version: GUARDIAN_VERSION,
      network: this.config.network,
      setup: this.setupComplete,
      paired: !!this.engine.registration(),
    });
    if (listen !== false) {
      this.http = await startHttpServer({
        port: listen.port ?? this.config.port,
        host: listen.host ?? this.config.host,
        webDir: this.config.webDir,
        routes: buildRoutes(this),
        log: this.log,
        sessions: this.sessions,
        now: () => this.clock.now(),
      });
    }
    this.chain.start();
    this.chain.onTip(() => void this.tick());
    if (this.setupComplete) {
      await this.startNostr();
      await this.notifyPhone({ type: 'guardian_locked', reason: 'restart', ...this.stampNow() });
      this.notifyOwner('guardian_locked', 'Your guardian restarted and is locked: it co-signs nothing until you unlock it. Recoveries, their timers and their alerts go on.');
    }
    await this.logEvent({ type: 'started' });
    // Silent payments are scanned whether or not key 3 is unlocked.
    this.sp.kick();
    const every = this.opts.tickIntervalMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref?.();
    }
    this.log.info('guardian.started', { locked: this.locked });
  }

  get httpAddress(): { port: number; host: string } | undefined {
    const a = this.http?.address();
    return a && typeof a === 'object' ? { port: a.port, host: a.address } : undefined;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.ticking?.catch(() => {});
    await this.sp.stop();
    // A send in flight may finish (its outcome is saved); a slow mail server does not hold the stop up for long.
    await Promise.race([this.notifier.idle(), new Promise<void>((r) => setTimeout(r, 5000).unref?.())]);
    this.inbox?.close();
    await this.inbox?.drain();
    this.rpc?.close();
    this.dm?.close();
    this.pool?.close();
    this.chain.stop();
    if (this.http) {
      const http = this.http;
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections?.();
      });
    }
    this.dropSigner();
    this.log.info('guardian.stopped');
  }

  private async startNostr(): Promise<void> {
    if (this.rpc) return;
    if (!this.identity) {
      // Not re-created on purpose: a new key would silently cut the paired phone off.
      this.log.error('nostr.identity_missing', { file: FILES.identity });
      return;
    }
    const relays = this.watchedRelays();
    if (!relays.length) {
      this.log.error('nostr.no_relays');
      return;
    }
    this.simplePool = createSimplePool({ enableReconnect: true, enablePing: true });
    this.pool = new SimplePoolRelayPool({ pool: this.simplePool });
    this.rpc = new RpcServer({
      pool: this.pool,
      relays,
      secretKey: this.identity.secretKey,
      handlers: buildHandlers(this),
      authorize: (sender, method) => this.authorize(sender, method),
      // Strangers (anyone who is not one of these) get their own small replay cache (protocol server.ts).
      isPeer: (sender) => this.isKnownSender(sender),
      listen: false, // the inbox below opens every wrap once and hands RPC rumors over
      now: () => this.nowSec(),
      onDrop: (d) => {
        if (d.reason !== 'decrypt_failed' && d.reason !== 'bad_rumor') this.log.debug('rpc.dropped', { reason: d.reason });
      },
      onError: (e, info) => this.log.error('rpc.handler_error', { method: info.method, error: errorText(e) }),
    });
    const reg = this.engine.registration();
    if (reg) this.rpc.addPeer(reg.appNostrPubkey);
    this.dm = new DirectMessages({
      pool: this.pool,
      relays,
      identity: this.identity,
      now: () => this.nowSec(),
      log: this.log,
      discoverRelays: this.opts.discoverDmRelays,
      onMessage: (dm) => onContactDm(this, dm),
      listen: false,
    });
    const rpc = this.rpc;
    const dm = this.dm;
    this.inbox = new Inbox({
      pool: this.pool,
      relays,
      secretKey: this.identity.secretKey,
      pubkey: this.identity.pubkey,
      now: () => this.nowSec(),
      onRpc: (opened) => rpc.handleOpened(opened),
      onDm: (opened) => dm.handleOpened(opened),
      log: this.log,
      isPeer: (sender) => this.isKnownSender(sender),
    });
    await this.inbox.start();
    this.log.info('nostr.listening', { npub: this.identity.npub, relays: relays.length });
  }

  /**
   * Who may call what over nostr:
   * - the paired phone: every method;
   * - a phone the hardware wallet let in with `recovery.access` (lost phone, no backup), until the
   *   access expires: the chain and recovery methods in `RECOVERY_PEER_METHODS`;
   * - registered alert contacts (and the running recovery's recipients): `recovery.cancel` only;
   * - anyone else, once a wallet is paired: `recovery.access` (which checks a hardware signature);
   * - anyone else: `pair.prepare` / `pair`, and only around a pairing session made in the web UI.
   * Everything else is dropped without an answer.
   */
  authorize(sender: string, method: MethodName): boolean {
    const reg = this.engine.registration();
    if (reg && sender === reg.appNostrPubkey) return true;
    if (reg && RECOVERY_PEER_METHODS.has(method) && this.hasRecoveryAccess(sender)) return true;
    if (method === 'recovery.cancel') return this.isAlertContact(sender);
    if (method === 'recovery.access') return !!reg;
    if (method === 'pair.prepare' || method === 'pair') return this.pairing.answering(this.clock.now());
    return false;
  }

  /** The paired phone, an alert contact (or a running recovery's recipient), or a phone with recovery access: not a stranger. */
  isKnownSender(sender: string): boolean {
    const reg = this.engine.registration();
    return (!!reg && sender === reg.appNostrPubkey) || this.isAlertContact(sender) || this.hasRecoveryAccess(sender);
  }

  /** Phones holding an unexpired `recovery.access` grant for the active wallet. */
  recoveryPeers(): string[] {
    return this.engine.recoveryPeers();
  }

  /** True while `pubkey` holds an unexpired `recovery.access` grant for the active wallet. */
  hasRecoveryAccess(pubkey: string): boolean {
    return this.engine.hasRecoveryAccess(pubkey);
  }

  /**
   * Where every scan of the active wallet must reach (a scan's `minIndex`): its high-water marks, the
   * highest index seen used or co-signed per chain, so no coin key 3 co-signed as change is out of sight.
   */
  scanFloor(walletId: string): Partial<Record<0 | 1, number>> {
    const hw = this.engine.highWater(walletId);
    return { 0: hw.receive, 1: hw.change };
  }

  /** Raises the active wallet's marks to what a scan found used (incoming payments to fresh addresses). */
  async noteScan(walletId: string, scan: { nextReceiveIndex: number; nextChangeIndex: number }): Promise<void> {
    try {
      await this.engine.noteUsedIndexes(walletId, { receive: scan.nextReceiveIndex - 1, change: scan.nextChangeIndex - 1 });
    } catch (e) {
      this.log.error('wallet.high_water_failed', { error: errorText(e) });
    }
  }

  isAlertContact(pubkey: string): boolean {
    const rules = this.engine.status().rules;
    if (rules?.alertContacts.includes(pubkey)) return true;
    return !!this.activeRecord()?.recipients.includes(pubkey);
  }

  /** Relay URLs and whether the pool currently holds an open connection to each. */
  relayStatus(): { url: string; connected: boolean }[] {
    return this.service.get().relays.map((url) => ({ url, connected: this.relayConnected(url) }));
  }

  /** Relays a change removed that are still watched, newest change first, with whether each is connected. */
  retiringRelayStatus(): (RetiringRelay & { connected: boolean })[] {
    return [...this.service.get().retiringRelays]
      .sort((a, b) => b.since - a.since)
      .map((r) => ({ ...r, connected: this.relayConnected(r.url) }));
  }

  private relayConnected(url: string): boolean {
    return !!this.simplePool?.listConnectionStatus().get(normalizeURL(url));
  }

  /**
   * Every relay the guardian listens and publishes on: the current ones, then those a change removed that the owner
   * has not stopped watching. Publishing on the old ones too is what keeps a phone that has not switched (an older
   * app, one that was offline, one restored from an older backup, or a new phone recovering from an older
   * recovery code) working: it listens only there, so answers sent only to the new relays would never reach it.
   */
  watchedRelays(): string[] {
    const d = this.service.get();
    return [...new Set([...d.relays, ...d.retiringRelays.map((r) => r.url)])];
  }

  /** Points the RPC server, the DM handler and the inbox at `watchedRelays()` (after a change or when the owner stops watching old relays). */
  private applyRelays(): void {
    const relays = this.watchedRelays();
    if (!relays.length) return;
    this.rpc?.setRelays(relays);
    this.dm?.setRelays(relays);
    this.inbox?.setRelays(relays);
  }

  private readonly relaysMutex = new Mutex();

  /**
   * The web UI's relay change (`PUT /api/relays`), with the setup's rules (1 to 8, `wss://` or `ws://` on a local
   * host, normalised, duplicates dropped). The guardian listens and publishes on the new relays at once, keeps the
   * removed ones until the owner stops watching them (`retiringRelays`, `stopWatchingRelays`), tells the paired
   * phone (`relays_changed`, over old and new relays) and logs a security event. Pairing and recovery codes carry
   * the new list from now on. Refused (`retiring_full`) when it would leave more than `MAX_RETIRING_RELAYS` old
   * relays: nothing is dropped behind the owner's back.
   */
  changeRelays(input: unknown): Promise<RelayChangeOutcome> {
    return this.relaysMutex.run(async (): Promise<RelayChangeOutcome> => {
      if (!this.setupComplete) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      const parsed = parseRelayList(input);
      if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.message };
      const next = parsed.relays;
      const now = this.clock.now();
      const before = this.service.get();
      if (sameRelays(before.relays, next)) {
        if (before.relays.join() !== next.join()) await this.service.update((d) => void (d.relays = next)); // only the order changed
        return { ok: true, changed: false };
      }
      // A relay that comes back into the list is no longer old; one removed again keeps its original `since`.
      const kept = before.retiringRelays.filter((r) => !next.includes(r.url));
      const removed = before.relays.filter((url) => !next.includes(url) && !kept.some((r) => r.url === url));
      if (kept.length + removed.length > MAX_RETIRING_RELAYS) {
        this.log.warn('relays.change_refused', { retiring: kept.length, removing: removed.length, max: MAX_RETIRING_RELAYS });
        return {
          ok: false,
          code: 'retiring_full',
          message: `This change would leave ${kept.length + removed.length} old relays watched, and ${MAX_RETIRING_RELAYS} is the most. Stop watching some old relays first: nothing is dropped without you saying so, so recovery sheets and backups that only know them keep working.`,
        };
      }
      await this.service.update((d) => {
        d.retiringRelays = [...kept, ...removed.map((url) => ({ url, since: now }))];
        d.relays = next;
        d.relaysChange = { at: now };
      });
      await this.logEvent({ type: 'relays_changed', from: [...before.relays], to: next });
      this.log.warn('relays.changed', { from: before.relays.length, to: next.length, retiring: this.service.get().retiringRelays.length });
      this.applyRelays();
      await this.announceRelays();
      return { ok: true, changed: true };
    });
  }

  /** Tells the paired phone (and phones with recovery access) the current relays, over every watched relay. */
  private async announceRelays(): Promise<void> {
    const reg = this.engine.registration();
    const alert: Alert = {
      type: 'relays_changed',
      relays: [...this.service.get().relays],
      ...this.stampNow(),
      message: 'Your guardian moved to other relays. The app switches by itself; the old ones stay watched until you stop them.',
    };
    const to = new Set([...(reg ? [reg.appNostrPubkey] : []), ...this.recoveryPeers()]);
    for (const peer of to) await this.notifyPeer(peer, alert);
    this.notifyOwner('relays_changed', `${alert.message} If you did not change them in the guardian's web page, check the guardian now.`);
  }

  /**
   * `relays.ack` from the paired phone: it uses `relays` now. When that is the current list, the change is recorded
   * as confirmed (once). Nothing changes on the wire: the removed relays stay watched, for backups and recovery
   * codes made before the change.
   */
  confirmRelays(relays: string[]): Promise<{ current: boolean; relays: string[] }> {
    return this.relaysMutex.run(async () => {
      const d = this.service.get();
      const current = sameRelays(relays, d.relays);
      if (current && d.relaysChange && d.relaysChange.confirmedAt === undefined) {
        const at = this.clock.now();
        await this.service.update((x) => void (x.relaysChange = { ...x.relaysChange!, confirmedAt: at }));
        await this.logEvent({ type: 'relays_confirmed', relays: [...d.relays] });
        this.log.info('relays.confirmed_by_phone');
      }
      return { current, relays: [...this.service.get().relays] };
    });
  }

  /** A new pairing used the current relays (from the pairing code): nothing is left for a phone to confirm. */
  async relaysKnownByNewPhone(): Promise<void> {
    await this.relaysMutex.run(async () => {
      const c = this.service.get().relaysChange;
      if (c && c.confirmedAt === undefined) await this.service.update((x) => void (x.relaysChange = { ...x.relaysChange!, confirmedAt: this.clock.now() }));
    });
  }

  /**
   * The owner stops watching old relays (`DELETE /api/relays/retiring`, web UI): the one at `url`, or all of them.
   * From now on a phone, backup, recovery code or printed sheet that only knows a dropped relay no longer reaches
   * this guardian. Logs "Old relays dropped" naming them. `not_found` for a relay that is not an old one.
   */
  stopWatchingRelays(url?: unknown): Promise<StopWatchingOutcome> {
    return this.relaysMutex.run(async (): Promise<StopWatchingOutcome> => {
      if (!this.setupComplete) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      const old = this.service.get().retiringRelays;
      let drop = old;
      if (url !== undefined) {
        if (typeof url !== 'string') return { ok: false, code: 'invalid', message: 'Name the old relay to stop watching.' };
        const checked = checkRelayUrl(url.trim());
        const target = 'url' in checked ? checked.url : url.trim();
        drop = old.filter((o) => o.url === target);
        if (!drop.length) return { ok: false, code: 'not_found', message: 'That is not one of the old relays.' };
      }
      if (!drop.length) return { ok: true, dropped: [] };
      const dropped = drop.map((r) => r.url);
      await this.service.update((d) => void (d.retiringRelays = d.retiringRelays.filter((r) => !dropped.includes(r.url))));
      await this.logEvent({ type: 'relays_retired', relays: dropped, by: 'owner' });
      this.log.warn('relays.retiring_dropped', { count: dropped.length, remaining: this.service.get().retiringRelays.length });
      this.applyRelays();
      return { ok: true, dropped };
    });
  }

  /** Sends a protocol alert to the paired phone. Returns true if at least one relay took it. */
  async notifyPhone(alert: Alert): Promise<boolean> {
    const reg = this.engine.registration();
    if (!reg) return false;
    return this.notifyPeer(reg.appNostrPubkey, alert);
  }

  /** Sends a protocol alert to a phone (paired now, or the phone of a wallet that was just retired). */
  async notifyPeer(pubkey: string, alert: Alert): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      const outcomes = await this.rpc.notify(pubkey, alert);
      return outcomes.some((o) => o.ok);
    } catch (e) {
      this.log.warn('alert.phone_failed', { type: alert.type, error: errorText(e) });
      return false;
    }
  }

  /**
   * Queues an alert for the owner's own email, ntfy and webhook channels (not the contacts'), the same words as the
   * phone's alert, and starts delivering in the background. Durable and retried like the engine's alerts.
   */
  notifyOwner(type: string, text: string, walletId?: string): void {
    if (!this.notifier.configured) return;
    const at = this.clock.now();
    const ev: NotifyEvent = { id: `${type}-${at}`, type, at, owner: text, ...(walletId ? { walletId } : {}) };
    void this.notifier
      .enqueue(ev)
      .then((queued) => queued && this.notifier.kick())
      .catch((e: unknown) => this.log.error('notify.enqueue_failed', { type, error: errorText(e) }));
  }

  /**
   * `PUT /api/notifications`: the owner's extra alert channels (notify/notifier.ts). While a recovery runs only additions
   * are accepted, and a new app password for the same email account. A change is announced on every channel (queued by the notifier) and to the paired phone.
   */
  async updateNotifications(input: unknown): Promise<UpdateOutcome> {
    if (!this.setupComplete) return { ok: false, code: 'invalid', message: 'Set up the guardian first.' };
    const r = await this.notifier.update(input, { recoveryRunning: !!this.activeRecord() });
    if (r.ok && r.changed) {
      await this.notifyPhone({
        type: 'notifications_changed',
        ...this.stampNow(),
        message: "Your guardian's email, ntfy or webhook alerts were changed in its web page. If you did not do this, check the guardian.",
      });
      this.notifier.kick();
    }
    return r;
  }

  /** "Send a test message" (`POST /api/notifications/test`). */
  testNotification(input: unknown): Promise<TestOutcome> {
    return this.notifier.test(input);
  }

  /**
   * Wallet rotation once a completed recovery's sweep has been accepted by a node (recovery-runner.ts
   * calls this after the broadcast). The engine retires the swept wallet and, when it can, adopts the
   * destination; this side swaps the paired phone and tells it.
   */
  async rotateAfterSweep(recoveryId: string): Promise<void> {
    // The phone paired to the wallet this retires; the engine forgets it as soon as the wallet rotates.
    const previousPhone = this.engine.registration()?.appNostrPubkey;
    const res = await this.engine.rotateAfterSweep(recoveryId);
    if (!res.ok) {
      this.log.error('wallet.rotation_refused', { recoveryId, reason: res.refusal.reason });
      return;
    }
    const now = this.clock.now();
    const adopted = res.adopted;
    await this.service.update((d) => {
      const kept = adopted ? d.phones.find((p) => p.pubkey === adopted.appNostrPubkey) : undefined;
      d.phones = adopted ? [kept ?? { pubkey: adopted.appNostrPubkey, name: 'Phone (recovered wallet)', pairedAt: now }] : [];
    });
    if (adopted) {
      this.rpc?.addPeer(adopted.appNostrPubkey);
      this.log.info('wallet.adopted', { recoveryId, from: res.retiredWalletId, to: adopted.walletId, revokedGrants: res.revokedGrants });
      this.notifyOwner('wallet_adopted', `The guardian now protects the wallet recovery ${recoveryId} moved the funds to (${adopted.walletId}).`, adopted.walletId);
      await this.notifyPeer(adopted.appNostrPubkey, {
        type: 'wallet_adopted',
        walletId: adopted.walletId,
        previousWalletId: res.retiredWalletId,
        recoveryId,
        hardwareConfirmRequired: !adopted.hardwareAuthConfirmed,
        ...this.stampNow(),
        message: `The guardian now protects your recovered wallet ${adopted.walletId}. Confirm your hardware wallet in the app before changing rules.`,
      });
    } else {
      this.log.warn('wallet.retired_after_recovery', { recoveryId, walletId: res.retiredWalletId, detail: res.detail });
    }
    // The phone that was paired to the swept wallet and is not the new wallet's phone (a lost phone's
    // successor, or no successor at all) is told the wallet is gone from here, and stops being a peer.
    if (previousPhone && previousPhone !== adopted?.appNostrPubkey) {
      this.rpc?.removePeer(previousPhone);
      await this.notifyPeer(previousPhone, {
        type: 'wallet_retired',
        walletId: res.retiredWalletId,
        reason: 'recovered',
        ...(adopted ? { successorWalletId: adopted.walletId } : {}),
        ...this.stampNow(),
        message: adopted
          ? `Wallet ${res.retiredWalletId} was swept by a recovery and retired on this guardian. It now guards wallet ${adopted.walletId} for another phone.`
          : `Wallet ${res.retiredWalletId} was swept by a recovery and retired on this guardian.`,
      });
    }
  }

  /** After `wallet.retire`: the retired wallet's phone is no longer a peer; tell it (best effort). */
  async afterRetire(walletId: string, phone: string): Promise<void> {
    this.rpc?.removePeer(phone);
    await this.sp.unregister('wallet retired');
    this.pairing.invalidate();
    await this.service.update((d) => {
      d.phones = [];
    });
    this.log.info('wallet.retired', { walletId });
    await this.notifyPeer(phone, { type: 'wallet_retired', walletId, reason: 'retired', ...this.stampNow() });
    this.notifyOwner('wallet_retired', `Wallet ${walletId} was retired on your guardian with your phone and your hardware wallet ("Replace guardian"): it co-signs nothing for it any more.`, walletId);
  }

  /** Background work: time-based engine transitions, completing a ready recovery, broadcasts, alerts. Coalesces overlapping calls. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.tickAgain = false;
        try {
          await this.engine.tick();
          await this.recovery.run();
          // Before the alerts, so a Savings spend found now is announced in the same pass.
          await this.savingsWatch.run();
          await this.alerts.run();
          // Email, ntfy, webhook: in the background, so a slow mail server never holds back the tick.
          this.notifier.kick();
          // In the background: a long catch-up must not hold back alerts or recoveries.
          this.sp.kick();
        } catch (e) {
          this.log.error('tick.failed', { error: errorText(e) });
        }
      } while (this.tickAgain && !this.stopped);
    })().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  // ---------------------------------------------------------------------------
  // Key 3

  /**
   * First run: creates key 3 under `passphrase`, records the relays, and ends up unlocked. `entropy` (the web
   * UI always sends it; optional for other callers): 32 bytes from the browser, mixed into the new seed with
   * the OS draw and `TRIKEY_EXTRA_ENTROPY` (keystore.ts, `trikey/guardian-seed/v1`). Never logged or stored.
   */
  setup(input: { passphrase?: unknown; relays?: unknown; entropy?: unknown }): Promise<SetupOutcome> {
    return this.setupMutex.run(async () => {
      if (this.keystore) return { ok: false, code: 'already_setup', message: 'This guardian is already set up.' };
      const bad = checkPassphrase(input.passphrase);
      if (bad) return { ok: false, code: 'invalid', message: `Passphrase: ${bad}.` };
      if (!browserEntropyOk(input.entropy)) return { ok: false, code: 'invalid', message: BAD_ENTROPY };
      const passphrase = input.passphrase as string;
      const parsed = parseRelayList(input.relays);
      if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.message };
      const relays = parsed.relays;

      this.identity = await loadOrCreateIdentity(this.path('identity'));
      const seed = this.newSeed(input.entropy);
      let file: KeystoreFile;
      let signer: KeystoreSigner;
      const held = new GuardianSeed(seed);
      try {
        const derived = held.key3(this.config.network);
        signer = derived.signer;
        file = await sealKeystore(seed, passphrase, derived.pub, this.config.kdf, new Date(this.clock.now()));
      } catch (e) {
        held.wipe();
        throw e;
      } finally {
        seed.fill(0);
      }
      try {
        // Relays first: a keystore on disk means "set up", and set up implies relays.
        await this.service.update((d) => {
          d.relays = relays;
          d.setupAt = this.clock.now();
        });
        await writeKeystore(this.path('keystore'), file);
      } catch (e) {
        signer.wipe();
        held.wipe();
        throw e;
      }
      this.keystore = file;
      this.installSigner(signer, held);
      await this.throttle.succeeded();
      await this.logEvent({ type: 'setup' });
      this.log.info('guardian.setup_complete', { network: this.config.network, relays: relays.length });
      await this.startNostr();
      return { ok: true };
    });
  }

  /** A new setup seed from the OS draw, the browser's `entropy` (already checked) and TRIKEY_EXTRA_ENTROPY. The caller zeroes it. */
  private newSeed(entropy: unknown): Uint8Array {
    const browser = parseBrowserEntropy(entropy);
    if (browser === false) throw new Error(BAD_ENTROPY);
    try {
      return generateSeed({ browser, extra: this.config.extraEntropy });
    } finally {
      browser?.fill(0);
    }
  }

  private installSigner(signer: KeystoreSigner, seed: GuardianSeed): void {
    try {
      this.engine.setSigner(signer);
    } catch (e) {
      signer.wipe();
      seed.wipe();
      throw e;
    }
    this.seed?.wipe();
    this.seed = seed;
    this.signer = signer;
    this.lockedAt = undefined;
    this.lockReason = undefined;
    this.lockedBy = undefined;
  }

  private dropSigner(): void {
    this.engine.setSigner(undefined);
    this.signer?.wipe();
    this.signer = undefined;
    this.seed?.wipe();
    this.seed = undefined;
  }

  /**
   * Key 3 for a new pairing (`pair.prepare` and `pair`): with the phone's contribution `entropy`, the
   * `trikey/key3/v1` key bound to this network, this pairing session and this phone; without, the guardian's
   * own key, as before. Needs the guardian unlocked. The caller wipes `signer`.
   */
  key3ForPairing(input: { entropy?: string; pairingId: string; phonePubkey: string }): { signer: KeystoreSigner; pub: CosignerPublic; mix?: Key3Mix } {
    const seed = this.seed;
    if (!seed || seed.wiped || this.locked) throw new Error('the guardian is locked');
    const network = this.config.network;
    const mix = input.entropy === undefined ? undefined : key3Mix(input.entropy, key3Context({ network, pairingId: input.pairingId, phonePubkey: input.phonePubkey }));
    const { signer, pub } = seed.key3(network, mix);
    return { signer, pub, ...(mix ? { mix } : {}) };
  }

  /**
   * After `engine.register` with the new wallet's own key 3: that key is the signer from now on (the engine
   * installed it with the saved registration, if it was still unlocked). Wipes whichever key is not kept.
   */
  adoptPairedSigner(signer: KeystoreSigner): void {
    if (this.engine.locked) {
      signer.wipe();
      return;
    }
    const old = this.signer;
    this.signer = signer;
    if (old && old !== signer) old.wipe();
  }

  /** Signs with key 3 outside the engine; only for re-creating a sweep the engine already completed (see recovery-runner.ts). */
  get unlockedSigner(): KeystoreSigner | undefined {
    return this.signer && !this.signer.wiped ? this.signer : undefined;
  }

  /**
   * Why the paired phone may not unlock right now, if it may not: after `PHONE_UNLOCK_MAX_FAILURES`
   * failed passphrases in a row (until the web UI unlocks), and while a recovery the phone did not start
   * is pending or ready (a stolen phone must not be able to switch key 3 on to sign the thief's way out;
   * locking is always allowed).
   */
  private phoneUnlockRefusal(): UnlockOutcome | undefined {
    if (this.phoneThrottle.failures >= PHONE_UNLOCK_MAX_FAILURES)
      return { ok: false, code: 'phone_unlock_disabled', message: 'Too many wrong passphrases from the phone. Unlock the guardian in its web UI.' };
    const rec = this.activeRecord();
    const phone = this.engine.registration()?.appNostrPubkey;
    const startedByPhone = rec && (rec.initiator !== undefined ? rec.initiator === phone : rec.survivingRole === 'app');
    if (rec && !startedByPhone)
      return { ok: false, code: 'recovery_pending', message: `Recovery ${rec.id} is running. The phone cannot unlock the guardian meanwhile; unlock it in its web UI.` };
    return undefined;
  }

  /** Unlock with the passphrase (web UI or `guardian.unlock`). Rate limited; the passphrase is never logged. */
  unlock(passphrase: unknown, via: 'web' | 'phone'): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (!this.locked) return { ok: true };
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4 * MAX_PASSPHRASE_LENGTH)
        return { ok: false, code: 'invalid', message: 'Enter the unlock passphrase.' };
      if (via === 'phone') {
        const refusal = this.phoneUnlockRefusal();
        if (refusal) {
          this.log.warn('guardian.phone_unlock_refused', { code: 'code' in refusal ? refusal.code : undefined });
          return refusal;
        }
      }
      const throttle = via === 'web' ? this.throttle : this.phoneThrottle;
      const verdict = throttle.check();
      if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
      await throttle.begin();
      let seed: GuardianSeed;
      try {
        seed = await unlockKeystoreSeed(file, passphrase);
      } catch (e) {
        if (!(e instanceof BadPassphraseError)) throw e;
        this.log.warn('guardian.unlock_failed', { via, failures: throttle.failures });
        await this.logEvent({ type: 'unlock_failed', via });
        const next = throttle.check();
        return { ok: false, code: 'bad_passphrase', retryAfterSeconds: next.ok ? undefined : Math.ceil(next.retryAfterMs / 1000) };
      }
      // The paired wallet's key 3: derived again from the seed and, if the phone contributed, its bytes.
      let signer: KeystoreSigner;
      try {
        signer = seed.key3(file.public.network, this.engine.registration()?.key3Mix).signer;
      } catch (e) {
        seed.wipe();
        throw e;
      }
      this.installSigner(signer, seed);
      await throttle.succeeded();
      // A successful unlock at the box also lets the phone try again.
      if (via === 'web') await this.phoneThrottle.succeeded();
      this.log.info('guardian.unlocked', { via });
      await this.logEvent({ type: 'unlocked', via });
      void this.tick();
      return { ok: true };
    });
  }

  /**
   * Checks the unlock passphrase for a web sign-in (`POST /api/session`) without unlocking anything.
   * Its own throttle, like every other passphrase entry point; the passphrase is never logged.
   */
  checkWebPassphrase(passphrase: unknown): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4 * MAX_PASSPHRASE_LENGTH)
        return { ok: false, code: 'invalid', message: 'Enter the unlock passphrase.' };
      const verdict = this.sessionThrottle.check();
      if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
      await this.sessionThrottle.begin();
      try {
        (await unlockKeystoreSeed(file, passphrase)).wipe();
      } catch (e) {
        if (!(e instanceof BadPassphraseError)) throw e;
        this.log.warn('web.sign_in_failed', { failures: this.sessionThrottle.failures });
        await this.logEvent({ type: 'unlock_failed', via: 'web' });
        const next = this.sessionThrottle.check();
        return { ok: false, code: 'bad_passphrase', retryAfterSeconds: next.ok ? undefined : Math.ceil(next.retryAfterMs / 1000) };
      }
      await this.sessionThrottle.succeeded();
      return { ok: true };
    });
  }

  /**
   * Drops key 3 from memory: `manual` from the web UI, `remote` when the paired phone asks
   * (`guardian.lock`, e.g. the user fears the box was tampered with). Always allowed: it only
   * reduces what the guardian can do. Already locked: nothing happens, no alert.
   */
  async lock(reason: 'manual' | 'remote' = 'manual'): Promise<void> {
    let locked = false;
    await this.unlockMutex.run(async () => {
      if (this.locked) return;
      this.dropSigner();
      this.pairing.invalidate();
      this.lockedAt = this.clock.now();
      this.lockReason = reason;
      locked = true;
      this.log.info('guardian.locked', { reason });
      await this.logEvent({ type: 'locked', reason });
    });
    if (locked) await this.notifyPhone({ type: 'guardian_locked', reason, ...this.stampNow() });
    // The owner's own channels hear of a lock from the phone (which may be in other hands); a lock at the box is their own.
    if (locked && reason === 'remote') this.notifyOwner('guardian_locked', 'Your guardian was locked from your phone: it co-signs nothing until you unlock it with the passphrase.');
  }

  /**
   * An alert contact's `LOCK` DM (dm-lock.ts, which checked the sender is a current alert contact, the message is fresh,
   * new and within the contact's rate limit). Locks exactly as `lock()` does (key 3 leaves memory; recoveries and their
   * timers run on as on any locked guardian), but only while the active wallet's rules let the contacts lock it
   * (`not_allowed` otherwise). `already_locked`: nothing changes and nobody is alerted. On `locked` the engine has
   * logged it and queued the `contact_lock` notice (the paired phone and every other alert contact, retried until
   * delivered); unlocking stays with the owner (web UI passphrase, or the phone's `guardian.unlock`).
   */
  async lockByContact(contact: string): Promise<ContactLockOutcome> {
    const outcome = await this.unlockMutex.run(async (): Promise<ContactLockOutcome> => {
      if (!this.engine.status().rules?.contactLock) return 'not_allowed';
      if (this.locked) return 'already_locked';
      const noted = await this.engine.noteContactLock(contact);
      if (!noted.ok) return 'not_allowed';
      this.dropSigner();
      this.pairing.invalidate();
      this.lockedAt = this.clock.now();
      this.lockReason = 'contact';
      this.lockedBy = contact;
      this.log.warn('guardian.locked', { reason: 'contact' });
      return 'locked';
    });
    // The paired phone and the other contacts learn it from the notice the engine queued.
    if (outcome === 'locked') void this.alerts.run();
    return outcome;
  }

  /**
   * The web UI's "reset guardian": forget every wallet and create a NEW key 3, keeping the nostr
   * identity, the relays and the unlock passphrase. Needs the passphrase again (rate limited like an
   * unlock) and `confirm` typed exactly as `RESET_CONFIRMATION`. Refused while a recovery is
   * pending or ready, and while a co-signed sweep still waits to be broadcast (its signature would
   * be lost with key 3).
   *
   * Why key 3 is rotated rather than kept (DESIGN.md, threat model): with the old key 3 and no
   * wallet state, anyone holding the web UI, the passphrase and a stolen hardware wallet could
   * re-pair the user's own wallet with a phone of their choosing and no alert contacts, then run a
   * recovery whose alerts only they receive. A new key 3 cannot co-sign the old wallet at all.
   * The old wallet stays spendable with the phone and the hardware wallet (2 of 3).
   *
   * Order on disk: the engine state and service state are wiped first, the keystore replaced last,
   * so a crash in between leaves a guardian with no wallet and the old key 3, and another reset
   * finishes the job (never a wallet paired to a key the keystore does not hold).
   */
  reset(input: { passphrase?: unknown; confirm?: unknown; entropy?: unknown }): Promise<ResetOutcome> {
    return this.unlockMutex.run(() =>
      this.recoveryMutex.run(() =>
        this.pairMutex.run(async (): Promise<ResetOutcome> => {
          const file = this.keystore;
          if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
          if (input.confirm !== RESET_CONFIRMATION) return { ok: false, code: 'invalid', message: `Type ${RESET_CONFIRMATION} to confirm.` };
          if (!browserEntropyOk(input.entropy)) return { ok: false, code: 'invalid', message: BAD_ENTROPY };
          const passphrase = input.passphrase;
          if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4 * MAX_PASSPHRASE_LENGTH)
            return { ok: false, code: 'invalid', message: 'Enter the unlock passphrase.' };
          const refuse = async (code: 'recovery_pending' | 'sweep_pending', message: string): Promise<ResetOutcome> => {
            await this.logEvent({ type: 'reset_refused', detail: message });
            return { ok: false, code, message };
          };
          const running = this.activeRecord();
          if (running) return refuse('recovery_pending', `Recovery ${running.id} is running. It must be cancelled or completed before the guardian can be reset.`);
          // A dead sweep (it can never be broadcast: recovery-runner.ts) has no signature worth keeping.
          const unsent = this.service.get().sweeps.find((s) => s.broadcastAt === undefined && s.deadAt === undefined);
          if (unsent) return refuse('sweep_pending', `The sweep of recovery ${unsent.recoveryId} has not been broadcast yet. Wait until it is.`);

          const verdict = this.resetThrottle.check();
          if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
          await this.resetThrottle.begin();
          try {
            (await unlockKeystoreSeed(file, passphrase)).wipe();
          } catch (e) {
            if (!(e instanceof BadPassphraseError)) throw e;
            this.log.warn('guardian.reset_bad_passphrase', { failures: this.resetThrottle.failures });
            await this.logEvent({ type: 'unlock_failed', via: 'web' });
            const next = this.resetThrottle.check();
            return { ok: false, code: 'bad_passphrase', retryAfterSeconds: next.ok ? undefined : Math.ceil(next.retryAfterMs / 1000) };
          }
          await this.resetThrottle.succeeded();

          // Tell the paired phone while it is still a peer.
          const reg = this.engine.registration();
          if (reg) await this.notifyPhone({ type: 'wallet_retired', walletId: reg.walletId, reason: 'reset', ...this.stampNow() });
          if (reg) this.notifyOwner('wallet_retired', `Your guardian was reset in its web page: it forgot wallet ${reg.walletId} and made a new key 3. That wallet stays spendable with your phone and your hardware wallet. If you did not do this, someone knows the guardian's passphrase.`, reg.walletId);

          const seed = this.newSeed(input.entropy);
          let next: KeystoreFile;
          let signer: KeystoreSigner;
          const held = new GuardianSeed(seed);
          try {
            const derived = held.key3(this.config.network);
            signer = derived.signer;
            next = await sealKeystore(seed, passphrase, derived.pub, this.config.kdf, new Date(this.clock.now()));
          } catch (e) {
            held.wipe();
            throw e;
          } finally {
            seed.fill(0);
          }
          let forgotten: string[];
          try {
            const res = await this.engine.reset();
            if (!res.ok) {
              signer.wipe();
              held.wipe();
              return refuse('recovery_pending', 'A recovery is running.');
            }
            forgotten = res.forgotten;
            this.dropSigner();
            await this.service.update((d) => {
              d.phones = [];
              d.sweeps = [];
              d.recoveryPeers = [];
            });
            await this.sp.unregister('guardian reset');
            await replaceKeystore(this.path('keystore'), next);
          } catch (e) {
            signer.wipe();
            held.wipe();
            throw e;
          }
          this.keystore = next;
          this.pairing.invalidate();
          // Every web session ends with the old key 3 (the routes sign the resetting browser in again).
          this.sessions.clear();
          this.installSigner(signer, held);
          this.recovery.wait = undefined;
          await this.logEvent({ type: 'reset' });
          this.log.warn('guardian.reset', { forgottenWallets: forgotten.length });
          return { ok: true, forgotten };
        }),
      ),
    );
  }
}
