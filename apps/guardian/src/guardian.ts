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
 *   service.json         relays, paired phone, co-signed sweeps, service log
 *   unlock-throttle.json unlock rate limit
 */
import { join } from 'node:path';
import type { Server } from 'node:http';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import { RpcServer, SimplePoolRelayPool, normalizeRelayUrl, type Alert, type MethodName } from '@trikey/protocol';
import { ChainService } from './chain/chain.js';
import { BitcoinRpc } from './chain/bitcoind.js';
import { ElectrumClient, type ElectrumClientOptions } from './chain/electrum.js';
import type { GuardianConfig } from './config.js';
import { ensureDataDir, Mutex } from './files.js';
import { loadOrCreateIdentity, loadIdentity, type GuardianIdentity } from './identity.js';
import {
  BadPassphraseError,
  MAX_PASSPHRASE_LENGTH,
  checkPassphrase,
  cosignerFromSeed,
  generateSeed,
  readKeystore,
  sealKeystore,
  unlockKeystore,
  writeKeystore,
  type KeystoreFile,
  type KeystoreSigner,
} from './keystore.js';
import { errorText, silentLogger, type Logger } from './log.js';
import { ObservedStore } from './observed-store.js';
import { PairingSessions } from './pairing.js';
import { JsonFileStore, PolicyEngine, systemClock, type Clock, type RecoveryRecord, type StateStore } from './policy/index.js';
import { ServiceState, type ServiceEvent } from './service-state.js';
import { UnlockThrottle, type ThrottleOptions } from './unlock-throttle.js';
import { DirectMessages } from './nostr/dm.js';
import { buildHandlers } from './nostr/handlers.js';
import { toSeconds } from './nostr/wire.js';
import { Alerter } from './alerts.js';
import { RecoveryRunner } from './recovery-runner.js';
import { onContactDm } from './dm-cancel.js';
import { startHttpServer } from './http/server.js';
import { buildRoutes } from './http/api.js';
import { GUARDIAN_VERSION } from './version.js';

export const FILES = {
  keystore: 'keystore.json',
  identity: 'nostr-identity.json',
  engine: 'guardian-state.json',
  service: 'service.json',
  throttle: 'unlock-throttle.json',
} as const;

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
}

export type UnlockOutcome =
  | { ok: true }
  | { ok: false; code: 'bad_passphrase' | 'rate_limited'; retryAfterSeconds?: number }
  | { ok: false; code: 'setup_required' | 'invalid'; message: string };

export type SetupOutcome = { ok: true } | { ok: false; code: 'invalid' | 'already_setup'; message: string };

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
  'recovery.status',
  'recovery.cancel',
]);
/** At most this many phones hold recovery access at once (the newest win). */
const MAX_RECOVERY_PEERS = 8;

/** The running (pending or ready) recovery in the engine's state, if any. */
export function activeRecovery(recoveries: readonly RecoveryRecord[] | undefined): RecoveryRecord | undefined {
  const last = recoveries?.[recoveries.length - 1];
  return last && (last.status === 'pending' || last.status === 'ready') ? last : undefined;
}

export class Guardian {
  readonly config: GuardianConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly chain: ChainService;
  readonly pairing = new PairingSessions();
  readonly alerts: Alerter;
  readonly recovery: RecoveryRunner;

  engine!: PolicyEngine;
  store!: ObservedStore;
  service!: ServiceState;
  throttle!: UnlockThrottle;
  keystore?: KeystoreFile;
  identity?: GuardianIdentity;
  rpc?: RpcServer;
  dm?: DirectMessages;

  /** When and why the guardian last locked (undefined while unlocked). */
  lockedAt?: number = undefined;
  lockReason?: 'restart' | 'manual' = undefined;

  private signer?: KeystoreSigner;
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
    this.alerts = new Alerter(this);
    this.recovery = new RecoveryRunner(this);
  }

  private path(name: keyof typeof FILES): string {
    return join(this.config.dataDir, FILES[name]);
  }

  /** Loads all state from the data directory. Refuses to run on the wrong network. */
  static async open(opts: GuardianOptions): Promise<Guardian> {
    const g = new Guardian(opts);
    await ensureDataDir(g.config.dataDir);
    g.keystore = await readKeystore(g.path('keystore'));
    g.identity = await loadIdentity(g.path('identity'));
    g.service = new ServiceState(g.path('service'));
    await g.service.load();
    g.throttle = new UnlockThrottle(g.path('throttle'), g.clock, opts.throttle);
    await g.throttle.load();
    g.store = new ObservedStore(opts.store ?? new JsonFileStore(g.path('engine')));
    g.engine = await PolicyEngine.open({ store: g.store, clock: g.clock });
    const net = g.config.network;
    if (g.keystore && g.keystore.public.network !== net)
      throw new ConfigError(`key 3 was created for ${g.keystore.public.network}, but BITCOIN_NETWORK is ${net}`);
    const reg = g.engine.registration();
    if (reg && reg.network !== net) throw new ConfigError(`the paired wallet is on ${reg.network}, but BITCOIN_NETWORK is ${net}`);
    if (reg && g.keystore && reg.cosignerAccountPubkey !== g.keystore.public.accountPubkey)
      throw new ConfigError('the paired wallet does not use this guardian key');
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

  nowSec(): number {
    return toSeconds(this.clock.now());
  }

  /** Engine state as last saved (read-only). */
  get records(): readonly RecoveryRecord[] {
    return this.store.state?.recoveries ?? [];
  }

  activeRecord(): RecoveryRecord | undefined {
    return activeRecovery(this.records);
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
      });
    }
    this.chain.start();
    this.chain.onTip(() => void this.tick());
    if (this.setupComplete) {
      await this.startNostr();
      await this.notifyPhone({ type: 'guardian_locked', reason: 'restart', at: this.nowSec() });
    }
    await this.logEvent({ type: 'started' });
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
    const relays = this.service.get().relays;
    if (!relays.length) {
      this.log.error('nostr.no_relays');
      return;
    }
    this.simplePool = new SimplePool({ enableReconnect: true, enablePing: true });
    this.pool = new SimplePoolRelayPool({ pool: this.simplePool });
    this.rpc = new RpcServer({
      pool: this.pool,
      relays,
      secretKey: this.identity.secretKey,
      handlers: buildHandlers(this),
      authorize: (sender, method) => this.authorize(sender, method),
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
    });
    await this.rpc.start();
    this.dm.start();
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

  /** True while `pubkey` holds an unexpired `recovery.access` grant. */
  hasRecoveryAccess(pubkey: string): boolean {
    const now = this.clock.now();
    return this.service.get().recoveryPeers.some((p) => p.pubkey === pubkey && p.until > now);
  }

  /** Records a `recovery.access` grant (durably, so it survives a restart). */
  async grantRecoveryAccess(pubkey: string, untilMs: number): Promise<void> {
    const now = this.clock.now();
    await this.service.update((d) => {
      d.recoveryPeers = [...d.recoveryPeers.filter((p) => p.until > now && p.pubkey !== pubkey), { pubkey, until: untilMs }].slice(-MAX_RECOVERY_PEERS);
    });
    await this.logEvent({ type: 'recovery_access', phone: pubkey, until: untilMs });
  }

  isAlertContact(pubkey: string): boolean {
    const rules = this.engine.status().rules;
    if (rules?.alertContacts.includes(pubkey)) return true;
    return !!this.activeRecord()?.recipients.includes(pubkey);
  }

  /** Relay URLs and whether the pool currently holds an open connection to each. */
  relayStatus(): { url: string; connected: boolean }[] {
    const status = this.simplePool?.listConnectionStatus();
    return this.service.get().relays.map((url) => ({ url, connected: !!status?.get(normalizeURL(url)) }));
  }

  /** Sends a protocol alert to the paired phone. Returns true if at least one relay took it. */
  async notifyPhone(alert: Alert): Promise<boolean> {
    const reg = this.engine.registration();
    if (!reg || !this.rpc) return false;
    try {
      const outcomes = await this.rpc.notify(reg.appNostrPubkey, alert);
      return outcomes.some((o) => o.ok);
    } catch (e) {
      this.log.warn('alert.phone_failed', { type: alert.type, error: errorText(e) });
      return false;
    }
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
          await this.alerts.run();
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

  /** First run: creates key 3 under `passphrase`, records the relays, and ends up unlocked. */
  setup(input: { passphrase?: unknown; relays?: unknown }): Promise<SetupOutcome> {
    return this.setupMutex.run(async () => {
      if (this.keystore) return { ok: false, code: 'already_setup', message: 'This guardian is already set up.' };
      const bad = checkPassphrase(input.passphrase);
      if (bad) return { ok: false, code: 'invalid', message: `Passphrase: ${bad}.` };
      const passphrase = input.passphrase as string;
      if (!Array.isArray(input.relays) || input.relays.length < 1 || input.relays.length > 8)
        return { ok: false, code: 'invalid', message: 'Choose between 1 and 8 relays.' };
      let relays: string[];
      try {
        relays = [...new Set(input.relays.map((r) => normalizeRelayUrl(String(r))))];
      } catch (e) {
        return { ok: false, code: 'invalid', message: errorText(e) };
      }

      this.identity = await loadOrCreateIdentity(this.path('identity'));
      const seed = generateSeed();
      let file: KeystoreFile;
      let signer: KeystoreSigner;
      try {
        const derived = cosignerFromSeed(seed, this.config.network);
        signer = derived.signer;
        file = await sealKeystore(seed, passphrase, derived.pub, this.config.kdf, new Date(this.clock.now()));
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
        throw e;
      }
      this.keystore = file;
      this.installSigner(signer);
      await this.throttle.succeeded();
      await this.logEvent({ type: 'setup' });
      this.log.info('guardian.setup_complete', { network: this.config.network, relays: relays.length });
      await this.startNostr();
      return { ok: true };
    });
  }

  private installSigner(signer: KeystoreSigner): void {
    try {
      this.engine.setSigner(signer);
    } catch (e) {
      signer.wipe();
      throw e;
    }
    this.signer = signer;
    this.lockedAt = undefined;
    this.lockReason = undefined;
  }

  private dropSigner(): void {
    this.engine.setSigner(undefined);
    this.signer?.wipe();
    this.signer = undefined;
  }

  /** Signs with key 3 outside the engine; only for re-creating a sweep the engine already completed (see recovery-runner.ts). */
  get unlockedSigner(): KeystoreSigner | undefined {
    return this.signer && !this.signer.wiped ? this.signer : undefined;
  }

  /** Unlock with the passphrase (web UI or `guardian.unlock`). Rate limited; the passphrase is never logged. */
  unlock(passphrase: unknown, via: 'web' | 'phone'): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (!this.locked) return { ok: true };
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4 * MAX_PASSPHRASE_LENGTH)
        return { ok: false, code: 'invalid', message: 'Enter the unlock passphrase.' };
      const verdict = this.throttle.check();
      if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
      await this.throttle.begin();
      let signer: KeystoreSigner;
      try {
        signer = await unlockKeystore(file, passphrase);
      } catch (e) {
        if (!(e instanceof BadPassphraseError)) throw e;
        this.log.warn('guardian.unlock_failed', { via, failures: this.throttle.failures });
        await this.logEvent({ type: 'unlock_failed', via });
        const next = this.throttle.check();
        return { ok: false, code: 'bad_passphrase', retryAfterSeconds: next.ok ? undefined : Math.ceil(next.retryAfterMs / 1000) };
      }
      this.installSigner(signer);
      await this.throttle.succeeded();
      this.log.info('guardian.unlocked', { via });
      await this.logEvent({ type: 'unlocked', via });
      void this.tick();
      return { ok: true };
    });
  }

  /** Drops key 3 from memory. */
  async lock(): Promise<void> {
    await this.unlockMutex.run(async () => {
      if (this.locked) return;
      this.dropSigner();
      this.pairing.invalidate();
      this.lockedAt = this.clock.now();
      this.lockReason = 'manual';
      this.log.info('guardian.locked', { reason: 'manual' });
      await this.logEvent({ type: 'locked', reason: 'manual' });
    });
    await this.notifyPhone({ type: 'guardian_locked', reason: 'manual', at: this.nowSec() });
  }
}
