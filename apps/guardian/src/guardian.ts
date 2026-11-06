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
 *   unlock-slots.json    key 3's seed, encrypted once more per own wallet
 *                        whose owner turned on unlocking with the hardware
 *                        wallet (unlock-slots.ts); only once one is on
 *   silent-payments.json, silent-payments-key.json
 *                        the silent payment scanner (silent/service.ts): its
 *                        registration, matches, and the key its scan key is
 *                        encrypted under (so it scans while locked)
 *   notifications.json, notifications-key.json
 *                        extra alert channels (notify/notifier.ts): email,
 *                        ntfy, webhook and Telegram settings, their outbox, and
 *                        the key their secrets are sealed under (so alerts go
 *                        out while locked)
 *   seen-wraps.json      ids of gift wraps already handled (`FILES.seenWraps`).
 *                        One file for the one nostr key: guests' phones talk to
 *                        the same key, so their wraps are remembered here too
 *   hosting.json, hosted/<slotId>/state.json, hosted/<slotId>/slot.json
 *                        family hosting (hosting/service.ts): the slot
 *                        registry, and each guest wallet's engine state and
 *                        sweeps. Only once the owner invites someone
 *   live-wallet.json     the live wallet (live-wallet.ts): which transactions
 *                        `wallet_tx` alerts announced, and those still waiting
 *                        for a relay
 *   wallets.json, wallets/<slotId>/guardian-state.json, wallets/<slotId>/service.json
 *                        the owner's own wallets after the first (wallets/):
 *                        the registry (names, accounts ever used), and each
 *                        wallet's engine state and co-signed sweeps. Only once
 *                        the owner adds a wallet (docs/design/multi-wallet.md)
 */
import { join } from 'node:path';
import type { Server } from 'node:http';
import { hex } from '@scure/base';
import type { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import { GUARDIAN_FEATURES, RpcServer, UnlockKeyHolder, unlockKeyMessage, type SealedUnlock, type UnlockSecret, SeenWraps, SimplePoolRelayPool, checkRelayList, checkRelayUrl, createSimplePool, sameRelays, type Alert, type MethodName } from '@trikey/protocol';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import { ChainService } from './chain/chain.js';
import { RelayedTxs } from './chain/relayed.js';
import { BitcoinRpc } from './chain/bitcoind.js';
import { type ElectrumClientOptions } from './chain/electrum.js';
import type { ChainBackend } from './chain/backend.js';
import { CoreBackend } from './chain/core-backend.js';
import {
  buildBackend,
  ChainSourceError,
  ChainSourceStore,
  describe as describeSource,
  environmentSourceName,
  parseChainSource,
  sameChainSource,
  summarize,
  type ChainSource,
  type ChainSourceSummary,
} from './chain/source.js';
import type { GuardianConfig } from './config.js';
import { ensureDataDir, Mutex } from './files.js';
import { loadOrCreateIdentity, loadIdentity, type GuardianIdentity } from './identity.js';
import {
  BadPassphraseError,
  SamePassphraseError,
  changeKeystorePassphrase,
  sameSeed,
  GuardianSeed,
  MAX_PASSPHRASE_LENGTH,
  SETUP_ENTROPY_BYTES,
  checkPassphrase,
  generateSeed,
  guardianSeedOf,
  key3Context,
  keystoreBinding,
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
import { Inbox, seenWrapsFile } from './nostr/inbox.js';
import { buildHandlers, KnownCoins, walletOf } from './nostr/handlers.js';
import { LiveWallet, type LiveWalletOptions } from './live-wallet.js';
import { helperAccount, type AddressSource } from './singlekey.js';
import { savingsWallet } from './savings.js';
import type { MultisigWallet, NetworkName } from '@trikey/core';
import type { SavingsWatch } from './policy/index.js';
import { stampOf, toSeconds } from './nostr/wire.js';
import { DEFAULT_BROADCAST_LIMIT, DEFAULT_CONTACT_LOCK_LIMIT, DEFAULT_REFUSAL_LIMIT, SlidingWindowLimiter, type RateLimitOptions } from './rate-limit.js';
import { Alerter } from './alerts.js';
import { RecoveryRunner } from './recovery-runner.js';
import { onContactDm } from './dm-cancel.js';
import { startHttpServer } from './http/server.js';
import { buildRoutes } from './http/api.js';
import { WebSessions } from './http/sessions.js';
import { SetupCode } from './http/setup-code.js';
import { TrustedProxy, isLoopback } from './http/trusted-proxy.js';
import { GUARDIAN_VERSION } from './version.js';
import { SilentPaymentService } from './silent/service.js';
import { SavingsMonitor } from './savings.js';
import { Hosting } from './hosting/service.js';
import type { HostedKey3Mix } from './keystore.js';
import { Notifier, type FindOutcome, type NotifyEvent, type TestOutcome, type UpdateOutcome } from './notify/notifier.js';
import type { NetPolicy } from './notify/net.js';
import type { SmtpTestOptions } from './notify/channels.js';
import { activeRecovery, labelled, type WalletRuntime } from './runtime.js';
import { OwnWallets } from './wallets/service.js';
import { LabelsVault, strayLabelIds } from './labels.js';
import { DamagedSlotError, UNLOCK_SLOTS_FILE, UnlockSlots, WrongSlotKeyError, openSlot, sealSlot } from './unlock-slots.js';
import { bip137Authorizer } from './policy/authorizer.js';

export const FILES = {
  keystore: 'keystore.json',
  identity: 'nostr-identity.json',
  engine: 'guardian-state.json',
  service: 'service.json',
  throttle: 'unlock-throttle.json',
  phoneThrottle: 'unlock-throttle-phone.json',
  resetThrottle: 'reset-throttle.json',
  sessionThrottle: 'session-throttle.json',
  /** Ids of gift wraps already handled (not secret: the relays hold the wraps), so a restart opens none again. */
  seenWraps: 'seen-wraps.json',
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
  /** Encrypted notes: uploads per wallet per hour (labels.ts `DEFAULT_LABELS_UPLOAD_LIMIT`). */
  labelsUploadLimit?: RateLimitOptions;
  /** How often the watched Savings wallet is scanned when no block came (savings.ts). Default 2 minutes. */
  savingsScanIntervalMs?: number;
  /**
   * Test seams for the extra alert channels (notify/): local test servers on 127.0.0.1, a self-signed SMTP server, a
   * fake Telegram Bot API.
   */
  notify?: { net?: NetPolicy; smtpTest?: SmtpTestOptions; telegramApi?: string };
  /** Builds the backend for a chain source (tests: fakes instead of public servers). Default: chain/source.ts `buildBackend`. */
  chainBackend?: (source: ChainSource, opts: { probe: boolean }) => ChainBackend;
  /** The live wallet (live-wallet.ts): `false` turns it off (no subscriptions, no `wallet_tx`); else its options. */
  liveWallet?: false | LiveWalletOptions;
  /** Most scripts subscribed on an Electrum server (chain/live.ts). */
  /** Tests: the ping round trip (ms) above which the chain server counts as slow (chain.ts `SLOW_PING_MS`). */
  slowPingMs?: number;
  liveMaxScripts?: number;
}

export type ChainSourceOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: 'invalid' | 'setup_required' | 'recovery_pending' | 'not_found'; message: string };

const RECOVERY_BLOCKS_PUBLIC = 'A recovery is running: the guardian switches to a public server only after it ends. You can switch to your own node now.';


export interface ChainTestOutcome {
  ok: boolean;
  server?: string;
  height?: number;
  error?: string;
}

/** What a `LOCK` DM from an alert contact did (`Guardian.lockByContact`). */
export type ContactLockOutcome = 'locked' | 'already_locked' | 'not_allowed';

export type UnlockOutcome =
  | { ok: true }
  /**
   * `bad_hardware`: the hardware wallet's signature does not open that wallet's unlock slot (it counts as a failure).
   * `bad_seal`: a sealed unlock sealed to the current unlock key does not open, or names another guardian, phone or
   * request (only the paired phone's wraps get here, so it counts as a failure too).
   */
  | { ok: false; code: 'bad_passphrase' | 'bad_hardware' | 'bad_seal' | 'rate_limited'; retryAfterSeconds?: number }
  /**
   * `unlock_key_stale`: a sealed unlock sealed to an unlock key the guardian no longer holds (it restarted, locked again,
   * or replaced the key after a failed try), or past its expiry. Nothing was tried: not a failure; seal again.
   */
  | { ok: false; code: 'unlock_key_stale'; message: string }
  /**
   * `phone_unlock_disabled`: too many failed phone attempts in a row, until the web UI unlocks;
   * `recovery_pending`: the phone may not unlock while a recovery it did not start is running.
   */
  | { ok: false; code: 'setup_required' | 'invalid' | 'phone_unlock_disabled' | 'recovery_pending'; message: string }
  /** `hardware_unlock_off`: no unlock slot for that wallet, or another slot id (turned off, or on again since): not a failure. */
  | { ok: false; code: 'hardware_unlock_off'; message: string };

/** How an unlock attempt came (`Guardian.unlockAttempt`): for its failure code, the log and the Activity. */
type AttemptHow = { hardwareOf?: string; sealed?: boolean; badSeal?: boolean; unsealed?: boolean };

/** What `unlock.hardware.add` did, or why not. */
export type HardwareUnlockAddOutcome =
  | { ok: true; walletId: string; slot: string; addedAt: number }
  | { ok: false; code: 'locked' | 'not_registered' | 'wallet_changed' | 'hardware_unconfirmed' | 'bad_signature' | 'setup_required'; message: string }
  /**
   * The signature sealed (`sealed_unlock`): `unlock_key_stale`, sealed to a key the guardian no longer holds or expired
   * (seal again, nothing was opened); `bad_seal`, sealed to the current key but it does not open, or is not this
   * request's (another purpose, guardian, phone, id, wallet or slot).
   */
  | { ok: false; code: 'unlock_key_stale' | 'bad_seal'; message: string };

export type SetupOutcome = { ok: true } | { ok: false; code: 'invalid' | 'already_setup'; message: string };

/**
 * What a passphrase change did (`Guardian.changePassphrase`). `bad_passphrase` / `rate_limited`: the current passphrase,
 * through the web unlock's throttle; `same_passphrase`: the new one is the current one.
 */
export type PassphraseChangeOutcome =
  | { ok: true }
  | { ok: false; code: 'bad_passphrase' | 'rate_limited'; retryAfterSeconds?: number }
  | { ok: false; code: 'setup_required' | 'locked' | 'invalid' | 'same_passphrase'; message: string };

/** What the owner's phone and own channels are told after a passphrase change (no secret, no link). */
export const PASSPHRASE_CHANGED_TEXT =
  "Your guardian's passphrase was changed in its web page. The old passphrase no longer unlocks it; key 3, your wallet and the hardware wallet unlock are unchanged. If you did not do this, someone who knew the old passphrase has the guardian's web page: lock the guardian from your phone and move your wallet to a new guardian with Replace guardian.";

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
  | { ok: false; code: 'setup_required' | 'invalid' | 'recovery_pending' | 'sweep_pending' | 'hosting_active'; message: string };

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
  // Encrypted notes: a new phone without a backup brings the wallet's notes back (the hardware wallet decrypts them).
  'labels.get',
  'labels.list',
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
export { activeRecovery };

export class Guardian implements WalletRuntime {
  /** The first wallet has no slot: its files are where they always were. */
  readonly slotId = undefined;
  /** The first wallet's BIP 48 account on the phone seed and the key 3 seed. */
  readonly account = 0;
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
  /** Guests' wallets (docs/design/family-hosting.md): one engine per slot, next to the host's untouched engine. */
  readonly hosting: Hosting;
  /**
   * The owner's own wallets after the first (docs/design/multi-wallet.md): one engine and runtime each, key 3 at their
   * account of the first pairing's key 3 seed. The first wallet is this `Guardian` itself, unchanged.
   */
  readonly wallets: OwnWallets;
  /** Encrypted notes of every own wallet (labels.ts): ciphertext the phone stores here to survive a recovery. */
  readonly labels: LabelsVault;
  /** Unlocking with the hardware wallet (unlock-slots.ts): key 3's seed under each own wallet's hardware wallet that may unlock. */
  readonly unlockSlots: UnlockSlots;
  /** Email, ntfy, webhook and Telegram alerts (notify/notifier.ts): owner-side settings from the web UI; works while locked. */
  readonly notifier: Notifier;
  /** Keeps the wallets' chain data live and sends `wallet_tx` alerts (live-wallet.ts). Undefined when turned off. */
  readonly live?: LiveWallet;
  /**
   * The paired wallet's coins as last read (a `wallet.sync`, or a pass of the live wallet): what `tx.broadcast` checks a
   * transaction's inputs against before it scans (handlers.ts `spendsKnownCoin`).
   */
  readonly knownCoins = new KnownCoins();

  engine!: PolicyEngine;
  store!: ObservedStore;
  service!: ServiceState;
  /** The chain's tip as every engine reads it (recovery delay, daily limit window): the chain source's. */
  readonly engineChain = {
    tip: async () => {
      const t = await this.chain.tip();
      return { height: t.height, medianTimePastMs: t.medianTimePast * 1000 };
    },
  };
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
  /**
   * The one-time code first-run setup asks for (http/setup-code.ts), on every platform (`config.platform` set; unset
   * for embedders and tests): printed in the log, new at every start, or the one the platform handed in
   * (TRIKEY_SETUP_CODE, Start9). Requests through the platform's login proxy need none (`trustedProxy`).
   */
  readonly setupCode?: SetupCode;
  /** Who reaches the guardian only through the platform's login (TRIKEY_TRUSTED_PROXY; http/trusted-proxy.ts). */
  readonly trustedProxy?: TrustedProxy;
  /** Wrong setup codes, all callers together: 10 a minute. The code has 80 bits; this keeps the log quiet. */
  readonly setupCodeLimiter = new SlidingWindowLimiter({ max: 10, windowMs: 60_000 });
  keystore?: KeystoreFile;
  identity?: GuardianIdentity;
  rpc?: RpcServer;
  dm?: DirectMessages;
  inbox?: Inbox;

  /**
   * Sealed unlock (PROTOCOL.md, "Sealed unlock"): the key pair the phone seals `guardian.unlock`'s secret (while locked)
   * and `unlock.hardware.add`'s signature (while unlocked) to. In memory only, never written; a new one at start, at
   * every lock and every unlock, after every counted failed unlock and after every add that used it; zeroed at stop.
   */
  readonly unlockKey = new UnlockKeyHolder();

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

  /** The chain source in use (chain/source.ts): the environment's, or the owner's choice from the web UI. */
  chainSource?: ChainSource;
  /** Where `chainSource` came from. */
  chainSourceOrigin: 'environment' | 'settings' = 'environment';
  private readonly chainSourceStore: ChainSourceStore;
  private readonly chainMutex = new Mutex();

  private envElectrumSource(): ChainSource | undefined {
    const e = this.opts.config.electrum;
    return e ? { kind: 'electrum', host: e.host, port: e.port, tls: !!e.tls, ...(e.certSha256 ? { certSha256: e.certSha256 } : {}), ...(e.allowPublicPlaintext ? { allowPublicPlaintext: true } : {}) } : undefined;
  }

  /** The chain source the environment sets (CHAIN_SOURCE, ELECTRUM_*: Umbrel, StartOS, `.env`), whatever is in use. */
  get environmentChainSource(): ChainSource | undefined {
    return this.opts.config.chainSource ?? this.envElectrumSource();
  }

  /** The backend for a chain source, with this guardian's network, log and wallet birthdays. */
  private makeBackend(source: ChainSource, probe: boolean): ChainBackend {
    if (this.opts.chainBackend) return this.opts.chainBackend(source, { probe });
    const src: ChainSource = source.kind === 'core' && !source.wallet && this.opts.config.coreWallet ? { ...source, wallet: this.opts.config.coreWallet } : source;
    return buildBackend(src, {
      network: this.opts.config.network,
      log: this.log,
      electrum: this.opts.electrum,
      probe,
      core: { birthday: (w) => this.walletBirthday(w.fingerprint()), defaultBirthday: () => 0 },
    });
  }

  /**
   * When a wallet's coins can start (unix seconds), for Bitcoin Core's rescan: a wallet with this guardian's key 3 cannot
   * be older than the setup; Savings not older than the phone's registration of it. Others (a replaced wallet, the
   * helper account): unknown, a full rescan.
   */
  private walletBirthday(fingerprint: string): number | undefined {
    const setupAt = this.service?.get().setupAt;
    const mine = new Set([this.engine?.registration()?.walletId, ...(this.engine?.retiredWallets().map((r) => r.registration.walletId) ?? [])]);
    for (const w of this.wallets?.all ?? []) {
      const reg = w.engine.registration();
      if (reg && reg.walletId === fingerprint) return Math.floor(w.record.addedAt / 1000);
    }
    if (setupAt !== undefined && mine.has(fingerprint)) return Math.floor(setupAt / 1000);
    const sv = this.engine?.savings();
    if (sv && sv.walletId === fingerprint) return Math.floor(sv.since / 1000);
    return undefined;
  }

  private constructor(opts: GuardianOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? silentLogger;
    // Security review 2026-11, finding 3: other containers on an Umbrel or a Start9 reach the port without the
    // platform's login, so the setup code is asked for everywhere (except through the login proxy: trustedProxy).
    if (opts.config.platform) this.setupCode = new SetupCode(undefined, opts.config.setupCode);
    if (opts.config.trustedProxies?.length) this.trustedProxy = new TrustedProxy(opts.config.trustedProxies, { log: this.log });
    const rpc = opts.config.bitcoinRpc ? new BitcoinRpc(opts.config.bitcoinRpc, { allowPublic: opts.config.bitcoinRpc.allowPublic }) : undefined;
    // The environment's choice; `open` swaps in the web UI's, if the owner made one (chain-source.json).
    this.chainSource = this.environmentChainSource;
    this.chainSourceStore = new ChainSourceStore(opts.config.dataDir);
    this.chain = new ChainService({
      backend: this.chainSource ? this.makeBackend(this.chainSource, false) : undefined,
      rpc,
      log: this.log,
      liveMaxScripts: opts.liveMaxScripts,
      ...(opts.slowPingMs !== undefined ? { slowPingMs: opts.slowPingMs } : {}),
      // The owner's payments relayed here, until the chain source shows them (chain/relayed.ts).
      relayed: new RelayedTxs({ dir: opts.config.dataDir, now: () => this.clock.now() }),
      now: () => this.clock.now(),
    });
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
    this.alerts = new Alerter(this, this);
    this.recovery = new RecoveryRunner(this, this);
    this.savingsWatch = new SavingsMonitor(this, this, opts.savingsScanIntervalMs);
    this.hosting = new Hosting(this);
    this.wallets = new OwnWallets(this);
    this.labels = new LabelsVault(opts.config.dataDir, () => this.clock.now(), opts.labelsUploadLimit);
    this.unlockSlots = new UnlockSlots(join(opts.config.dataDir, UNLOCK_SLOTS_FILE));
    if (opts.liveWallet !== false) {
      this.live = new LiveWallet(this, opts.liveWallet ?? {});
      this.features.push(GUARDIAN_FEATURES.liveWallet);
    }
    this.notifier = new Notifier({
      dataDir: opts.config.dataDir,
      now: () => this.clock.now(),
      log: this.log,
      logEvent: (e) => this.logEvent(e),
      // Every wallet's alert contacts (own wallets too: docs/design/multi-wallet.md).
      contacts: () => [...new Set([...(this.engine?.status().rules?.alertContacts ?? []), ...(this.wallets?.active().flatMap((w) => w.engine.status().rules?.alertContacts ?? []) ?? [])])],
      net: opts.notify?.net,
      smtpTest: opts.notify?.smtpTest,
      telegramApi: opts.notify?.telegramApi,
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
    g.engine = await PolicyEngine.open({ store: g.store, clock: g.clock, chain: g.engineChain });
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
    // Guests' slots: nothing to load without hosting.json (every guardian before family hosting).
    await g.hosting.load();
    // The owner's own wallets: nothing to load without wallets.json (every guardian before them).
    await g.wallets.load();
    await g.notifier.load();
    await g.live?.load();
    const stored = await g.chainSourceStore.load();
    if (stored) {
      g.chainSource = stored;
      g.chainSourceOrigin = 'settings';
      g.chain.setBackend(g.makeBackend(stored, false));
    }
    await g.chain.relayed.load();
    // Unlock slots: bound to this keystore (a file left by a reset that crashed half-way is dropped), and only for the
    // wallets the box guards now (a retirement or recovery that stopped before it deleted them).
    const slots = await g.unlockSlots.load(g.keystore ? keystoreBinding(g.keystore) : undefined);
    if (slots === 'stale') g.log.warn('unlock_slots.stale_dropped', {});
    if (slots === 'unreadable') g.log.error('unlock_slots.unreadable', { file: UNLOCK_SLOTS_FILE });
    await g.pruneUnlockSlots();
    g.lockedAt = g.clock.now();
    g.lockReason = 'restart';
    // Locked from the start: the first unlock key (memory only; the phone reads it in `guardian.status`).
    g.unlockKey.rotate();
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
  features: string[] = [
    GUARDIAN_FEATURES.limitOff,
    GUARDIAN_FEATURES.contactLock,
    GUARDIAN_FEATURES.savings,
    GUARDIAN_FEATURES.notifications,
    GUARDIAN_FEATURES.shortWraps,
    GUARDIAN_FEATURES.ownWallets,
    GUARDIAN_FEATURES.ownWallets2,
    GUARDIAN_FEATURES.labelsBackup,
    GUARDIAN_FEATURES.hardwareUnlock,
    GUARDIAN_FEATURES.sealedUnlock,
    GUARDIAN_FEATURES.passphraseChange,
  ];

  /** The wallet object of a registration or a watched wallet (cached per descriptor). */
  walletOf(w: { descriptor: string; network: NetworkName }): MultisigWallet {
    return walletOf(w);
  }

  /** The wallet object of the watched Savings wallet. */
  savingsWalletOf(sv: SavingsWatch): MultisigWallet {
    return savingsWallet(sv);
  }

  /** The phone's registered helper account (single-key coins), if any. */
  helperWallet(): AddressSource | undefined {
    const reg = this.engine.registration();
    const helper = this.engine.singleKey()?.helper;
    return reg && helper ? helperAccount(helper.xpub, reg.network) : undefined;
  }

  /** The scripts of the phone's registered single-key coins and silent payment matches. */
  singleKeyScripts(): Uint8Array[] {
    if (!this.engine.registration()) return [];
    const scripts = new Set<string>(this.sp.matchScripts().values());
    for (const c of this.engine.singleKey()?.coins ?? []) scripts.add(c.script);
    return [...scripts].map((x) => hex.decode(x));
  }

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

  /** The first wallet's co-signed sweeps (and paired phone record) are in `service.json`, as always. */
  get sweepStore(): ServiceState {
    return this.service;
  }

  /** The first wallet's name in alerts once the box has several wallets (`wallet.add`'s `firstName`). */
  label(): string | undefined {
    return this.wallets.firstLabel();
  }

  /** Alerts about the first wallet carry no `walletId`: as before own wallets. */
  alertWalletId(): string | undefined {
    return undefined;
  }

  /** An entry in the box's Activity log; `wallet`: the own wallet it is about (by name), once the box has several. */
  async logEvent(event: ServiceEvent, wallet?: string): Promise<void> {
    try {
      await this.service.log(this.clock.now(), event, wallet);
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
        headerlessClient: async (remote) => isLoopback(remote) || !!(await this.trustedProxy?.trusts(remote)),
      });
    }
    this.chain.start();
    this.chain.onTip(() => void this.tick());
    this.live?.start();
    if (!this.setupComplete && this.setupCode) {
      // Deliberately in the log (the one place only the box's owner reads): http/setup-code.ts.
      const hint =
        this.config.platform === 'umbrel'
          ? 'If the web UI asks for a setup code, enter this one. It changes at every restart.'
          : this.config.setupCode
            ? 'Open the web UI and enter this setup code to set up the guardian (StartOS also shows it under Actions > Show Setup Code).'
            : 'Open the web UI and enter this setup code to set up the guardian. It changes at every restart.';
      this.log.info('setup.code', { code: this.setupCode.code, hint });
    }
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
    this.live?.stop();
    await this.live?.idle().catch(() => undefined);
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
    this.unlockKey.wipe();
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
    this.simplePool = createSimplePool({ enablePing: true });
    // The pool subscribes again by itself on a relay that dropped (a relay restart, a network change).
    this.pool = new SimplePoolRelayPool({
      pool: this.simplePool,
      // The first try after a drop is worth a line; a relay that stays down retries every 30 s.
      onResubscribe: (r) => (r.attempt === 1 ? this.log.info : this.log.debug).call(this.log, 'nostr.resubscribe', { relay: r.relay, reason: r.reason, attempt: r.attempt, inMs: r.delayMs }),
    });
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
      seen: new SeenWraps({
        storage: seenWrapsFile(this.path('seenWraps')),
        now: () => this.nowSec(),
        onError: (e) => this.log.warn('inbox.seen_wraps_failed', { error: errorText(e) }),
      }),
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
    // Guests' phones, recovery peers, contacts and invitees (hosting/service.ts); undefined leaves it to the host's rules.
    const hosted = this.hosting.authorize(sender, method);
    if (hosted !== undefined) return hosted;
    if (this.authorizeHost(sender, method)) return true;
    // The owner's own wallets (wallets/service.ts): their phones, recovery peers and contacts.
    return this.wallets.authorize(sender, method) ?? false;
  }

  /** Forgets `pubkey` as an RPC peer unless it is still a wallet's phone (the box's phones are shared by its wallets). */
  dropPeerIfUnused(pubkey: string): void {
    if (this.engine.registration()?.appNostrPubkey === pubkey) return;
    if (this.wallets.active().some((w) => w.phone() === pubkey)) return;
    this.rpc?.removePeer(pubkey);
  }

  /**
   * Key 3 of an own wallet (docs/design/multi-wallet.md): the first pairing's key 3 seed (its `key3Mix`, or the setup
   * seed for a pairing without the phone's entropy) at BIP 48 `account`. Needs the guardian unlocked. The caller wipes
   * `signer`.
   */
  ownKey3(first: { key3Mix?: Key3Mix }, account: number): { signer: KeystoreSigner; pub: CosignerPublic } {
    const seed = this.seed;
    if (!seed || seed.wiped || this.locked) throw new Error('the guardian is locked');
    return seed.key3(this.config.network, first.key3Mix, account);
  }

  /** The host's own rules, exactly as before family hosting. */
  authorizeHost(sender: string, method: MethodName): boolean {
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
    return (!!reg && sender === reg.appNostrPubkey) || this.isAlertContact(sender) || this.hasRecoveryAccess(sender) || this.hosting.isKnownSender(sender) || this.wallets.isKnownSender(sender);
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
    // Guests' phones too: they reach this box over the same relays.
    const to = new Set([
      ...(reg ? [reg.appNostrPubkey] : []),
      ...this.recoveryPeers(),
      ...this.hosting.phones(),
      ...this.wallets.active().flatMap((w) => [...(w.phone() ? [w.phone()!] : []), ...w.recoveryPeers()]),
    ]);
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
   * Queues an alert for the owner's own email, ntfy, webhook and Telegram channels (not the contacts'), the same words as the
   * phone's alert, and starts delivering in the background. Durable and retried like the engine's alerts.
   */
  notifyOwner(type: string, text: string, walletId?: string, id?: string): void {
    if (!this.notifier.configured) return;
    const at = this.clock.now();
    const ev: NotifyEvent = { id: id ?? `${type}-${at}`, type, at, owner: text, ...(walletId ? { walletId } : {}) };
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
    const r = await this.notifier.update(input, { recoveryRunning: !!this.activeRecord() || !!this.wallets.recoveryRunning() });
    if (r.ok && r.changed) {
      await this.notifyPhone({
        type: 'notifications_changed',
        ...this.stampNow(),
        message: "Your guardian's email, ntfy, Telegram or webhook alerts were changed in its web page. If you did not do this, check the guardian.",
      });
      this.notifier.kick();
    }
    return r;
  }

  /** "Send a test message" (`POST /api/notifications/test`). */
  testNotification(input: unknown): Promise<TestOutcome> {
    return this.notifier.test(input);
  }

  /** "Find" (`POST /api/notifications/telegram/find`): who sent `/start` to the Telegram bot lately. */
  findTelegramChats(): Promise<FindOutcome> {
    return this.notifier.findTelegramChats();
  }

  /** What the phone and the web UI are told about the chain source (no credential). */
  chainSourceSummary(): ChainSourceSummary | undefined {
    return this.chainSource ? summarize(this.chainSource) : undefined;
  }

  /**
   * Settings > Server (`PUT /api/chain`): switches the chain source. Security-relevant (a public server sees the
   * wallets' addresses and could hide coins), so every change is logged in Activity and announced to the paired phone
   * (`chain_source_changed`), the owner's channels and the alert contacts' channels. While a recovery runs, switching
   * to a public server is refused: the recovery's own checks (spends elsewhere, the sweep's confirmations) must not
   * rest on a stranger's server. Switching to the owner's own node is always allowed. With family hosting, a guest
   * wallet's recovery counts as running too, and guests' phones are told in their own words (never on the host's
   * channels, never naming the host's own node: `Hosting.announceChainSource`).
   */
  changeChainSource(input: unknown): Promise<ChainSourceOutcome> {
    return this.chainMutex.run(async (): Promise<ChainSourceOutcome> => {
      if (!this.setupComplete) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      let next: ChainSource;
      try {
        next = parseChainSource(input, this.chainSource, this.opts.config.bitcoinRpc);
      } catch (e) {
        if (e instanceof ChainSourceError) return { ok: false, code: 'invalid', message: e.message };
        throw e;
      }
      if (next.kind === 'public' && this.recoveryBlocksPublicSource()) return { ok: false, code: 'recovery_pending', message: RECOVERY_BLOCKS_PUBLIC };
      // The source in use again (saved twice, or the form left as it was): nothing to log, announce or pin.
      if (this.chainSource && sameChainSource(this.chainSource, next)) return { ok: true, changed: false };
      await this.chainSourceStore.save(next, this.clock.now());
      this.chainSourceOrigin = 'settings';
      await this.switchChainSource(next);
      return { ok: true, changed: true };
    });
  }

  /**
   * "Use the server Umbrel set" (`DELETE /api/chain`): forgets the owner's choice (chain-source.json) and goes back to
   * the environment's source, which the guardian then follows again (Umbrel, StartOS or `.env` may change it). The same
   * rules as a change: announced and logged when the server changes, a public one refused while a recovery runs (the
   * environment's own node is always allowed). `not_found` when the environment sets no source to go back to.
   */
  useEnvironmentChainSource(): Promise<ChainSourceOutcome> {
    return this.chainMutex.run(async (): Promise<ChainSourceOutcome> => {
      if (!this.setupComplete) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (this.chainSourceOrigin === 'environment') return { ok: true, changed: false };
      const env = this.environmentChainSource;
      if (!env) return { ok: false, code: 'not_found', message: 'The guardian was started without a server of its own: there is no other setting to go back to.' };
      if (env.kind === 'public' && this.recoveryBlocksPublicSource()) return { ok: false, code: 'recovery_pending', message: RECOVERY_BLOCKS_PUBLIC };
      await this.chainSourceStore.remove();
      this.chainSourceOrigin = 'environment';
      // The same server as the one chosen here: the guardian follows the environment again, nothing else changes.
      if (this.chainSource && sameChainSource(this.chainSource, env)) {
        this.chainSource = env;
        return { ok: true, changed: false };
      }
      await this.switchChainSource(env, this.config.platform ?? 'docker');
      return { ok: true, changed: true };
    });
  }

  /** A recovery is running, the host's or a guest wallet's (hosting/recovery.ts checks its coins on this chain source). */
  recoveryBlocksPublicSource(): boolean {
    return !!this.activeRecord() || this.hosting.recoveryRunning() || !!this.wallets.recoveryRunning();
  }

  /** Switches to `next` and announces it: Activity, the phone, the owner's and the contacts' channels, guests' phones. */
  private async switchChainSource(next: ChainSource, backTo?: NonNullable<GuardianConfig['platform']>): Promise<void> {
    const before = this.chainSource;
    this.chainSource = next;
    this.chain.setBackend(this.makeBackend(next, false));
    const from = before ? summarize(before) : undefined;
    const to = summarize(next);
    await this.logEvent({
      type: 'chain_source_changed',
      ...(from ? { from: `${from.kind}:${from.backend}:${from.host}:${from.port}` } : {}),
      to: `${to.kind}:${to.backend}:${to.host}:${to.port}`,
      ...(backTo ? { backTo } : {}),
    });
    this.log.warn('chain.source_changed', { from: from ? `${from.backend}:${from.host}` : 'none', to: `${to.backend}:${to.host}`, public: to.kind === 'public', ...(backTo ? { environment: true } : {}) });
    const text =
      (backTo
        ? `Your guardian is back on ${environmentSourceName(backTo)}: it now reads the blockchain from ${describeSource(next)}${before ? ` (before: ${describeSource(before)})` : ''}.`
        : `Your guardian now reads the blockchain from ${describeSource(next)}${before ? ` (before: ${describeSource(before)})` : ''}.`) +
      (to.kind === 'public' ? ' A public server sees your wallet\'s addresses and could hide coins or delay confirmations; it cannot spend or change rules.' : '') +
      ' If you did not change this in the guardian\'s web page, check the guardian.';
    await this.notifyPhone({ type: 'chain_source_changed', kind: to.kind, backend: to.backend, host: to.host.slice(0, 255), ...this.stampNow(), message: text.slice(0, 500) });
    this.announceChainSource(text);
    // Guests' phones, in their own words; never through the host's channels above (hosting/service.ts).
    await this.hosting.announceChainSource(to);
  }

  /** The owner's channels and the alert contacts' channels (email, ntfy, webhook, Telegram), like a change of the alert channels. */
  private announceChainSource(text: string): void {
    if (!this.notifier.configured) return;
    const at = this.clock.now();
    const ev: NotifyEvent = {
      id: `chain_source_changed-${at}`,
      type: 'chain_source_changed',
      at,
      owner: text,
      contacts: { text: () => `The guardian of a Trikey wallet you are an alert contact for changed where it reads the blockchain: ${text.replace(/^Your guardian now reads/, 'it now reads').replace(/^Your guardian is back/, 'it is back')}` },
    };
    void this.notifier
      .enqueue(ev)
      .then((queued) => queued && this.notifier.kick())
      .catch((e: unknown) => this.log.error('notify.enqueue_failed', { type: ev.type, error: errorText(e) }));
  }

  /**
   * "Test connection" (`POST /api/chain/test`): connects to a server the owner is about to choose and says what it found,
   * without switching to it or keeping anything (Bitcoin Core: version and network only, no wallet).
   */
  async testChainSource(input: unknown, timeoutMs = 10_000): Promise<ChainTestOutcome> {
    let source: ChainSource;
    try {
      source = parseChainSource(input, this.chainSource, this.opts.config.bitcoinRpc);
    } catch (e) {
      if (e instanceof ChainSourceError) return { ok: false, error: e.message };
      throw e;
    }
    const backend = this.makeBackend(source, true);
    backend.start();
    const started = Date.now();
    try {
      // Connected, or a clear failure (given a second for a slow handshake), or the timeout.
      for (;;) {
        if (backend.connected) {
          if (backend.kind === 'electrum') await backend.waitReady(Math.max(1, timeoutMs - (Date.now() - started)));
          return { ok: true, ...(backend.serverVersion ? { server: backend.serverVersion } : {}), ...(backend.tip ? { height: backend.tip.height } : {}) };
        }
        const elapsed = Date.now() - started;
        if ((backend.lastError && elapsed > 1000) || elapsed > timeoutMs) return { ok: false, error: backend.lastError ?? 'no answer in time' };
        await new Promise((r) => setTimeout(r, 25));
      }
    } catch (e) {
      return { ok: false, error: backend.lastError ?? errorText(e) };
    } finally {
      backend.stop();
    }
  }

  /** For Settings > Server: the rescans Bitcoin Core is running for the guardian's wallets. */
  get chainRescans(): { since: number; birthday: number }[] {
    const b = this.chain.backend;
    return b instanceof CoreBackend ? b.rescans : [];
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
      this.notifyOwner('wallet_adopted', labelled(this, `The guardian now protects the wallet recovery ${recoveryId} moved the funds to (${adopted.walletId}).`), adopted.walletId);
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
    await this.pruneLabels(this);
    // The phone that was paired to the swept wallet and is not the new wallet's phone (a lost phone's
    // successor, or no successor at all) is told the wallet is gone from here, and stops being a peer.
    if (previousPhone && previousPhone !== adopted?.appNostrPubkey) {
      this.dropPeerIfUnused(previousPhone);
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

  /**
   * Deletes the encrypted notes `w` keeps for wallets outside the line it guards now (labels.ts `labelLine`): after a
   * retirement every copy of it, after a recovery to another guardian the swept wallet's. Best effort: a failure is
   * logged, and the next retirement or rotation tries again.
   */
  async pruneLabels(w: WalletRuntime): Promise<void> {
    try {
      const gone = await this.labels.deleteIds(strayLabelIds(w.engine));
      if (gone.length) {
        this.log.info('labels.deleted', { walletIds: gone.join(','), reason: 'retired' });
        await w.logEvent({ type: 'labels_deleted', walletIds: gone, by: 'retired' });
      }
    } catch (e) {
      this.log.error('labels.delete_failed', { error: errorText(e) });
    }
    // Every place a wallet leaves (retired, swept to another wallet) comes here: its unlock slot goes too.
    await this.pruneUnlockSlots(w);
  }

  /**
   * Deletes the unlock slots of wallets the box no longer guards (unlock-slots.ts): a retired wallet, a wallet a recovery
   * swept (the adopted wallet turns it on again with its own hardware wallet: a lost or stolen device must not keep
   * unlocking), an own wallet removed. Best effort: a failure is logged, and the next start tries again.
   */
  async pruneUnlockSlots(w: WalletRuntime = this): Promise<void> {
    try {
      const gone = await this.unlockSlots.prune(this.guardedWalletIds());
      if (gone.length) {
        this.log.info('unlock_slots.removed', { walletIds: gone.join(','), reason: 'retired' });
        await w.logEvent({ type: 'unlock_slot_removed', walletIds: gone, by: 'retired' });
      }
    } catch (e) {
      this.log.error('unlock_slots.remove_failed', { error: errorText(e) });
    }
  }

  /** The wallet ids the box guards now for its owner: the first wallet's and every active own wallet's. Never a guest's. */
  guardedWalletIds(): string[] {
    return [this.engine.registration()?.walletId, ...this.wallets.active().map((w) => w.engine.registration()?.walletId)].filter((x): x is string => !!x);
  }

  /** The owner's wallet (the first or an own wallet) that guards `walletId` now, with its registration. Never a guest's. */
  private guardedWallet(walletId: string): { w: WalletRuntime; reg: NonNullable<ReturnType<PolicyEngine['registration']>> } | undefined {
    const first = this.engine.registration();
    if (first?.walletId === walletId) return { w: this, reg: first };
    const own = this.wallets.active().find((w) => w.engine.registration()?.walletId === walletId);
    const reg = own?.engine.registration();
    return own && reg ? { w: own, reg } : undefined;
  }

  /** `guardian.status.hardwareUnlock` of `walletId`. */
  hardwareUnlockOf(walletId: string | undefined): { slot: string; addedAt: number } | undefined {
    if (!walletId || !this.features.includes(GUARDIAN_FEATURES.hardwareUnlock)) return undefined;
    const s = this.unlockSlots.get(walletId);
    return s ? { slot: s.slot, addedAt: Math.floor(s.addedAt / 1000) } : undefined;
  }

  /** The text the hardware wallet of `walletId` signs for unlock slot `slot` (`@trikey/protocol` `unlockKeyMessage`). */
  private unlockText(walletId: string, slot: string): string {
    return unlockKeyMessage({ walletId, guardianPubkey: this.identity!.pubkey, network: this.config.network, slot });
  }

  /**
   * `unlock.hardware.add` (the paired phone of `w`, unlocked): checks the hardware wallet's signature of the slot's text
   * against the wallet's authorization key, encrypts the seed under the key it gives as an unlock slot (replacing the
   * wallet's earlier one), opens it once to be sure, and forgets the signature and the key.
   */
  addHardwareUnlock(
    w: WalletRuntime,
    input: { walletId: string; slot: string } & ({ signature: string } | { sealed: SealedUnlock }),
    ctx: { phone: string; id: string },
  ): Promise<HardwareUnlockAddOutcome> {
    return this.unlockMutex.run(async (): Promise<HardwareUnlockAddOutcome> => {
      const file = this.keystore;
      if (!file || !this.identity) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      const seed = this.seed;
      if (this.locked || !seed || seed.wiped) return { ok: false, code: 'locked', message: 'Unlock the guardian first: the seed is needed to add a way to unlock it.' };
      const reg = w.engine.registration();
      if (!reg) return { ok: false, code: 'not_registered', message: 'This wallet is not set up on this guardian.' };
      if (reg.walletId !== input.walletId)
        return { ok: false, code: 'wallet_changed', message: `This guardian guards wallet ${reg.walletId} now: sign the text for it.` };
      if (w.engine.status().hardwareConfirmRequired)
        return { ok: false, code: 'hardware_unconfirmed', message: 'Confirm your hardware wallet for this wallet first (after the recovery).' };
      // The signature: sealed to the guardian's current sealing key (PROTOCOL.md, "Sealed unlock"), or from an older phone
      // in the clear (accepted, and marked).
      let signature: string;
      const unsealed = !('sealed' in input) && this.sealsUnlocks;
      if ('sealed' in input) {
        const opened = this.unlockKey.open(input.sealed, { purpose: 'unlock.hardware.add', guardianPubkey: this.identity.pubkey, phonePubkey: ctx.phone, id: ctx.id, now: this.nowSec() });
        if (!opened.ok && opened.reason !== 'invalid') {
          this.log.info('guardian.unlock_key_stale', { reason: opened.reason, method: 'unlock.hardware.add' });
          return { ok: false, code: 'unlock_key_stale', message: "The guardian's sealing key changed (it restarted, locked or unlocked). Try again." };
        }
        // Used: whatever comes next, this key seals nothing more.
        this.unlockKey.rotate();
        const secret = opened.ok ? opened.secret : undefined;
        if (!secret || secret.kind !== 'hardware' || secret.walletId !== input.walletId || secret.slot !== input.slot) {
          this.log.warn('unlock_slots.bad_seal', { walletId: reg.walletId });
          return { ok: false, code: 'bad_seal', message: 'The guardian could not open that sealed signature.' };
        }
        signature = secret.signature;
      } else {
        signature = input.signature;
        if (unsealed) this.log.warn('guardian.unlock_unsealed', { method: 'unlock.hardware.add' });
      }
      if (!reg.hardwareAuth || !bip137Authorizer.verify(this.unlockText(reg.walletId, input.slot), signature, reg.hardwareAuth)) {
        this.log.warn('unlock_slots.bad_signature', { walletId: reg.walletId });
        return { ok: false, code: 'bad_signature', message: "That is not this wallet's hardware wallet's signature of the unlock text." };
      }
      const binding = keystoreBinding(file);
      const slot = seed.use((bytes) => sealSlot(bytes, signature, binding, { walletId: reg.walletId, slot: input.slot, addedAt: this.clock.now() }));
      // Opened once before it counts: a slot that would not open is never stored.
      openSlot(slot, signature, binding).fill(0);
      await this.unlockSlots.put(slot);
      this.log.info('unlock_slots.added', { walletId: reg.walletId, ...(unsealed ? { unsealed: true } : {}) });
      await w.logEvent({ type: 'unlock_slot_added', walletId: reg.walletId, ...(unsealed ? { unsealed: true as const } : {}) });
      return { ok: true, walletId: reg.walletId, slot: slot.slot, addedAt: slot.addedAt };
    });
  }

  /** `unlock.hardware.remove`: the paired phone turned it off. Locked or unlocked. */
  async removeHardwareUnlock(w: WalletRuntime, walletId: string): Promise<boolean> {
    const gone = await this.unlockSlots.remove([walletId]);
    if (!gone.length) return false;
    this.log.info('unlock_slots.removed', { walletIds: walletId, reason: 'phone' });
    await w.logEvent({ type: 'unlock_slot_removed', walletIds: gone, by: 'phone' });
    return true;
  }

  /** After `wallet.retire`: the retired wallet's phone is no longer a peer; tell it (best effort). */
  async afterRetire(walletId: string, phone: string): Promise<void> {
    await this.pruneLabels(this);
    this.dropPeerIfUnused(phone);
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
          await this.hosting.tick();
          // The owner's own wallets after the first: each its engine, recovery and alerts.
          await this.wallets.tick();
          // Before the alerts, so a Savings spend found now is announced in the same pass.
          await this.savingsWatch.run();
          await this.alerts.run();
          // `wallet_tx` alerts no relay took yet, and a first look at wallets new since the last pass.
          await this.live?.tick();
          // In the background: the relayed payments Bitcoin Core says are gone, and whether the server sees the mempool.
          void this.chain.checkMempool();
          // Email, ntfy, webhook, Telegram: in the background, so a slow mail server never holds back the tick.
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
      await this.unlockSlots.rebind(keystoreBinding(file));
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
    // Every guest slot's key 3, derived from the same seed and the slot's record.
    this.hosting.installSigners(seed);
    // Every own wallet's key 3: the first pairing's key 3 seed at the wallet's account.
    this.wallets.installSigners(seed);
    this.lockedAt = undefined;
    this.lockReason = undefined;
    this.lockedBy = undefined;
    // Unlocked: the key it was locked with goes (zeroed), so no seal made to it, the one that just unlocked included, can be
    // opened again. A new one serves `unlock.hardware.add` while unlocked.
    this.unlockKey.rotate();
  }

  private dropSigner(): void {
    this.hosting.dropSigners();
    this.wallets.dropSigners();
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

  /** Key 3 of a guest slot (`trikey/key3-hosted/v1`). Needs the guardian unlocked. The caller wipes `signer`. */
  hostedKey3(mix: HostedKey3Mix): { signer: KeystoreSigner; pub: CosignerPublic } {
    const seed = this.seed;
    if (!seed || seed.wiped || this.locked) throw new Error('the guardian is locked');
    return seed.hostedKey3(this.config.network, mix);
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
    // The phone holds every own wallet's phone key: a recovery of any of them it did not start keeps it from unlocking.
    const other = this.wallets.recoveryNotStartedBy(phone ?? this.wallets.active()[0]?.phone());
    if (other)
      return { ok: false, code: 'recovery_pending', message: `Recovery ${other.id} of "${other.wallet.name}" is running. The phone cannot unlock the guardian meanwhile; unlock it in its web UI.` };
    return undefined;
  }

  /**
   * Unlock with the passphrase (web UI or `guardian.unlock`). Rate limited; the passphrase is never logged. From the phone
   * on a guardian that seals unlocks, this is an older app's unsealed passphrase: accepted, and marked in the Activity.
   */
  unlock(passphrase: unknown, via: 'web' | 'phone'): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (!this.locked) return { ok: true };
      return this.passphraseAttempt(file, passphrase, via, { unsealed: via === 'phone' && this.sealsUnlocks });
    });
  }

  /** The passphrase checked and tried (inside the unlock mutex, locked). */
  private passphraseAttempt(file: KeystoreFile, passphrase: unknown, via: 'web' | 'phone', how: AttemptHow): Promise<UnlockOutcome> {
    if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4 * MAX_PASSPHRASE_LENGTH)
      return Promise.resolve({ ok: false, code: 'invalid', message: 'Enter the unlock passphrase.' });
    return this.unlockAttempt(file, via, how, () => unlockKeystoreSeed(file, passphrase));
  }

  /**
   * Unlock with the hardware wallet (`guardian.unlock` with `kind: "hardware"`, from the phone): the signature of the
   * slot's text must verify against `walletId`'s authorization key and open its slot. The phone's throttle and refusals,
   * exactly as for the passphrase; a signature that does not open it counts as a wrong passphrase would. The signature
   * and the key are never logged or kept.
   */
  unlockWithHardware(input: { walletId: string; slot: string; signature: string }): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file || !this.identity) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (!this.locked) return { ok: true };
      return this.hardwareAttempt(file, input, { unsealed: this.sealsUnlocks });
    });
  }

  /** The hardware wallet's signature checked and tried (inside the unlock mutex, locked). */
  private hardwareAttempt(file: KeystoreFile, input: { walletId: string; slot: string; signature: string }, how: AttemptHow): Promise<UnlockOutcome> {
    const slot = this.unlockSlots.get(input.walletId);
    const target = this.guardedWallet(input.walletId);
    // Nothing to open (turned off, or on again with another slot id): not a guess, so not counted.
    if (!slot || !target || slot.slot !== input.slot || !target.reg.hardwareAuthConfirmed)
      return Promise.resolve({ ok: false, code: 'hardware_unlock_off', message: 'Unlocking with this hardware wallet is not on for this wallet (any more). Use the passphrase.' });
    const binding = keystoreBinding(file);
    return this.unlockAttempt(file, 'phone', { ...how, hardwareOf: input.walletId }, async () => {
      const auth = target.reg.hardwareAuth;
      if (!auth || !bip137Authorizer.verify(this.unlockText(input.walletId, input.slot), input.signature, auth)) throw new BadPassphraseError();
      let bytes: Uint8Array;
      try {
        bytes = openSlot(slot, input.signature, binding);
      } catch (e) {
        if (e instanceof DamagedSlotError) this.log.error('unlock_slots.damaged', { walletId: input.walletId });
        if (e instanceof WrongSlotKeyError || e instanceof DamagedSlotError) throw new BadPassphraseError();
        throw e;
      }
      try {
        return guardianSeedOf(file, bytes);
      } finally {
        bytes.fill(0);
      }
    });
  }

  /** True while this guardian lists `sealed_unlock` (tests clear it to play a guardian from before it). */
  get sealsUnlocks(): boolean {
    return this.features.includes(GUARDIAN_FEATURES.sealedUnlock);
  }

  /**
   * The sealing key's public half for `guardian.status` (once set up, and sealing). Set up without one cannot happen (start
   * and every lock and unlock make one); if it ever did, one is made here rather than leaving the phone without a key.
   */
  currentUnlockKey(): string | undefined {
    if (!this.sealsUnlocks || !this.keystore) return undefined;
    return this.unlockKey.pubkey ?? this.unlockKey.rotate();
  }

  /**
   * A sealed unlock from the phone (`guardian.unlock` with `kind: "sealed"`; PROTOCOL.md, "Sealed unlock"): opened with
   * the unlock key the guardian made when it locked, checked to name this guardian, this sender (`phone`), this request
   * (`id`) and an expiry still ahead, then tried exactly as the passphrase or the hardware signature it holds, with the
   * same throttle and refusals.
   *
   * - Sealed to a key the guardian no longer holds, or expired: `unlock_key_stale`, not counted (nothing was tried; a
   *   relay's replay of an old seal lands here too, when the replay guard has not already dropped it).
   * - Sealed to the current key but it does not open, or names another guardian, phone or request: `bad_seal`, counted
   *   as a wrong passphrase. Only the paired phone's own wraps reach this method (the RPC server drops everyone else's,
   *   and a relay cannot forge the phone's seal), so a third party cannot burn the owner's tries with it: the phone could
   *   already do as much with wrong passphrases.
   * - After every counted failure the key is replaced, so a seal made to it (a near-miss passphrase) cannot be opened
   *   later even by someone reading the guardian's memory. The phone reads the new key from `guardian.status`.
   */
  unlockSealed(sealed: SealedUnlock, ctx: { phone: string; id: string }): Promise<UnlockOutcome> {
    return this.unlockMutex.run(async (): Promise<UnlockOutcome> => {
      const file = this.keystore;
      if (!file || !this.identity) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      if (!this.locked) return { ok: true };
      const opened = this.unlockKey.open(sealed, { purpose: 'guardian.unlock', guardianPubkey: this.identity.pubkey, phonePubkey: ctx.phone, id: ctx.id, now: this.nowSec() });
      if (!opened.ok && opened.reason !== 'invalid') {
        this.log.info('guardian.unlock_key_stale', { reason: opened.reason });
        return {
          ok: false,
          code: 'unlock_key_stale',
          message: opened.reason === 'expired' ? 'That unlock request expired. Try again.' : "The guardian's unlock key changed (it restarted or locked again). Try again.",
        };
      }
      let r: UnlockOutcome;
      if (!opened.ok) {
        r = await this.unlockAttempt(file, 'phone', { badSeal: true }, () => Promise.reject(new BadPassphraseError()));
      } else {
        const secret: UnlockSecret = opened.secret;
        r = secret.kind === 'passphrase' ? await this.passphraseAttempt(file, secret.passphrase, 'phone', { sealed: true }) : await this.hardwareAttempt(file, secret, { sealed: true });
      }
      if (!r.ok && (r.code === 'bad_passphrase' || r.code === 'bad_hardware' || r.code === 'bad_seal')) this.unlockKey.rotate();
      return r;
    });
  }

  /**
   * One unlock attempt (inside the unlock mutex, the guardian locked): the phone's refusals, the throttle of `via`, then
   * `open`, which throws `BadPassphraseError` for a wrong passphrase or signature. `how.hardwareOf`: the wallet whose
   * hardware wallet's signature `open` tries (the passphrase otherwise); `how.badSeal`: a seal that did not open (`open`
   * only fails); `how.unsealed`: an older phone's secret in the clear on a guardian that seals. For the log and Activity.
   */
  private async unlockAttempt(file: KeystoreFile, via: 'web' | 'phone', how: AttemptHow, open: () => Promise<GuardianSeed>): Promise<UnlockOutcome> {
    const what = {
      ...(how.hardwareOf ? { method: 'hardware' as const, walletId: how.hardwareOf } : {}),
      ...(how.badSeal ? { unreadable: true as const } : {}),
      ...(how.unsealed ? { unsealed: true as const } : {}),
    };
    if (via === 'phone') {
      const refusal = this.phoneUnlockRefusal();
      if (refusal) {
        this.log.warn('guardian.phone_unlock_refused', { code: 'code' in refusal ? refusal.code : undefined, ...what });
        return refusal;
      }
    }
    const throttle = via === 'web' ? this.throttle : this.phoneThrottle;
    const verdict = throttle.check();
    if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
    // An older app sent the secret in the clear to a guardian that seals: it works, and the owner is told to update.
    if (how.unsealed) this.log.warn('guardian.unlock_unsealed', { method: how.hardwareOf ? 'hardware' : 'passphrase' });
    await throttle.begin();
    let seed: GuardianSeed;
    try {
      seed = await open();
    } catch (e) {
      if (!(e instanceof BadPassphraseError)) throw e;
      this.log.warn('guardian.unlock_failed', { via, failures: throttle.failures, ...what });
      await this.logEvent({ type: 'unlock_failed', via, ...what });
      const next = throttle.check();
      return { ok: false, code: how.badSeal ? 'bad_seal' : how.hardwareOf ? 'bad_hardware' : 'bad_passphrase', retryAfterSeconds: next.ok ? undefined : Math.ceil(next.retryAfterMs / 1000) };
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
    this.log.info('guardian.unlocked', { via, ...what, ...(how.sealed ? { sealed: true } : {}) });
    await this.logEvent({ type: 'unlocked', via, ...what });
    void this.tick();
    return { ok: true };
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
   * The web UI's "Change passphrase" (DESIGN.md, "Changing the passphrase"): only while unlocked, with the current
   * passphrase (through the web unlock's throttle, as an unlock) and a new one (`checkPassphrase`'s rules, as at setup).
   * The same seed is sealed again under the new passphrase, `createdAt` kept so every hardware unlock slot still opens,
   * checked to open to the seed this guardian holds, and swapped in atomically (keystore.ts `changeKeystorePassphrase`).
   * Then every web session ends (the route signs the browser that changed it in again), the Activity says so, and the
   * paired phone (`passphrase_changed`) and the owner's own channels are told. Neither passphrase is ever logged.
   *
   * Not from the phone: see DESIGN.md (a phone thief who saw the passphrase must not be able to lock the owner out of
   * the box, and the web page already needs the box's own login on Umbrel and Start9).
   */
  async changePassphrase(input: { passphrase?: unknown; newPassphrase?: unknown }): Promise<PassphraseChangeOutcome> {
    const outcome = await this.unlockMutex.run(async (): Promise<PassphraseChangeOutcome> => {
      const file = this.keystore;
      if (!file) return { ok: false, code: 'setup_required', message: 'Set up the guardian first.' };
      const held = this.seed;
      if (this.locked || !held || held.wiped) return { ok: false, code: 'locked', message: 'Unlock the guardian first.' };
      const current = input.passphrase;
      if (typeof current !== 'string' || current.length === 0 || current.length > 4 * MAX_PASSPHRASE_LENGTH)
        return { ok: false, code: 'invalid', message: 'Enter the current passphrase.' };
      const bad = checkPassphrase(input.newPassphrase);
      if (bad) return { ok: false, code: 'invalid', message: `New passphrase: ${bad}.` };
      const next = input.newPassphrase as string;
      if (current.normalize('NFKC') === next.normalize('NFKC'))
        return { ok: false, code: 'same_passphrase', message: 'The new passphrase is the same as the current one.' };

      const verdict = this.throttle.check();
      if (!verdict.ok) return { ok: false, code: 'rate_limited', retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) };
      await this.throttle.begin();
      let rekeyed: KeystoreFile;
      try {
        rekeyed = await changeKeystorePassphrase(this.path('keystore'), file, current, next, {
          kdf: this.config.kdf,
          expected: (seed) => held.use((mine) => sameSeed(mine, seed)),
          opened: () => this.throttle.succeeded(),
        });
      } catch (e) {
        if (e instanceof SamePassphraseError) return { ok: false, code: 'same_passphrase', message: 'The new passphrase is the same as the current one.' };
        if (!(e instanceof BadPassphraseError)) throw e;
        this.log.warn('guardian.passphrase_change_failed', { failures: this.throttle.failures });
        await this.logEvent({ type: 'passphrase_change_failed' });
        const after = this.throttle.check();
        return { ok: false, code: 'bad_passphrase', retryAfterSeconds: after.ok ? undefined : Math.ceil(after.retryAfterMs / 1000) };
      }
      this.keystore = rekeyed;
      // The passphrase also signs browsers in: every session made with the old one ends (the route signs this one in again).
      this.sessions.clear();
      this.log.warn('guardian.passphrase_changed');
      await this.logEvent({ type: 'passphrase_changed' });
      return { ok: true };
    });
    if (outcome.ok) {
      // A security event, like a relay or channel change made in the web page: the phone and the owner's own channels.
      await this.notifyPhone({ type: 'passphrase_changed', ...this.stampNow(), message: PASSPHRASE_CHANGED_TEXT });
      this.notifyOwner('passphrase_changed', PASSPHRASE_CHANGED_TEXT);
    }
    return outcome;
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
      this.unlockKey.rotate();
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
    // The wallets whose rules let this contact lock the box: the first (as before), and every own wallet that lists it.
    const lockers = (): WalletRuntime[] => [
      ...(this.engine.status().rules?.contactLock && (!this.wallets.active().length || this.isAlertContact(contact)) ? [this as WalletRuntime] : []),
      ...this.wallets.active().filter((w) => {
        const r = w.engine.status().rules;
        return !!r?.contactLock && r.alertContacts.includes(contact);
      }),
    ];
    let noted: WalletRuntime[] = [];
    const outcome = await this.unlockMutex.run(async (): Promise<ContactLockOutcome> => {
      const may = lockers();
      if (!may.length) return 'not_allowed';
      if (this.locked) return 'already_locked';
      for (const w of may) if ((await w.engine.noteContactLock(contact)).ok) noted.push(w);
      if (!noted.length) return 'not_allowed';
      this.dropSigner();
      this.pairing.invalidate();
      this.unlockKey.rotate();
      this.lockedAt = this.clock.now();
      this.lockReason = 'contact';
      this.lockedBy = contact;
      this.log.warn('guardian.locked', { reason: 'contact' });
      return 'locked';
    });
    // The paired phone and the other contacts learn it from the notice the engine queued.
    if (outcome === 'locked') for (const w of noted) void w.alerts.run();
    noted = [];
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
          const refuse = async (code: 'recovery_pending' | 'sweep_pending' | 'hosting_active', message: string): Promise<ResetOutcome> => {
            await this.logEvent({ type: 'reset_refused', detail: message });
            return { ok: false, code, message };
          };
          const running = this.activeRecord();
          if (running) return refuse('recovery_pending', `Recovery ${running.id} is running. It must be cancelled or completed before the guardian can be reset.`);
          // Reset forgets every own wallet too: not while one of them is being recovered or its sweep waits.
          const ownRunning = this.wallets.recoveryRunning();
          if (ownRunning) return refuse('recovery_pending', `Recovery ${ownRunning.id} of "${ownRunning.wallet.name}" is running. It must be cancelled or completed before the guardian can be reset.`);
          const ownUnsent = this.wallets.unsentSweep();
          if (ownUnsent) return refuse('sweep_pending', `The sweep of recovery ${ownUnsent.recoveryId} ("${ownUnsent.wallet.name}") has not been broadcast yet. Wait until it is.`);
          // A reset makes a new seed: every guest's key 3 would vanish (decision 9).
          const hosted = this.hosting.blocksReset();
          if (hosted)
            return refuse('hosting_active', `This box hosts a wallet for ${hosted.name}. Reset is refused while you host: use Stop hosting for each wallet first (they get 30 days to move).`);
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
            forgotten = [...res.forgotten, ...(await this.wallets.reset())];
            this.dropSigner();
            await this.service.update((d) => {
              d.phones = [];
              d.sweeps = [];
              d.recoveryPeers = [];
            });
            await this.sp.unregister('guardian reset');
            await this.labels.deleteAll();
            // Every unlock slot holds the old seed: gone before key 3 is (a crash in between leaves no slot, never a stale one).
            await this.unlockSlots.deleteAll();
            await replaceKeystore(this.path('keystore'), next);
            await this.unlockSlots.rebind(keystoreBinding(next));
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
