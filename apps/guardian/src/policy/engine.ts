/**
 * The guardian's policy engine: pure decisions over persisted state.
 *
 * No network, no relays, no chain access. The service layer authenticates
 * requests (nostr), feeds them in, broadcasts what comes out and sends the
 * alerts `dueAlerts()` lists. Time, storage and key 3 are injected.
 *
 * Every mutating call runs under one lock, works on a copy of the state and
 * persists it before returning, so a signature is never handed out for a
 * spend that was not durably recorded against the limit.
 *
 * Wallets: the engine guards ONE active wallet and keeps the ones it guarded
 * before as retired, read-only history (state version 2). A wallet leaves the
 * active slot in two ways, both "rotations":
 *   - a recovery swept it (`rotateAfterSweep`, once the sweep is on its way):
 *     when the destination keeps this guardian's key it becomes the active
 *     wallet, with the rules carried over, the recovering phone as its paired
 *     phone and its hardware authorization key unconfirmed until a fresh
 *     pairing proof (`confirmHardwareAuth`);
 *   - the phone and hardware wallet retire it (`retireWallet`, "Replace
 *     guardian"), after which pairing is open for a new wallet.
 * Nothing is ever signed or started for a retired wallet.
 *
 * The active wallet may also carry a WATCHED wallet: the one it replaced on another guardian, kept by
 * descriptor so the service can serve its coins and relay a sweep of them (`WatchedWallet`). It is not
 * guarded: no co-signing, no recovery, no approvals. It goes when the active wallet does.
 */
import { HDKey } from '@scure/bip32';
import { base64, hex } from '@scure/base';
import { MultisigWallet, Network, NetworkName, ROLES, Role, finalizePsbt, getNetwork } from '@trikey/core';
import { DueAlert, dueAlerts as computeDueAlerts, isKnownAlertId } from './alerts.js';
import {
  HardwareAction,
  HardwareAuthorizer,
  approvalMessage,
  bip137Authorizer,
  pairingMessage,
  proofId,
  recoveryAccessMessage,
} from './authorizer.js';
import { ChainTime, ChainTimeSource, Clock, DAY, HOUR, systemClock } from './clock.js';
import { CHANGE_WINDOW, MAX_SELF_INDEX, NO_HIGH_WATER, addCosignerSignatures, inspectPsbt, maxHighWater } from './inspect.js';
import { pruneSpends, splitOutflow, usageWith, windowUsage } from './limit.js';
import { isContactLockOn, isLimitOff, isNostrPubkey, normalizeRules, phoneMayApply } from './rules.js';
import { CosignerSigner } from './signer.js';
import { StateStore, deserializeState, serializeState } from './storage.js';
import {
  AccessGrant,
  ActivityEntry,
  ActivityEvent,
  CancelActor,
  CancelledBy,
  GuardedWallet,
  GuardianState,
  HardwareApproval,
  HardwareAuthKey,
  HighWater,
  LimitNotice,
  RecoveryDelayDays,
  RecoveryRecord,
  RecoveryStatus,
  Refusal,
  Registration,
  Result,
  RetiredWallet,
  Rules,
  SavingsWatch,
  SingleKeyRegistration,
  SurvivingRole,
  WatchedWallet,
  emptyState,
  type Key3Mix,
} from './types.js';
import { MAX_SINGLE_KEY_COINS, helperAccount, helperAccountPath, isP2TR, isP2WPKH, parseHelperXpub, samePath } from '../singlekey.js';

/** Shape check of a `Key3Mix` (the derivation itself lives in keystore.ts, outside the engine). */
function isKey3MixRecord(m: unknown): m is Key3Mix {
  const r = m as Key3Mix;
  return !!r && typeof r === 'object' && r.version === 1 && /^[0-9a-f]{64}$/.test(String(r.entropy)) && /^([0-9a-f]{2}){12,256}$/.test(String(r.context));
}

/** A hardware approval may be valid for at most this long from the moment the guardian checks it. */
export const MAX_APPROVAL_TTL_MS = 24 * HOUR;
export const DEFAULT_MAX_ACTIVITY = 5000;
/** Refusal entries kept, on top of `DEFAULT_MAX_ACTIVITY` other entries (`pruneActivity`). */
export const DEFAULT_MAX_REFUSALS = 1000;
/** Largest allowed jump in hardware sequence numbers (so one approval can't exhaust the space). */
export const MAX_SEQUENCE_STEP = 1000;
/** At most this many phones hold recovery access at once (the newest win). */
export const MAX_ACCESS_GRANTS = 8;
/**
 * How far the system clock may run ahead of the chain's median time past (which trails real time by
 * about an hour) before the engine stops co-signing: a clock pushed forward would otherwise open a
 * fresh 24 h limit window with every step. Also the most the limit's monotonic time can jump ahead.
 */
export const MAX_CLOCK_AHEAD_OF_CHAIN_MS = 3 * HOUR;
/**
 * Blocks a recovery's delay must also span, per day of delay: a clock AND a median time past that both
 * claim the delay is over are not enough without the blocks to match. 144 on public networks (one per
 * 10 minutes); on regtest, where blocks are mined on demand, one per day.
 */
export const BLOCKS_PER_DAY: Record<NetworkName, number> = { bitcoin: 144, testnet: 144, signet: 144, regtest: 1 };
/** Mainnet policies must name an alert contact (it may be the owner's own nostr app on another device). */
export const MAINNET_CONTACT_REQUIRED =
  'on mainnet at least one alert contact is required (it can be your own nostr app on another device), so a recovery is never announced only to a phone a thief may hold';

/** Why pairing refuses a policy with no daily limit. */
export const LIMIT_OFF_AT_PAIRING = 'a wallet cannot be paired with the daily limit off; pair with a limit, then turn it off with the hardware wallet';
/** How long a `limit_off` / `limit_on` notice is retried for someone it has not reached (the alerts' TTL). */
export const NOTICE_TTL_MS = 7 * DAY;
/** Notices kept (the oldest dropped first). */
const MAX_NOTICES = 32;
/** Savings spends remembered as seen (`SavingsWatch.seenSpends`): more than one scan's history ever lists. */
const MAX_SAVINGS_SPENDS = 500;

/** Weak spots of a policy the phone and the web UI should show. */
export type PolicyWarning = 'no_alert_contacts';

export function policyWarnings(rules: Rules | undefined): PolicyWarning[] {
  return rules && !rules.alertContacts.length ? ['no_alert_contacts'] : [];
}

export interface PolicyEngineOptions {
  store: StateStore;
  clock?: Clock;
  /**
   * The chain's height and median time past (the service: Electrs). Without one (or while it fails)
   * the engine refuses to start or complete a recovery, and to co-sign once its last observation of the
   * chain is more than `MAX_CLOCK_AHEAD_OF_CHAIN_MS` behind the clock.
   */
  chain?: ChainTimeSource;
  /** Override `BLOCKS_PER_DAY` (tests). */
  blocksPerDay?: number;
  /** Key 3. Absent while the guardian is locked. */
  signer?: CosignerSigner;
  /** Hardware authorization mechanisms; defaults to BIP137 signmessage. */
  authorizers?: HardwareAuthorizer[];
  /** Activity entries kept, refusals not counted (oldest dropped first). */
  maxActivity?: number;
  /** Refusal entries kept, in their own bucket (oldest dropped first). */
  maxRefusals?: number;
}

export interface RegisterInput {
  network: NetworkName;
  /** wsh(sortedmulti(2, app, hardware, cosigner)) with keys in that order. */
  descriptor: string;
  /** Hex of the cosigner account pubkey the descriptor must contain in its cosigner slot. */
  cosignerAccountPubkey: string;
  rules: Rules;
  hardwareAuth: HardwareAuthKey;
  /** Proof (BIP137 signature) over `pairingMessage(walletId, cosignerAccountPubkey)` by the authorization key. */
  hardwareAuthProof: string;
  appNostrPubkey: string;
  /** The wallet this one replaces on another guardian, if the phone said so. */
  replacesWalletId?: string;
  /**
   * The descriptor of `replacesWalletId`. It must hash to that id and share a user key (phone or
   * hardware) with this wallet; the engine then keeps it as a watched-only wallet (`WatchedWallet`).
   */
  replacesDescriptor?: string;
  /** Kept with the registration: how this wallet's key 3 was derived (`trikey/key3/v1`). */
  key3Mix?: Key3Mix;
  /**
   * Key 3 of THIS wallet, when it is not the signer installed now (a mixed key 3 is new at every pairing).
   * Its pubkey must be `cosignerAccountPubkey`. If the engine is unlocked, it becomes the engine's signer
   * once the registration is saved; the caller keeps and later wipes it either way.
   */
  signer?: CosignerSigner;
}

export type RuleChangeAuth = { authenticatedBy: 'app' } | { authenticatedBy: 'hardware'; approval: HardwareApproval };

export type PhoneSpendingStatus = 'enabled' | 'paused_recovery' | 'paused_contested' | 'retired';

export interface RecoveryView {
  id: string;
  status: Exclude<RecoveryStatus, 'none'>;
  survivingRole: SurvivingRole;
  sweepTxid: string;
  destinationWalletId: string;
  amountSats: bigint;
  feeSats: bigint;
  delayDays: RecoveryDelayDays;
  startedAt: number;
  readyAt: number;
  cancelledAt?: number;
  cancelledBy?: CancelledBy;
  completedAt?: number;
}

export interface GuardianStatus {
  registered: boolean;
  locked: boolean;
  walletId?: string;
  network?: NetworkName;
  rules?: Rules;
  phoneSpending: PhoneSpendingStatus;
  /** Status of the running recovery, else 'none'. */
  recoveryStatus: RecoveryStatus;
  /** The running recovery, else the most recent one. */
  recovery?: RecoveryView;
  /** The next hardware approval must use a sequence number at least this. */
  nextHardwareSequence: number;
  /** `off`: no daily limit (`limit` is `LIMIT_OFF_SATS`); `limitBeforeOff`: the limit a recovery would bring back. */
  dailyLimit?: { limit: bigint; used: bigint; available: bigint; off?: true; limitBeforeOff?: bigint };
  /** True after a rotation until the hardware authorization key is confirmed for the active wallet. */
  hardwareConfirmRequired: boolean;
  /** How many wallets this guardian retired. */
  retiredWallets: number;
  /** Weak spots of the active wallet's policy (`no_alert_contacts`: alerts reach only the paired phone). */
  warnings: PolicyWarning[];
}

export interface CosignResult {
  psbt: Uint8Array;
  txid: string;
  outflow: bigint;
  usedAfter: bigint;
  /** True when this exact transaction had already been co-signed (nothing new was counted). */
  replay: boolean;
}

export interface RotationResult {
  /** The wallet the recovery swept, now retired. */
  retiredWalletId: string;
  /** The destination wallet, now the active one, when the guardian adopted it. */
  adopted?: Registration;
  /** Why the destination was not adopted. */
  detail?: string;
  revokedGrants: number;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

const cloneState = (s: GuardianState) => deserializeState(serializeState(s));

/** Refusals ("..._refused" entries) live in their own bucket of the activity log. */
export const isRefusalEvent = (e: { type: string }) => e.type.endsWith('_refused');
const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
/** An entry's content without its id, time and repeat count: what makes two refusals "the same". */
function eventKey(e: object): string {
  const { id: _i, at: _a, count: _c, lastAt: _l, ...rest } = e as Record<string, unknown>;
  return JSON.stringify(rest, bigintJson);
}
/** The state without its activity log, to tell whether anything else changed. */
const withoutActivity = (s: GuardianState) => JSON.stringify({ ...s, activity: undefined, nextActivityId: undefined }, bigintJson);

/**
 * Bounds the activity log: at most `maxOther` entries that are not refusals and `maxRefused` refusals,
 * the oldest of each dropped first. A flood of refusals can only push out older refusals, never a
 * co-signature, a recovery or a rule change.
 */
export function pruneActivity(list: ActivityEntry[], maxOther: number, maxRefused: number): ActivityEntry[] {
  let refusedCount = 0;
  for (const e of list) if (isRefusalEvent(e)) refusedCount++;
  let dropRefused = refusedCount - maxRefused;
  let dropOther = list.length - refusedCount - maxOther;
  if (dropRefused <= 0 && dropOther <= 0) return list;
  return list.filter((e) => {
    if (isRefusalEvent(e)) return dropRefused-- > 0 ? false : true;
    return dropOther-- > 0 ? false : true;
  });
}
const eqHex = (a: Uint8Array, b: Uint8Array) => hex.encode(a) === hex.encode(b);
const refused = (refusal: Refusal) => ({ ok: false as const, refusal });

/** The running (pending or ready) recovery of the ACTIVE wallet: never one of a wallet that was retired. */
function activeRecovery(s: GuardianState): RecoveryRecord | undefined {
  const id = s.active?.registration.walletId;
  if (!id) return undefined;
  for (let i = s.recoveries.length - 1; i >= 0; i--) {
    const r = s.recoveries[i];
    if (r.walletId === id) return r.status === 'pending' || r.status === 'ready' ? r : undefined;
  }
  return undefined;
}

function viewOf(r: RecoveryRecord, now: number): RecoveryView {
  const status = r.status === 'pending' && now >= r.readyAt ? 'ready' : r.status;
  return {
    id: r.id,
    status,
    survivingRole: r.survivingRole,
    sweepTxid: r.sweepTxid,
    destinationWalletId: r.destinationWalletId,
    amountSats: r.amountSats,
    feeSats: r.feeSats,
    delayDays: r.delayDays,
    startedAt: r.startedAt,
    readyAt: r.readyAt,
    cancelledAt: r.cancelledAt,
    cancelledBy: r.cancelledBy,
    completedAt: r.completedAt,
  };
}

function normalizeHdPath(p: string): string {
  return p.replace(/'/g, 'h');
}

/** The non-hardened steps of `path` below the wallet's hardware account (`m/<origin>/...`), if it lies there. */
function belowHardwareAccount(wallet: MultisigWallet, path: string): string | undefined {
  const origin = `m/${wallet.keys.hardware.originPath}`;
  const p = normalizeHdPath(path);
  if (!p.startsWith(`${origin}/`)) return undefined;
  const rest = p.slice(origin.length + 1);
  return /^\d+(\/\d+)*$/.test(rest) ? rest : undefined;
}

/**
 * The authorization key must sit below the hardware wallet's multisig account by non-hardened steps
 * (the wallet uses `<account>/0/0`, e.g. `m/48'/0'/0'/2'/0/0`), so the guardian checks itself that it
 * belongs to that device: whoever proves it holds that key holds the hardware wallet's account key.
 * Any other path is refused (a key the pairer chose freely proves nothing about the device). Returns
 * a reason when the key does not qualify.
 */
function authKeyMismatch(wallet: MultisigWallet, key: HardwareAuthKey, network: Network): string | undefined {
  const rest = belowHardwareAccount(wallet, key.path);
  if (rest === undefined)
    return `the authorization key must be a non-hardened child of the hardware wallet's account (m/${wallet.keys.hardware.originPath.replace(/h/g, "'")}/0/0)`;
  const derived = HDKey.fromExtendedKey(wallet.keys.hardware.xpub, network.bip32).derive(`m/${rest}`).publicKey!;
  return hex.encode(derived) === key.pubkey ? undefined : 'authorization key does not derive from the hardware xpub at its path';
}

/**
 * A wallet's key set: its three account pubkeys, sorted. What key 3 will co-sign is decided by these
 * alone (inputs are matched by account pubkeys plus the tweaks the PSBT delegates, core's
 * `analyzePsbt`), whatever the descriptor's origins, fingerprints, chaincodes or role order say. So
 * "the same wallet" is compared by this, never by descriptor hash.
 */
export function keySetOf(wallet: MultisigWallet): string {
  const a = wallet.accountPubkeys();
  return ROLES.map((r) => hex.encode(a[r])).sort().join(',');
}

function liveGrants(w: GuardedWallet, now: number): AccessGrant[] {
  return w.accessGrants.filter((g) => g.until > now);
}

export class PolicyEngine {
  private readonly mutex = new Mutex();
  private readonly clock: Clock;
  private readonly authorizers: Map<string, HardwareAuthorizer>;
  private readonly maxActivity: number;
  private readonly maxRefusals: number;
  private readonly chain?: ChainTimeSource;
  private readonly blocksPerDayOverride?: number;
  private signer?: CosignerSigner;
  /** Set by `register` with its own key 3; installed by `mutate` after the save. */
  private nextSigner?: CosignerSigner;

  private constructor(
    private readonly store: StateStore,
    private state: GuardianState,
    opts: PolicyEngineOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.chain = opts.chain;
    this.blocksPerDayOverride = opts.blocksPerDay;
    this.authorizers = new Map((opts.authorizers ?? [bip137Authorizer]).map((a) => [a.kind, a]));
    this.maxActivity = opts.maxActivity ?? DEFAULT_MAX_ACTIVITY;
    this.maxRefusals = opts.maxRefusals ?? DEFAULT_MAX_REFUSALS;
    this.setSigner(opts.signer);
  }

  /** Loads persisted state (or starts empty). A version-1 file is migrated on load and written back as version 2 at the next change. */
  static async open(opts: PolicyEngineOptions): Promise<PolicyEngine> {
    const state = (await opts.store.load()) ?? emptyState();
    return new PolicyEngine(opts.store, state, opts);
  }

  // -------------------------------------------------------------------------
  // Lock / unlock

  /** Installs key 3 after unlock, or removes it (`undefined`) to lock. */
  setSigner(signer: CosignerSigner | undefined): void {
    const reg = this.state.active?.registration;
    if (signer && reg && hex.encode(signer.accountPubkey) !== reg.cosignerAccountPubkey)
      throw new Error('signer does not hold the registered cosigner key');
    this.signer = signer;
  }

  get locked(): boolean {
    return !this.signer;
  }

  // -------------------------------------------------------------------------
  // Reads

  status(): GuardianStatus {
    const s = this.state;
    const now = this.clock.now();
    const w = s.active;
    const reg = w?.registration;
    const active = activeRecovery(s);
    // The most recent one, leaving out those the guardian closed itself at a rotation.
    const last = active ?? [...s.recoveries].reverse().find((r) => r.cancelledBy?.kind !== 'superseded');
    let phoneSpending: PhoneSpendingStatus;
    if (active) phoneSpending = 'paused_recovery';
    else if (w?.phoneSpending.state === 'paused_contested') phoneSpending = 'paused_contested';
    else if (w?.phoneSpending.state === 'retired') phoneSpending = 'retired';
    else phoneSpending = 'enabled';
    const used = w ? windowUsage(w.spends, Math.max(now, s.timeFloor ?? 0)) : 0n;
    const rules = w?.rules;
    return {
      registered: !!reg,
      locked: this.locked,
      walletId: reg?.walletId,
      network: reg?.network,
      rules,
      phoneSpending,
      recoveryStatus: active ? viewOf(active, now).status : 'none',
      recovery: last ? viewOf(last, now) : undefined,
      nextHardwareSequence: s.hardwareSequence + 1,
      dailyLimit: rules
        ? {
            limit: rules.dailyLimitSats,
            used,
            available: rules.dailyLimitSats > used ? rules.dailyLimitSats - used : 0n,
            ...(isLimitOff(rules) ? { off: true as const } : {}),
            ...(isLimitOff(rules) && w?.limitBeforeOff !== undefined ? { limitBeforeOff: w.limitBeforeOff } : {}),
          }
        : undefined,
      hardwareConfirmRequired: !!reg && !reg.hardwareAuthConfirmed,
      retiredWallets: s.retired.length,
      warnings: policyWarnings(rules),
    };
  }

  /** Newest first. */
  activity(opts: { limit?: number; beforeId?: number } = {}): ActivityEntry[] {
    const all = this.state.activity.filter((e) => opts.beforeId === undefined || e.id < opts.beforeId);
    return all.slice(-(opts.limit ?? 100)).reverse();
  }

  /** The active wallet's registration. */
  registration(): Registration | undefined {
    return this.state.active?.registration;
  }

  /** The wallet the active wallet replaced, if the guardian watches it (read-only). */
  watchedWallet(): WatchedWallet | undefined {
    return this.state.active?.watched;
  }

  /** Wallets this guardian retired, oldest first (read-only). */
  retiredWallets(): readonly RetiredWallet[] {
    return this.state.retired;
  }

  /** The registration of the active or a retired wallet. */
  walletById(walletId: string): Registration | undefined {
    const a = this.state.active?.registration;
    if (a?.walletId === walletId) return a;
    return this.state.retired.find((r) => r.registration.walletId === walletId)?.registration;
  }

  /** Alerts the service should send now (nostr DMs), with the recipients still owed each one. */
  dueAlerts(): DueAlert[] {
    return computeDueAlerts(this.state.recoveries, this.clock.now());
  }

  /** Limit changes (`limit_off`, `limit_on`) still owed to someone, oldest first, with the recipients not reached yet. */
  dueNotices(): (LimitNotice & { recipients: string[] })[] {
    const now = this.clock.now();
    return (this.state.notices ?? [])
      .filter((n) => n.at > now - NOTICE_TTL_MS)
      .map((n) => ({ ...n, recipients: n.recipients.filter((r) => !n.sent.includes(r)) }))
      .filter((n) => n.recipients.length > 0);
  }

  /** True while `pubkey` holds an unexpired `recovery.access` grant for the active wallet. */
  hasRecoveryAccess(pubkey: string): boolean {
    const w = this.state.active;
    return !!w && liveGrants(w, this.clock.now()).some((g) => g.pubkey === pubkey);
  }

  /** Phones holding an unexpired `recovery.access` grant for the active wallet. */
  recoveryPeers(): string[] {
    const w = this.state.active;
    return w ? liveGrants(w, this.clock.now()).map((g) => g.pubkey) : [];
  }

  // -------------------------------------------------------------------------
  // Internals

  private async mutate<T>(fn: (draft: GuardianState, now: number) => Promise<T> | T): Promise<T> {
    return this.mutex.run(async () => {
      this.nextSigner = undefined;
      try {
        const draft = cloneState(this.state);
        const now = this.clock.now();
        this.refresh(draft, now);
        const out = await fn(draft, now);
        if (draft.active) draft.active.spends = pruneSpends(draft.active.spends, now);
        draft.activity = pruneActivity(draft.activity, this.maxActivity, this.maxRefusals);
        // A refusal that changed nothing but the activity log is not worth a durable write (a stranger's
        // or a stolen phone's flood would otherwise fsync the whole state each time): it stays in memory
        // and goes to disk with the next real change.
        const refusalOnly = (out as { ok?: unknown })?.ok === false && withoutActivity(draft) === withoutActivity(this.state);
        if (!refusalOnly) await this.store.save(draft);
        this.state = draft;
        // A registration that brings its own key 3 swaps it in with the state, never before the save.
        if (this.nextSigner && this.signer) this.signer = this.nextSigner;
        return out;
      } finally {
        this.nextSigner = undefined;
      }
    });
  }

  /** pending -> ready once the delay has elapsed. */
  private refresh(draft: GuardianState, now: number): boolean {
    const r = activeRecovery(draft);
    if (r && r.status === 'pending' && now >= r.readyAt) {
      r.status = 'ready';
      this.log(draft, now, { type: 'recovery_ready', recoveryId: r.id });
      return true;
    }
    return false;
  }

  /** The chain's tip now, or undefined when it cannot be had. Asked before taking the lock: it is only a reference. */
  private async chainTime(): Promise<ChainTime | undefined> {
    if (!this.chain) return undefined;
    try {
      const t = await this.chain.tip();
      return Number.isSafeInteger(t?.height) && t.height >= 0 && Number.isFinite(t.medianTimePastMs) ? { height: t.height, medianTimePastMs: t.medianTimePastMs } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remembers the latest tip seen (never a lower one; the same tip again changes nothing, so it costs no write). */
  private noteChain(draft: GuardianState, now: number, chain: ChainTime | undefined): void {
    const seen = draft.chainSeen;
    if (chain && (!seen || chain.height > seen.height || (chain.height === seen.height && chain.medianTimePastMs > seen.medianTimePastMs)))
      draft.chainSeen = { ...chain, at: now };
  }

  /**
   * The time the daily limit counts with: the system clock, but never earlier than the last time used
   * (monotonic), and refused while the clock is more than `MAX_CLOCK_AHEAD_OF_CHAIN_MS` ahead of the
   * chain's median time past (the live one, else the last one seen): a clock pushed forward would open
   * a fresh 24 h window with every step.
   */
  private limitTime(draft: GuardianState, now: number, chain: ChainTime | undefined): { ok: true; at: number } | { ok: false; refusal: Refusal } {
    const seen = chain ?? draft.chainSeen;
    if (!seen) return { ok: false, refusal: { reason: 'chain_unavailable', detail: 'no chain data to check the clock against yet' } };
    if (now > seen.medianTimePastMs + MAX_CLOCK_AHEAD_OF_CHAIN_MS)
      return { ok: false, refusal: { reason: 'clock_ahead_of_chain', systemTime: now, chainTime: seen.medianTimePastMs } };
    return { ok: true, at: Math.max(draft.timeFloor ?? 0, now) };
  }

  /** Blocks per day of delay a recovery of a wallet on `network` must span. */
  blocksPerDay(network: NetworkName): number {
    return this.blocksPerDayOverride ?? BLOCKS_PER_DAY[network] ?? 144;
  }

  /** The chain height a recovery can complete at, if it recorded its start height. */
  heightNeeded(rec: RecoveryRecord): number | undefined {
    if (rec.startHeight === undefined) return undefined;
    const reg = this.walletById(rec.walletId);
    return rec.startHeight + rec.delayDays * this.blocksPerDay(reg?.network ?? 'bitcoin');
  }

  /** Queues a limit notice for the service to deliver; drops ones that are done or too old. */
  private addNotice(draft: GuardianState, now: number, notice: LimitNotice): void {
    const live = (draft.notices ?? []).filter((n) => n.at > now - NOTICE_TTL_MS && n.sent.length < n.recipients.length);
    draft.notices = [...live, notice].slice(-MAX_NOTICES);
  }

  /** Appends to the activity log. A refusal identical to the entry before it is counted there instead (`count`, `lastAt`). */
  private log(draft: GuardianState, now: number, event: ActivityEvent): void {
    const last = draft.activity[draft.activity.length - 1];
    if (isRefusalEvent(event) && last && last.type === event.type && eventKey(last) === eventKey(event)) {
      last.count = (last.count ?? 1) + 1;
      last.lastAt = now;
      return;
    }
    draft.activity.push({ id: draft.nextActivityId++, at: now, ...event } as ActivityEntry);
  }

  private wallet(reg: Registration): MultisigWallet {
    return MultisigWallet.fromDescriptor(reg.descriptor, getNetwork(reg.network));
  }

  /** The retired wallet whose coins `psbt` spends, if any (for a precise refusal). */
  private retiredOwner(draft: GuardianState, psbt: Uint8Array): string | undefined {
    for (const r of draft.retired) {
      try {
        if (inspectPsbt(psbt, this.wallet(r.registration)).ok) return r.registration.walletId;
      } catch {
        /* not this one */
      }
    }
    return undefined;
  }

  /** The retired wallet with the same key set as `wallet`, if any. */
  private retiredKeySet(draft: GuardianState, wallet: MultisigWallet): RetiredWallet | undefined {
    const ks = keySetOf(wallet);
    return draft.retired.find((r) => {
      try {
        return keySetOf(this.wallet(r.registration)) === ks;
      } catch {
        return false;
      }
    });
  }

  /** Checks a hardware approval for `action` and consumes its sequence number on success. */
  private checkApproval(draft: GuardianState, now: number, approval: HardwareApproval, action: HardwareAction): Refusal | undefined {
    const reg = draft.active!.registration;
    if (!reg.hardwareAuthConfirmed || !reg.hardwareAuth) return { reason: 'hardware_auth_unconfirmed', walletId: reg.walletId };
    const authorizer = this.authorizers.get(approval?.kind);
    if (!authorizer || approval.kind !== reg.hardwareAuth.kind) return { reason: 'unsupported_approval', kind: String(approval?.kind) };
    if (!Number.isSafeInteger(approval.sequence) || approval.sequence <= draft.hardwareSequence)
      return { reason: 'approval_stale_sequence', sequence: approval.sequence, lastSequence: draft.hardwareSequence };
    if (approval.sequence > draft.hardwareSequence + MAX_SEQUENCE_STEP)
      return { reason: 'approval_sequence_too_far', sequence: approval.sequence, lastSequence: draft.hardwareSequence };
    if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt * 1000 <= now)
      return { reason: 'approval_expired', expiresAt: approval.expiresAt };
    const maxExpiresAt = Math.floor((now + MAX_APPROVAL_TTL_MS) / 1000);
    if (approval.expiresAt > maxExpiresAt) return { reason: 'approval_expiry_too_far', expiresAt: approval.expiresAt, maxExpiresAt };
    let message: string;
    try {
      message = approvalMessage(action, { walletId: reg.walletId, sequence: approval.sequence, expiresAt: approval.expiresAt });
    } catch {
      return { reason: 'approval_invalid_signature' };
    }
    if (typeof approval.signature !== 'string' || !authorizer.verify(message, approval.signature, reg.hardwareAuth))
      return { reason: 'approval_invalid_signature' };
    draft.hardwareSequence = approval.sequence;
    return undefined;
  }

  /** Validates an authorization key (normalized copy) or returns why not. */
  private checkAuthKey(key: HardwareAuthKey | undefined): { ok: true; key: HardwareAuthKey; authorizer: HardwareAuthorizer } | { ok: false; detail: string } {
    if (!key || typeof key !== 'object') return { ok: false, detail: 'hardwareAuth is missing' };
    const hwKey: HardwareAuthKey = { ...key, pubkey: String(key.pubkey).toLowerCase() };
    const authorizer = this.authorizers.get(hwKey.kind);
    if (!authorizer) return { ok: false, detail: `unsupported hardware authorization kind: ${hwKey.kind}` };
    try {
      authorizer.validateKey(hwKey);
    } catch (e) {
      return { ok: false, detail: `hardwareAuth: ${(e as Error).message}` };
    }
    return { ok: true, key: hwKey, authorizer };
  }

  /** Moves the active wallet to the retired list. Returns how many live access grants that revoked. */
  private retireActive(draft: GuardianState, now: number, retirement: RetiredWallet['retirement']): number {
    const w = draft.active!;
    const live = liveGrants(w, now);
    const revoked = live.length;
    // Their signatures stay refused until they expire (a version-1 text names no wallet).
    draft.revokedAccess = [
      ...(draft.revokedAccess ?? []).filter((r) => r.until > now),
      ...live.flatMap((g) => (g.sig ? [{ sig: g.sig, until: g.until }] : [])),
    ].slice(-64);
    draft.retired.push({ registration: w.registration, rules: w.rules, retiredAt: now, retirement });
    draft.active = undefined;
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Registration

  async register(input: RegisterInput): Promise<Result<{ walletId: string }>> {
    return this.mutate((draft, now) => {
      if (draft.active) return refused({ reason: 'already_registered' });
      const bad = (detail: string) => refused({ reason: 'invalid_registration', detail });
      let network: Network;
      let wallet: MultisigWallet;
      try {
        network = getNetwork(input.network);
        wallet = MultisigWallet.fromDescriptor(input.descriptor, network);
      } catch (e) {
        return bad(`descriptor: ${(e as Error).message}`);
      }
      const acct = wallet.accountPubkeys();
      const cosignerHex = String(input.cosignerAccountPubkey).toLowerCase();
      if (hex.encode(acct.cosigner) !== cosignerHex) return bad('the descriptor does not hold the guardian key in the cosigner slot');
      if (new Set(ROLES.map((r) => hex.encode(acct[r]))).size !== 3) return bad('the three keys must be distinct');
      if (input.signer) {
        if (hex.encode(input.signer.accountPubkey) !== cosignerHex) return bad('the given key 3 differs from cosignerAccountPubkey');
      } else if (this.signer && hex.encode(this.signer.accountPubkey) !== cosignerHex) return bad('the unlocked guardian key differs from cosignerAccountPubkey');
      if (input.key3Mix !== undefined && !isKey3MixRecord(input.key3Mix)) return bad('invalid key3Mix');
      const appNostr = String(input.appNostrPubkey).toLowerCase();
      if (!isNostrPubkey(appNostr)) return bad('appNostrPubkey must be 32-byte hex');
      let rules: Rules;
      try {
        rules = normalizeRules(input.rules);
      } catch (e) {
        return bad(`rules: ${(e as Error).message}`);
      }
      // Without a contact, a recovery's alerts reach only the paired phone, which a thief may hold.
      if (network.name === 'bitcoin' && !rules.alertContacts.length) return bad(`rules: ${MAINNET_CONTACT_REQUIRED}`);
      // Pairing rules are not hardware-approved (only the pairing proof is), so they cannot loosen as far as "off".
      if (isLimitOff(rules)) return bad(`rules: ${LIMIT_OFF_AT_PAIRING}`);
      const checked = this.checkAuthKey(input.hardwareAuth);
      if (!checked.ok) return bad(checked.detail);
      const hwKey = checked.key;
      const mismatch = authKeyMismatch(wallet, hwKey, network);
      if (mismatch) return bad(mismatch);
      const walletId = wallet.fingerprint();
      // A retired wallet stays retired: re-pairing it would bring back a key set the user moved away from.
      // Compared by key set: another descriptor for the same keys (other origins, chaincodes or roles)
      // is the same wallet to key 3.
      const retired = this.retiredKeySet(draft, wallet);
      if (retired) return refused({ reason: 'wallet_retired', walletId: retired.registration.walletId });
      if (!checked.authorizer.verify(pairingMessage(walletId, cosignerHex), input.hardwareAuthProof, hwKey))
        return bad('hardware pairing proof does not verify');
      const replaces = typeof input.replacesWalletId === 'string' && /^[0-9a-f]{16}$/.test(input.replacesWalletId) ? input.replacesWalletId : undefined;
      let watched: WatchedWallet | undefined;
      if (input.replacesDescriptor !== undefined) {
        if (!replaces) return bad('replacesDescriptor needs replacesWalletId');
        let replaced: MultisigWallet;
        try {
          replaced = MultisigWallet.fromDescriptor(input.replacesDescriptor, network);
        } catch (e) {
          return bad(`replacesDescriptor: ${(e as Error).message}`);
        }
        if (replaced.fingerprint() !== replaces) return bad('replacesDescriptor does not hash to replacesWalletId');
        if (replaces === walletId) return bad('a wallet cannot replace itself');
        // A replacement keeps the user's keys and changes the guardian's: at least one of key 2 and the hardware key must carry over.
        const before = replaced.accountPubkeys();
        if (!eqHex(before.app, acct.app) && !eqHex(before.hardware, acct.hardware))
          return bad('the replaced wallet shares neither the phone key nor the hardware key with this wallet');
        watched = { walletId: replaces, network: network.name, descriptor: replaced.descriptor(), since: now };
      }

      draft.active = {
        registration: {
          walletId,
          network: network.name,
          descriptor: wallet.descriptor(),
          cosignerAccountPubkey: cosignerHex,
          hardwareAuth: hwKey,
          hardwareAuthConfirmed: true,
          appNostrPubkey: appNostr,
          registeredAt: now,
          origin: { kind: 'paired', ...(replaces ? { replacesWalletId: replaces } : {}) },
          ...(input.key3Mix ? { key3Mix: { version: 1 as const, entropy: input.key3Mix.entropy, context: input.key3Mix.context } } : {}),
        },
        rules,
        spends: [],
        phoneSpending: { state: 'enabled' },
        accessGrants: [],
        ...(watched ? { watched } : {}),
      };
      this.log(draft, now, { type: 'registered', walletId, ...(replaces ? { replacesWalletId: replaces } : {}), ...(watched ? { watching: true } : {}) });
      // Installed with the saved state (see `mutate`), and only while unlocked.
      if (input.signer) this.nextSigner = input.signer;
      return { ok: true as const, walletId };
    });
  }

  /**
   * Stops watching the replaced wallet (`wallet.unwatch`). `walletId` names the wallet to drop; omitted,
   * whatever is watched. Nothing watched, or another wallet named: nothing changes (`unwatched: false`).
   */
  async unwatch(walletId?: string): Promise<Result<{ unwatched: boolean; walletId?: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      if (!w.watched || (walletId !== undefined && walletId !== w.watched.walletId)) return { ok: true as const, unwatched: false };
      const dropped = w.watched.walletId;
      delete w.watched;
      this.log(draft, now, { type: 'wallet_unwatched', walletId: dropped });
      return { ok: true as const, unwatched: true, walletId: dropped };
    });
  }

  /**
   * The paired phone's single-key coins (`singlekey.register`): the helper coin's account xpub (which
   * lets that account's P2WPKH coin ride along when the guardian co-signs a silent payment, and its
   * coins be served and swept) and/or explicit single-key coins (received silent payments). Public data
   * only. Each part given replaces what was registered; `coins: []` clears the coins. It needs no key 3
   * and no approval: it gives no one more than the daily limit, which counts only the vault's outflow.
   */
  async registerSingleKey(input: {
    helper?: { xpub: string; fingerprint: string; path: string };
    coins?: { txid: string; vout: number; script: string }[];
  }): Promise<Result<{ singleKey: SingleKeyRegistration }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const bad = (detail: string) => refused({ reason: 'invalid_registration', detail });
      if (input.helper === undefined && input.coins === undefined) return bad('nothing to register');
      const network = getNetwork(w.registration.network);
      const next: SingleKeyRegistration = { ...(w.singleKey ?? { coins: [] }), updatedAt: now };
      if (input.helper !== undefined) {
        const { xpub, fingerprint, path } = input.helper;
        if (typeof path !== 'string' || !samePath(path, helperAccountPath(network))) return bad(`the helper account must be at ${helperAccountPath(network)}`);
        if (typeof fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(fingerprint)) return bad('helper fingerprint must be 4 bytes of lowercase hex');
        try {
          parseHelperXpub(String(xpub), network);
        } catch (e) {
          return bad(`helper: ${(e as Error).message}`);
        }
        const vault = this.wallet(w.registration).keys;
        if ([vault.app, vault.hardware, vault.cosigner].some((k) => k.xpub === xpub)) return bad('the helper account cannot be a vault key');
        next.helper = { xpub, fingerprint, path: helperAccountPath(network), registeredAt: now };
      }
      if (input.coins !== undefined) {
        if (!Array.isArray(input.coins) || input.coins.length > MAX_SINGLE_KEY_COINS) return bad(`at most ${MAX_SINGLE_KEY_COINS} coins`);
        const seen = new Set<string>();
        const coins: SingleKeyRegistration['coins'] = [];
        for (const c of input.coins) {
          const txid = String(c?.txid).toLowerCase();
          const script = String(c?.script).toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(c?.vout) || c.vout < 0 || c.vout > 1_000_000) return bad('a coin needs a txid and an output index');
          if (!/^(?:[0-9a-f]{2})+$/.test(script) || !(isP2TR(hex.decode(script)) || isP2WPKH(hex.decode(script)))) return bad('a coin must pay a single-key P2TR or P2WPKH script');
          const id = `${txid}:${c.vout}`;
          if (seen.has(id)) continue;
          seen.add(id);
          coins.push({ txid, vout: c.vout, script });
        }
        next.coins = coins;
      }
      w.singleKey = next;
      this.log(draft, now, { type: 'single_key_registered', helper: !!next.helper, coins: next.coins.length });
      return { ok: true as const, singleKey: next };
    });
  }

  /** The active wallet's high-water marks (DESIGN.md: scans of the wallet must reach at least these). */
  highWater(walletId?: string): HighWater {
    const w = this.state.active;
    if (!w || (walletId !== undefined && w.registration.walletId !== walletId)) return { ...NO_HIGH_WATER };
    return { ...(w.highWater ?? NO_HIGH_WATER) };
  }

  /**
   * Raises the active wallet's high-water marks to what a scan of `walletId` found used (an incoming
   * payment to a fresh address, say). Never lowers them. Writes nothing when nothing rises.
   */
  async noteUsedIndexes(walletId: string, used: HighWater): Promise<boolean> {
    const rises = (s: GuardianState) => {
      const w = s.active;
      if (!w || w.registration.walletId !== walletId) return false;
      const cur = w.highWater ?? NO_HIGH_WATER;
      const ok = (n: number) => Number.isSafeInteger(n) && n <= MAX_SELF_INDEX;
      return (ok(used.receive) && used.receive > cur.receive) || (ok(used.change) && used.change > cur.change);
    };
    if (!rises(this.state)) return false;
    return this.mutate((draft) => {
      if (!rises(draft)) return false;
      const w = draft.active!;
      const clamp = (n: number) => (Number.isSafeInteger(n) ? Math.min(n, MAX_SELF_INDEX) : -1);
      w.highWater = maxHighWater(w.highWater ?? NO_HIGH_WATER, { receive: clamp(used.receive), change: clamp(used.change) });
      return true;
    });
  }

  /** The paired phone's single-key coins, if it registered any (read-only). */
  singleKey(): SingleKeyRegistration | undefined {
    return this.state.active?.singleKey;
  }

  // -------------------------------------------------------------------------
  // Savings (watch-only; docs/design/savings-and-limit-off.md, option K)

  /** The Savings wallet the guardian watches for the paired phone, if any (read-only). */
  savings(): SavingsWatch | undefined {
    return this.state.active?.savings;
  }

  /**
   * Watch the phone's Savings wallet (`savings.register`): its chain data, its spends' relay and the `savings_moved`
   * tripwire. Watch-only, so it needs no key 3 and no approval: it adds no rule, changes nothing the daily limit counts
   * and gives nobody a signature. What it must never be is a wallet the guardian can sign for: a descriptor whose key
   * set is the active, the watched or a retired wallet's, or that holds key 3 (of any wallet the guardian guards or
   * guarded), is refused. A different Savings wallet replaces the one watched before (a key was replaced); the same one
   * again changes nothing.
   */
  async registerSavings(descriptor: string): Promise<Result<{ savings: SavingsWatch; replaced?: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const bad = (detail: string) => refused({ reason: 'invalid_registration', detail });
      const network = getNetwork(w.registration.network);
      let wallet: MultisigWallet;
      try {
        wallet = MultisigWallet.fromDescriptor(String(descriptor), network);
        wallet.derive(0, 0);
      } catch (e) {
        return bad(`the Savings descriptor does not parse on ${network.name} (${(e as Error).message})`);
      }
      const acct = wallet.accountPubkeys();
      const keys = ROLES.map((r) => hex.encode(acct[r]));
      if (new Set(keys).size !== 3) return bad('the Savings wallet does not have three distinct keys');
      const ks = keySetOf(wallet);
      if (ks === keySetOf(this.wallet(w.registration))) return bad('that is the wallet this guardian co-signs for, not a Savings wallet');
      if (w.watched && ks === keySetOf(MultisigWallet.fromDescriptor(w.watched.descriptor, network))) return bad('that is the replaced wallet this guardian watches');
      if (this.retiredKeySet(draft, wallet)) return bad('that is a wallet this guardian guarded before');
      const key3s = new Set([w.registration.cosignerAccountPubkey, ...draft.retired.map((r) => r.registration.cosignerAccountPubkey)]);
      if (keys.some((k) => key3s.has(k))) return bad("a Savings wallet cannot hold the guardian's key: the guardian must not be able to sign for it");
      const walletId = wallet.fingerprint();
      const prev = w.savings;
      if (prev?.walletId === walletId) return { ok: true as const, savings: prev };
      const next: SavingsWatch = { walletId, network: network.name, descriptor: wallet.descriptor(), since: now, baselined: false, seenSpends: [] };
      w.savings = next;
      this.log(draft, now, { type: 'savings_registered', walletId, ...(prev ? { replaced: prev.walletId } : {}) });
      return { ok: true as const, savings: next, ...(prev ? { replaced: prev.walletId } : {}) };
    });
  }

  /** Stop watching the Savings wallet (`savings.unregister`). Nothing watched: nothing changes. */
  async unregisterSavings(): Promise<Result<{ unregistered: boolean; walletId?: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      if (!w.savings) return { ok: true as const, unregistered: false };
      const walletId = w.savings.walletId;
      delete w.savings;
      this.log(draft, now, { type: 'savings_unregistered', walletId });
      return { ok: true as const, unregistered: true, walletId };
    });
  }

  /**
   * What a scan of the Savings wallet found: the indexes used (its high-water marks rise, never fall) and the
   * transactions that spent its coins, newest first (`amountSats` what left Savings, fee included). The first scan after
   * registration only records them (history, not news). Every later spend not seen before is logged and queued as a
   * `savings_moved` notice for the paired phone and every alert contact, delivered and retried like the limit notices.
   * Returns the newly announced spends. Writes nothing when nothing is new.
   */
  async noteSavingsScan(
    walletId: string,
    scan: { nextReceiveIndex: number; nextChangeIndex: number; spends: { txid: string; amountSats: bigint }[] },
  ): Promise<{ txid: string; amountSats: bigint }[]> {
    const used: HighWater = { receive: scan.nextReceiveIndex - 1, change: scan.nextChangeIndex - 1 };
    const ok = (n: number) => Number.isSafeInteger(n) && n <= MAX_SELF_INDEX;
    const pending = (st: GuardianState) => {
      const sv = st.active?.savings;
      if (!sv || sv.walletId !== walletId) return undefined;
      const cur = sv.highWater ?? NO_HIGH_WATER;
      const rises = (ok(used.receive) && used.receive > cur.receive) || (ok(used.change) && used.change > cur.change);
      const fresh = scan.spends.filter((x) => /^[0-9a-f]{64}$/.test(x.txid) && !sv.seenSpends.includes(x.txid));
      return rises || fresh.length || !sv.baselined ? { fresh } : undefined;
    };
    if (!pending(this.state)) return [];
    return this.mutate((draft, now) => {
      const p = pending(draft);
      if (!p) return [];
      const w = draft.active!;
      const sv = w.savings!;
      const clamp = (n: number) => (Number.isSafeInteger(n) ? Math.min(n, MAX_SELF_INDEX) : -1);
      sv.highWater = maxHighWater(sv.highWater ?? NO_HIGH_WATER, { receive: clamp(used.receive), change: clamp(used.change) });
      // Oldest first, so the log and the notices read in the order the coins moved.
      const fresh = [...new Map(p.fresh.map((x) => [x.txid, x])).values()].reverse();
      sv.seenSpends = [...sv.seenSpends, ...fresh.map((x) => x.txid)].slice(-MAX_SAVINGS_SPENDS);
      if (!sv.baselined) {
        sv.baselined = true;
        return [];
      }
      const recipients = [w.registration.appNostrPubkey, ...w.rules.alertContacts.filter((c) => c !== w.registration.appNostrPubkey)];
      for (const x of fresh) {
        this.log(draft, now, { type: 'savings_moved', walletId, txid: x.txid, amountSats: x.amountSats });
        this.addNotice(draft, now, {
          id: `savings-${draft.nextActivityId}`,
          kind: 'savings_moved',
          walletId: w.registration.walletId,
          at: now,
          savingsWalletId: walletId,
          txid: x.txid,
          amountSats: x.amountSats,
          recipients,
          sent: [],
        });
      }
      return fresh;
    });
  }

  /**
   * After a rotation, the hardware wallet proves again that it holds the authorization key, now for
   * the active wallet's id: a signature over `pairingMessage(walletId, cosignerAccountPubkey)`, as at
   * pairing. Until then every hardware approval is refused (`hardware_auth_unconfirmed`). The key must
   * be the one the guardian expects, when it expects one, and must derive from the hardware xpub when
   * its path lies below it. Repeating it for a confirmed wallet with the same key is a no-op.
   */
  async confirmHardwareAuth(input: { hardwareAuth: HardwareAuthKey; proof: string }): Promise<Result<{ registration: Registration; changed: boolean }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'hardware_auth_confirm_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const reg = w.registration;
      const bad = (detail: string) => refuse({ reason: 'invalid_registration', detail });
      const checked = this.checkAuthKey(input.hardwareAuth);
      if (!checked.ok) return bad(checked.detail);
      const key = checked.key;
      const sameKey = (k: HardwareAuthKey | undefined) => !!k && k.kind === key.kind && k.pubkey === key.pubkey && normalizeHdPath(k.path) === normalizeHdPath(key.path);
      if (reg.hardwareAuth && !sameKey(reg.hardwareAuth))
        return bad(reg.hardwareAuthConfirmed ? 'the hardware authorization key is already confirmed' : 'not the authorization key the guardian expects for this wallet');
      const network = getNetwork(reg.network);
      const mismatch = authKeyMismatch(this.wallet(reg), key, network);
      if (mismatch) return bad(mismatch);
      if (typeof input.proof !== 'string' || !checked.authorizer.verify(pairingMessage(reg.walletId, reg.cosignerAccountPubkey), input.proof, key))
        return bad('hardware pairing proof does not verify');
      if (reg.hardwareAuthConfirmed) return { ok: true as const, registration: reg, changed: false };
      reg.hardwareAuth = { kind: key.kind, pubkey: key.pubkey, path: key.path };
      reg.hardwareAuthConfirmed = true;
      this.log(draft, now, { type: 'hardware_auth_confirmed', walletId: reg.walletId });
      return { ok: true as const, registration: reg, changed: true };
    });
  }

  // -------------------------------------------------------------------------
  // Phone-only spends

  /** Co-signs a phone-signed spend within the daily limit. */
  async cosign(psbt: Uint8Array): Promise<Result<CosignResult>> {
    const chain = await this.chainTime();
    return this.mutate(async (draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: Refusal, txid?: string) => {
        this.log(draft, now, { type: 'cosign_refused', txid, refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) {
        const retired = this.retiredOwner(draft, psbt);
        return refused(retired ? { reason: 'wallet_retired', walletId: retired } : { reason: 'not_registered' });
      }
      const { registration: reg, rules } = w;
      const active = activeRecovery(draft);
      if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
      const ps = w.phoneSpending;
      if (ps.state !== 'enabled')
        return refuse({
          reason: 'phone_spending_paused',
          cause: ps.state === 'retired' ? 'wallet_retired' : 'contested_recovery',
          recoveryId: ps.recoveryId,
        });
      // The limit's time: monotonic, and not trusted past the chain's time plus a few hours.
      const time = this.limitTime(draft, now, chain);
      if (!time.ok) return refuse(time.refusal);
      const at = time.at;

      // The phone's helper coin may ride along in a silent payment (DESIGN.md, "Silent payments"): only
      // once the phone registered its helper account, only a script of that account, only in a PSBT
      // with a taproot output (inspect.ts), and at most one finalized P2WPKH input (core).
      const helper = w.singleKey?.helper ? helperAccount(w.singleKey.helper.xpub, reg.network) : undefined;
      // Change only within CHANGE_WINDOW of the high-water marks: a coin parked further out would be
      // out of sight of every gap-limit scan, so it counts as leaving the wallet.
      const marks = w.highWater ?? NO_HIGH_WATER;
      const selfLimit = { receive: marks.receive + CHANGE_WINDOW, change: marks.change + CHANGE_WINDOW };
      const checked = inspectPsbt(psbt, this.wallet(reg), undefined, { selfLimit, ...(helper ? { helper: (c) => !!helper.locate(c.script) } : {}) });
      if (!checked.ok) {
        const retired = checked.refusal.reason === 'foreign_input' ? this.retiredOwner(draft, psbt) : undefined;
        return refuse(retired ? { reason: 'wallet_retired', walletId: retired } : checked.refusal);
      }
      const { analysis, outflow } = checked.inspection;
      const txid = analysis.txid;
      for (const inp of analysis.inputs) {
        if (inp.signedBy.length !== 1) return refuse({ reason: 'signature_count', input: inp.index, count: inp.signedBy.length }, txid);
        if (inp.signedBy[0] === 'hardware') return refuse({ reason: 'hardware_signed_outside_recovery', input: inp.index }, txid);
        if (inp.signedBy[0] !== 'app') return refuse({ reason: 'not_signed_by_app', input: inp.index, signedBy: inp.signedBy }, txid);
      }

      const replay = w.spends.some((s) => s.txid === txid);
      const used = windowUsage(w.spends, at);
      const shares = splitOutflow(analysis.inputs, outflow);
      const wouldUse = replay ? used : usageWith(w.spends, shares, at);
      if (!replay && wouldUse > rules.dailyLimitSats)
        return refuse({ reason: 'over_daily_limit', limit: rules.dailyLimitSats, used, outflow, wouldUse }, txid);

      if (!this.signer) return refuse({ reason: 'guardian_locked' }, txid);
      const signed = await addCosignerSignatures(psbt, analysis, this.signer);
      if (!replay) w.spends.push({ txid, at, outflow, shares });
      draft.timeFloor = at;
      // Co-signed change is "seen": the marks rise to it, so every later scan reaches it.
      w.highWater = maxHighWater(marks, checked.inspection.selfIndexes);
      const helperInput = analysis.helper?.outpoint;
      this.log(draft, now, { type: 'cosign_signed', txid, outflow, usedAfter: wouldUse, replay, ...(helperInput ? { helperInput } : {}) });
      return { ok: true as const, psbt: signed, txid, outflow, usedAfter: wouldUse, replay };
    });
  }

  // -------------------------------------------------------------------------
  // Rules

  async changeRules(next: Rules, auth: RuleChangeAuth): Promise<Result<{ rules: Rules }>> {
    return this.mutate((draft, now) => {
      const by = auth.authenticatedBy === 'hardware' ? 'hardware' : 'app';
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'rules_change_refused', by, refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const current = w.rules;
      let rules: Rules;
      try {
        rules = normalizeRules(next);
      } catch (e) {
        return refuse({ reason: 'invalid_rules', detail: (e as Error).message });
      }
      if (w.registration.network === 'bitcoin' && !rules.alertContacts.length) return refuse({ reason: 'invalid_rules', detail: MAINNET_CONTACT_REQUIRED });
      let sequence: number | undefined;
      if (auth.authenticatedBy === 'app') {
        const may = phoneMayApply(current, rules);
        if (!may.ok) return refuse({ reason: 'hardware_approval_required', detail: may.detail });
      } else if (auth.authenticatedBy === 'hardware') {
        // A hardware-held thief must not be able to weaken the rules while its own recovery runs.
        const active = activeRecovery(draft);
        if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
        // Version 3 of the text whenever the contacts may lock the guardian now (turning it off says `lock=off`).
        const r = this.checkApproval(draft, now, auth.approval, { action: 'policy', rules, contactLockBefore: isContactLockOn(current) });
        if (r) return refuse(r);
        sequence = auth.approval.sequence;
      } else {
        return refuse({ reason: 'not_authorized' });
      }
      // No daily limit (DESIGN.md, rule 3): only ever reached through the hardware branch above (it is a raise), so a
      // recovery is not running. Remember the limit it had, for the wallet a later recovery adopts, and tell the phone
      // and every alert contact, old and new: contacts exist to notice what the owner did not do.
      const wasOff = isLimitOff(current);
      const nowOff = isLimitOff(rules);
      const noticeId = `limit-${draft.nextActivityId}`;
      if (nowOff && !wasOff) {
        w.limitBeforeOff = current.dailyLimitSats;
        const contacts = [...new Set([...current.alertContacts, ...rules.alertContacts])];
        this.addNotice(draft, now, {
          id: noticeId,
          kind: 'limit_off',
          walletId: w.registration.walletId,
          at: now,
          sequence,
          limitSats: current.dailyLimitSats,
          recipients: [w.registration.appNostrPubkey, ...contacts.filter((c) => c !== w.registration.appNostrPubkey)],
          sent: [],
        });
      } else if (wasOff && !nowOff) {
        delete w.limitBeforeOff;
        this.addNotice(draft, now, {
          id: noticeId,
          kind: 'limit_on',
          walletId: w.registration.walletId,
          at: now,
          limitSats: rules.dailyLimitSats,
          reason: by === 'hardware' ? 'hardware' : 'phone',
          recipients: [w.registration.appNostrPubkey],
          sent: [],
        });
      }
      // The contacts may now lock the guardian, or no longer may (rule 8): tell them, so they know whether `LOCK`
      // works; for "off", the contacts of the old rules too (as for "no daily limit": they notice what the owner did not do).
      const lockWas = isContactLockOn(current);
      const lockNow = isContactLockOn(rules);
      if (lockWas !== lockNow) {
        const phone = w.registration.appNostrPubkey;
        const contacts = lockNow ? rules.alertContacts : [...new Set([...current.alertContacts, ...rules.alertContacts])];
        const to = contacts.filter((c) => c !== phone);
        if (to.length)
          this.addNotice(draft, now, {
            id: `lockrule-${draft.nextActivityId}`,
            kind: lockNow ? 'contact_lock_on' : 'contact_lock_off',
            walletId: w.registration.walletId,
            at: now,
            ...(sequence !== undefined ? { sequence } : {}),
            recipients: to,
            sent: [],
          });
      }
      w.rules = rules;
      this.log(draft, now, { type: 'rules_changed', by, sequence, from: current, to: rules });
      return { ok: true as const, rules };
    });
  }

  // -------------------------------------------------------------------------
  // Alert contacts lock the guardian (DESIGN.md, rule 8; docs/design/contact-lock.md)

  /**
   * An alert contact asked to lock the guardian (a `LOCK` DM, dm-lock.ts): allowed only while the active wallet's rules
   * let the contacts lock it (`contactLock`) and only for one of its alert contacts (`not_authorized` otherwise: not
   * a recovery's snapshotted recipients, not the paired phone, nobody else). The service drops key 3 itself; this
   * records it in the activity log and queues the `contact_lock` notice to the paired phone and every other alert
   * contact, delivered and retried like the limit notices. It changes nothing else: rules, recoveries and their timers
   * stay as they are.
   */
  async noteContactLock(contact: string): Promise<Result<{ noticeId: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const pubkey = String(contact).toLowerCase();
      if (!isContactLockOn(w.rules) || !w.rules.alertContacts.includes(pubkey)) return refused({ reason: 'not_authorized' });
      const phone = w.registration.appNostrPubkey;
      const noticeId = `lock-${draft.nextActivityId}`;
      this.addNotice(draft, now, {
        id: noticeId,
        kind: 'contact_lock',
        walletId: w.registration.walletId,
        at: now,
        contact: pubkey,
        recipients: [phone, ...w.rules.alertContacts.filter((c) => c !== pubkey && c !== phone)],
        sent: [],
      });
      this.log(draft, now, { type: 'contact_locked', contact: pubkey });
      return { ok: true as const, noticeId };
    });
  }

  // -------------------------------------------------------------------------
  // Recovery access (a new phone without the old one or its backup)

  /**
   * Lets a new phone read the wallet and start a recovery, on the hardware wallet's word: a BIP137
   * signature over `recoveryAccessMessage(guardian, phone, expiresAt)` by the authorization key (the
   * confirmed one, or after a rotation the expected one). Consumes no sequence number. The grant
   * belongs to the active wallet and ends at `expiresAt`, or when the wallet rotates or retires.
   */
  async grantRecoveryAccess(req: {
    phonePubkey: string;
    guardianPubkey: string;
    approval: { kind: string; expiresAt: number; signature: string };
  }): Promise<Result<{ until: number; renewed: boolean }>> {
    // Anyone may ask once a wallet is paired, so a refusal is decided on the current state without
    // touching the disk (no state write, no log entry per stranger's attempt); only a grant is saved.
    const check = (s: GuardianState, now: number): Refusal | { walletId: string; phone: string; until: number; sig?: string } => {
      const w = s.active;
      if (!w) return { reason: 'not_registered' };
      const reg = w.registration;
      if (!reg.hardwareAuth) return { reason: 'hardware_auth_unconfirmed', walletId: reg.walletId };
      const { expiresAt, signature, kind } = req.approval ?? {};
      const authorizer = this.authorizers.get(kind);
      if (!authorizer || kind !== reg.hardwareAuth.kind) return { reason: 'unsupported_approval', kind: String(kind) };
      if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= now) return { reason: 'approval_expired', expiresAt };
      const maxExpiresAt = Math.floor((now + MAX_APPROVAL_TTL_MS) / 1000);
      if (expiresAt > maxExpiresAt) return { reason: 'approval_expiry_too_far', expiresAt, maxExpiresAt };
      const phone = String(req.phonePubkey).toLowerCase();
      if (typeof signature !== 'string') return { reason: 'approval_invalid_signature' };
      // Version 2 names this wallet; version 1 names none (older phones, or a recovery code without the id).
      const verifies = (walletId?: string) => {
        try {
          const message = recoveryAccessMessage({ guardianPubkey: String(req.guardianPubkey).toLowerCase(), phonePubkey: phone, expiresAt, walletId });
          return authorizer.verify(message, signature, reg.hardwareAuth!);
        } catch {
          return false;
        }
      };
      const v2 = verifies(reg.walletId);
      if (!v2 && !verifies(undefined)) return { reason: 'approval_invalid_signature' };
      const sig = proofId(signature);
      // A version-1 signature whose grant a rotation or retirement revoked does not get it back here.
      if (!v2 && sig && (s.revokedAccess ?? []).some((r) => r.sig === sig && r.until > now)) return { reason: 'approval_revoked' };
      return { walletId: reg.walletId, phone, until: expiresAt * 1000, ...(sig ? { sig } : {}) };
    };
    const first = check(this.state, this.clock.now());
    if ('reason' in first) return refused(first);
    return this.mutate((draft, now) => {
      // Re-checked under the lock: the wallet may have rotated or retired in between.
      const again = check(draft, now);
      if ('reason' in again) return refused(again);
      if (again.walletId !== first.walletId) return refused({ reason: 'not_registered' });
      const w = draft.active!;
      const live = liveGrants(w, now);
      const renewed = live.some((g) => g.pubkey === again.phone);
      w.accessGrants = [
        ...live.filter((g) => g.pubkey !== again.phone),
        { pubkey: again.phone, until: again.until, grantedAt: now, ...(again.sig ? { sig: again.sig } : {}) },
      ].slice(-MAX_ACCESS_GRANTS);
      this.log(draft, now, { type: 'recovery_access_granted', phone: again.phone, until: again.until });
      return { ok: true as const, until: again.until, renewed };
    });
  }

  /** Takes over grants recorded by a guardian version that kept them in service.json (one-time migration). */
  async importAccessGrants(grants: { pubkey: string; until: number }[]): Promise<number> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return 0;
      const incoming = grants.filter((g) => isNostrPubkey(g.pubkey) && Number.isFinite(g.until) && g.until > now);
      const byKey = new Map(liveGrants(w, now).map((g) => [g.pubkey, g]));
      for (const g of incoming) if (!byKey.has(g.pubkey)) byKey.set(g.pubkey, { pubkey: g.pubkey, until: g.until, grantedAt: now });
      w.accessGrants = [...byKey.values()].slice(-MAX_ACCESS_GRANTS);
      return incoming.length;
    });
  }

  // -------------------------------------------------------------------------
  // Delay & Notify recovery

  /**
   * Starts a recovery with a sweep signed (on every input) by the surviving
   * key, paying only to `destinationDescriptor`, which must keep that key and
   * drop the other user key. `initiator` is the nostr key that asked (it will
   * be the destination wallet's paired phone if the guardian adopts it).
   */
  async startRecovery(req: { psbt: Uint8Array; destinationDescriptor: string; initiator?: string }): Promise<Result<{ recovery: RecoveryView }>> {
    const chain = await this.chainTime();
    return this.mutate((draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_start_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) {
        const retired = this.retiredOwner(draft, req.psbt);
        return refused(retired ? { reason: 'wallet_retired', walletId: retired } : { reason: 'not_registered' });
      }
      const { registration: reg, rules } = w;
      const running = activeRecovery(draft);
      if (running) return refuse({ reason: 'recovery_in_progress', recoveryId: running.id });
      // A wallet whose sweep was co-signed but not accepted by a node yet (so not rotated) may still
      // start another recovery: e.g. one with a higher fee when the first sweep cannot be relayed.

      const wallet = this.wallet(reg);
      let dest: MultisigWallet;
      try {
        dest = MultisigWallet.fromDescriptor(req.destinationDescriptor, wallet.network);
      } catch (e) {
        return refuse({ reason: 'invalid_destination', detail: (e as Error).message });
      }
      if (keySetOf(dest) === keySetOf(wallet)) return refuse({ reason: 'invalid_destination', detail: 'destination is the current wallet' });
      if (this.retiredKeySet(draft, dest)) return refuse({ reason: 'invalid_destination', detail: 'destination is a wallet this guardian retired' });

      const checked = inspectPsbt(req.psbt, wallet, dest);
      if (!checked.ok) {
        const retired = checked.refusal.reason === 'foreign_input' ? this.retiredOwner(draft, req.psbt) : undefined;
        return refuse(retired ? { reason: 'wallet_retired', walletId: retired } : checked.refusal);
      }
      const { analysis, toTarget, targetOut } = checked.inspection;

      const roles = new Set<Role>();
      for (const inp of analysis.inputs) {
        if (inp.signedBy.length !== 1)
          return refuse({ reason: 'recovery_signers', detail: `input ${inp.index} has ${inp.signedBy.length} signatures, expected 1` });
        roles.add(inp.signedBy[0]);
      }
      if (roles.size !== 1) return refuse({ reason: 'recovery_signers', detail: 'inputs are signed by different keys' });
      const surviving = [...roles][0];
      if (surviving === 'cosigner') return refuse({ reason: 'recovery_signers', detail: 'the sweep must be signed by the phone or the hardware wallet' });
      const lost: SurvivingRole = surviving === 'app' ? 'hardware' : 'app';

      const oldAcct = wallet.accountPubkeys();
      const newAcct = dest.accountPubkeys();
      if (!eqHex(newAcct[surviving], oldAcct[surviving])) return refuse({ reason: 'destination_drops_surviving_key', survivingRole: surviving });
      if (ROLES.some((r) => eqHex(newAcct[r], oldAcct[lost]))) return refuse({ reason: 'destination_keeps_lost_key', lostRole: lost });
      const stray = toTarget.findIndex((t) => !t);
      if (stray >= 0) return refuse({ reason: 'sweep_not_to_destination', output: stray });
      if (analysis.fee > rules.sweepFeeCapSats) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: analysis.fee, cap: rules.sweepFeeCapSats });

      // The delay counts from the later of the clock and the chain's median time past, so a clock set
      // back cannot shorten it; and it must span its blocks too. No chain data: no start (the system
      // clock alone is not trusted with the delay).
      if (!chain) return refuse({ reason: 'chain_unavailable', detail: 'the guardian cannot read the chain tip to anchor the recovery delay' });
      const anchoredAt = Math.max(now, chain.medianTimePastMs);

      const initiator = typeof req.initiator === 'string' && isNostrPubkey(req.initiator.toLowerCase()) ? req.initiator.toLowerCase() : undefined;
      const rec: RecoveryRecord = {
        id: `${draft.recoveries.length + 1}-${analysis.txid.slice(0, 12)}`,
        walletId: reg.walletId,
        status: 'pending',
        survivingRole: surviving,
        ...(initiator ? { initiator } : {}),
        sweepPsbt: base64.encode(req.psbt),
        sweepTxid: analysis.txid,
        destinationDescriptor: dest.descriptor(),
        destinationWalletId: dest.fingerprint(),
        amountSats: targetOut,
        feeSats: analysis.fee,
        delayDays: rules.recoveryDelayDays,
        feeCapSats: rules.sweepFeeCapSats,
        recipients: [...new Set([reg.appNostrPubkey, ...rules.alertContacts])],
        startedAt: now,
        anchoredAt,
        startHeight: chain.height,
        readyAt: anchoredAt + rules.recoveryDelayDays * DAY,
        alertsSent: {},
      };
      draft.recoveries.push(rec);
      this.log(draft, now, {
        type: 'recovery_started',
        recoveryId: rec.id,
        survivingRole: surviving,
        readyAt: rec.readyAt,
        amountSats: rec.amountSats,
        feeSats: rec.feeSats,
        destinationWalletId: rec.destinationWalletId,
      });
      return { ok: true as const, recovery: viewOf(rec, now) };
    });
  }

  /**
   * Replaces the running recovery's sweep (`recovery.update`), so coins that arrived after the start
   * (dust, a late deposit) do not block it: a sweep must move every coin. The delay is NOT restarted,
   * so the new sweep may only add coins: same destination, every input the wallet's and signed by the
   * same surviving key alone, a superset of the current sweep's inputs, and the fee within the cap.
   * `completeRecovery` checks all of it again.
   */
  async updateRecovery(req: { recoveryId: string; psbt: Uint8Array }): Promise<Result<{ recovery: RecoveryView; addedInputs: number }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_update_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const rec = activeRecovery(draft);
      if (!rec || rec.id !== req.recoveryId) return refuse({ reason: 'no_recovery' });
      const wallet = this.wallet(w.registration);
      const dest = MultisigWallet.fromDescriptor(rec.destinationDescriptor, wallet.network);
      const checked = inspectPsbt(req.psbt, wallet, dest);
      if (!checked.ok) return refuse(checked.refusal);
      const { analysis, toTarget, targetOut } = checked.inspection;
      if (analysis.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== rec.survivingRole))
        return refuse({ reason: 'recovery_signers', detail: `every input must be signed by the surviving key (${rec.survivingRole}) alone` });
      const stray = toTarget.findIndex((t) => !t);
      if (stray >= 0) return refuse({ reason: 'sweep_not_to_destination', output: stray });
      const before = inspectPsbt(base64.decode(rec.sweepPsbt), wallet, dest);
      if (!before.ok) return refuse(before.refusal);
      const spent = new Set(analysis.inputs.map((i) => i.outpoint));
      const missing = before.inspection.analysis.inputs.find((i) => !spent.has(i.outpoint));
      if (missing) return refuse({ reason: 'invalid_recovery_update', detail: `the new sweep must still spend ${missing.outpoint}` });
      const cap = rec.feeCapSats < w.rules.sweepFeeCapSats ? rec.feeCapSats : w.rules.sweepFeeCapSats;
      if (analysis.fee > cap) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: analysis.fee, cap });
      const addedInputs = spent.size - before.inspection.analysis.inputs.length;
      rec.sweepPsbt = base64.encode(req.psbt);
      rec.sweepTxid = analysis.txid;
      rec.amountSats = targetOut;
      rec.feeSats = analysis.fee;
      this.log(draft, now, { type: 'recovery_updated', recoveryId: rec.id, sweepTxid: analysis.txid, amountSats: targetOut, feeSats: analysis.fee, addedInputs });
      return { ok: true as const, recovery: viewOf(rec, now), addedInputs };
    });
  }

  /**
   * Cancels the running recovery. Allowed for the paired phone, any alert
   * contact (by authenticated nostr pubkey), or the hardware wallet (signed
   * approval). Unless the canceller holds the key that started the recovery,
   * the cancel is "contested" and phone-only payments stay paused until the
   * hardware wallet resumes them.
   */
  async cancelRecovery(actor: CancelActor): Promise<Result<{ recovery: RecoveryView; contested: boolean }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_cancel_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const { registration: reg, rules } = w;
      const rec = activeRecovery(draft);
      if (!rec) return refuse({ reason: 'no_recovery' });
      let by: CancelledBy;
      if (actor?.kind === 'nostr') {
        const pk = String(actor.pubkey).toLowerCase();
        if (pk === reg.appNostrPubkey) by = { kind: 'app', pubkey: pk };
        else if (rec.recipients.includes(pk) || rules.alertContacts.includes(pk)) by = { kind: 'contact', pubkey: pk };
        else return refuse({ reason: 'not_authorized' });
      } else if (actor?.kind === 'hardware') {
        const r = this.checkApproval(draft, now, actor.approval, { action: 'cancel-recovery', recoveryId: rec.id });
        if (r) return refuse(r);
        by = { kind: 'hardware', sequence: actor.approval.sequence };
      } else {
        return refuse({ reason: 'not_authorized' });
      }
      const contested = !(
        (by.kind === 'app' && rec.survivingRole === 'app') ||
        (by.kind === 'hardware' && rec.survivingRole === 'hardware')
      );
      rec.status = 'cancelled';
      rec.cancelledAt = now;
      rec.cancelledBy = by;
      if (contested) w.phoneSpending = { state: 'paused_contested', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_cancelled', recoveryId: rec.id, by, contested });
      return { ok: true as const, recovery: viewOf(rec, now), contested };
    });
  }

  /** After the delay, co-signs the sweep and returns it (and the raw tx) for broadcast. */
  async completeRecovery(): Promise<Result<{ psbt: Uint8Array; txHex: string; txid: string; recovery: RecoveryView }>> {
    const chain = await this.chainTime();
    return this.mutate(async (draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_complete_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const { registration: reg, rules } = w;
      const rec = activeRecovery(draft);
      if (!rec) return refuse({ reason: 'no_recovery' });
      if (rec.walletId !== reg.walletId) return refuse({ reason: 'not_adoptable', detail: 'the recovery is not of the active wallet' });
      if (now < rec.readyAt) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt });
      // Three clocks must agree the delay is over: the system clock (above), the chain's median time
      // past, and the block count since the start.
      if (!chain) return refuse({ reason: 'chain_unavailable', detail: 'the guardian cannot read the chain tip to check the recovery delay' });
      if (chain.medianTimePastMs < rec.readyAt)
        return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt, waitingFor: 'chain_time', chainTime: chain.medianTimePastMs });
      if (rec.startHeight !== undefined) {
        const heightNeeded = rec.startHeight + rec.delayDays * this.blocksPerDay(reg.network);
        if (chain.height < heightNeeded) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt, waitingFor: 'blocks', height: chain.height, heightNeeded });
      }

      // Re-check everything from the stored PSBT rather than trusting what was checked at start.
      const wallet = this.wallet(reg);
      const dest = MultisigWallet.fromDescriptor(rec.destinationDescriptor, wallet.network);
      const psbt = base64.decode(rec.sweepPsbt);
      const checked = inspectPsbt(psbt, wallet, dest);
      if (!checked.ok) return refuse(checked.refusal);
      const { analysis, toTarget } = checked.inspection;
      const stray = toTarget.findIndex((t) => !t);
      if (stray >= 0) return refuse({ reason: 'sweep_not_to_destination', output: stray });
      if (analysis.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== rec.survivingRole))
        return refuse({ reason: 'recovery_signers', detail: 'stored sweep is not signed by the surviving key alone' });
      const cap = rec.feeCapSats < rules.sweepFeeCapSats ? rec.feeCapSats : rules.sweepFeeCapSats;
      if (analysis.fee > cap) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: analysis.fee, cap });

      if (!this.signer) return refuse({ reason: 'guardian_locked' });
      const signed = await addCosignerSignatures(psbt, analysis, this.signer);
      const { txHex, txid } = finalizePsbt(signed);
      rec.status = 'completed';
      rec.completedAt = now;
      w.phoneSpending = { state: 'retired', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_completed', recoveryId: rec.id, txid });
      return { ok: true as const, psbt: signed, txHex, txid, recovery: viewOf(rec, now) };
    });
  }

  /**
   * Wallet rotation after a completed recovery, once its sweep has been accepted by a node (the
   * service calls this after a successful broadcast; see DESIGN.md, "Recovery flows", for why not at
   * completion and not at confirmation). The swept wallet is retired and its recovery access grants
   * revoked. The destination becomes the active wallet when it holds this guardian's key and the
   * guardian knows its phone; otherwise the guardian is left unpaired and the destination can be
   * paired like any wallet.
   *
   * Adopted wallet: the rules carry over; the paired phone is the recovery's
   * initiator (the surviving phone, or the new phone admitted by `recovery.access`); the hardware
   * authorization key is the old one when the hardware wallet survived, else the same path below the
   * new hardware xpub when the old path lay below the old one, else unknown. Either way unconfirmed:
   * hardware approvals wait for `confirmHardwareAuth`.
   */
  async rotateAfterSweep(recoveryId: string): Promise<Result<RotationResult>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const old = w.registration;
      const rec = draft.recoveries.find((r) => r.id === recoveryId);
      if (!rec || rec.status !== 'completed') return refused({ reason: 'no_recovery' });
      if (rec.walletId !== old.walletId) return refused({ reason: 'not_adoptable', detail: 'the recovery is not of the active wallet' });
      if (rec.rotatedAt !== undefined) return refused({ reason: 'not_adoptable', detail: 'already rotated' });

      let next: Registration | undefined;
      let nextMarks: HighWater | undefined;
      let detail: string | undefined;
      const network = getNetwork(old.network);
      try {
        const dest = MultisigWallet.fromDescriptor(rec.destinationDescriptor, network);
        const acct = dest.accountPubkeys();
        const phone = rec.initiator ?? (rec.survivingRole === 'app' ? old.appNostrPubkey : undefined);
        if (hex.encode(acct.cosigner) !== old.cosignerAccountPubkey) detail = 'the new wallet uses another guardian key';
        else if (new Set(ROLES.map((r) => hex.encode(acct[r]))).size !== 3) detail = 'the new wallet does not have three distinct keys';
        else if (keySetOf(dest) === keySetOf(this.wallet(old)) || this.retiredKeySet(draft, dest)) detail = 'the new wallet was retired before';
        else if (!phone) detail = 'the phone that started the recovery is not known; pair the new wallet with a pairing code';
        else {
          let hardwareAuth: HardwareAuthKey | undefined;
          const prev = old.hardwareAuth;
          if (prev && rec.survivingRole === 'hardware') hardwareAuth = { ...prev };
          else if (prev) {
            const rest = belowHardwareAccount(this.wallet(old), prev.path);
            if (rest !== undefined) {
              const path = `m/${dest.keys.hardware.originPath.replace(/h/g, "'")}/${rest}`;
              const pubkey = hex.encode(HDKey.fromExtendedKey(dest.keys.hardware.xpub, network.bip32).derive(`m/${rest}`).publicKey!);
              hardwareAuth = { kind: prev.kind, pubkey, path };
            }
          }
          next = {
            walletId: dest.fingerprint(),
            network: old.network,
            descriptor: dest.descriptor(),
            cosignerAccountPubkey: old.cosignerAccountPubkey,
            ...(hardwareAuth ? { hardwareAuth } : {}),
            hardwareAuthConfirmed: false,
            appNostrPubkey: phone,
            registeredAt: now,
            origin: { kind: 'recovery', recoveryId: rec.id, fromWalletId: old.walletId },
            // Same key 3, so the same way to derive it.
            ...(old.key3Mix ? { key3Mix: { ...old.key3Mix } } : {}),
          };
          // The sweep's outputs are the new wallet's first coins: its scans start from them.
          const sw = inspectPsbt(base64.decode(rec.sweepPsbt), this.wallet(old), dest);
          if (sw.ok) nextMarks = sw.inspection.selfIndexes;
        }
      } catch (e) {
        detail = `the new wallet's descriptor does not parse (${(e as Error).message})`;
      }

      // A completed recovery means a key was lost or taken: the adopted wallet starts with the daily limit ON, at the
      // value it had before it was turned off (0, "never", when that is not known), until the hardware wallet confirms
      // the new wallet and turns it off again.
      const limitRestored = isLimitOff(w.rules) ? (w.limitBeforeOff ?? 0n) : undefined;
      const rules = limitRestored !== undefined ? { ...w.rules, dailyLimitSats: limitRestored } : w.rules;
      // Any other recovery of the swept wallet (one started between this one's completion and now, by
      // whoever holds a key of it) is closed: it can never complete against a retired wallet, and must
      // not stay "running" against the wallet adopted next.
      for (const other of draft.recoveries) {
        if (other.walletId !== old.walletId || other.id === rec.id || (other.status !== 'pending' && other.status !== 'ready')) continue;
        other.status = 'cancelled';
        other.cancelledAt = now;
        other.cancelledBy = { kind: 'superseded', recoveryId: rec.id };
        this.log(draft, now, { type: 'recovery_cancelled', recoveryId: other.id, by: other.cancelledBy, contested: false });
      }
      const revokedGrants = this.retireActive(draft, now, { reason: 'recovered', recoveryId: rec.id, ...(next ? { successorWalletId: next.walletId } : {}) });
      // The limit window starts empty: phone payments were paused for the whole delay (7 days at least),
      // so none of the old wallet's spends is still inside the 24 h window.
      // The Savings wallet the phone had is still the owner's (the guardian holds no key of it): it stays watched, so the
      // tripwire keeps working and a new phone without a backup finds it again (`savings.get`). The phone registers
      // another one once it replaced a Savings key.
      if (next)
        draft.active = {
          registration: next,
          rules,
          spends: [],
          phoneSpending: { state: 'enabled' },
          accessGrants: [],
          ...(nextMarks ? { highWater: nextMarks } : {}),
          ...(w.savings ? { savings: w.savings } : {}),
        };
      rec.rotatedAt = now;
      if (next && limitRestored !== undefined)
        this.addNotice(draft, now, {
          id: `limit-${draft.nextActivityId}`,
          kind: 'limit_on',
          walletId: next.walletId,
          at: now,
          limitSats: limitRestored,
          reason: 'recovery',
          recipients: [next.appNostrPubkey],
          sent: [],
        });
      this.log(draft, now, {
        type: 'wallet_rotated',
        recoveryId: rec.id,
        fromWalletId: old.walletId,
        ...(next ? { toWalletId: next.walletId, phone: next.appNostrPubkey } : {}),
        ...(detail ? { detail } : {}),
        revokedGrants,
        ...(next && limitRestored !== undefined ? { limitRestoredSats: limitRestored } : {}),
      });
      return { ok: true as const, retiredWalletId: old.walletId, ...(next ? { adopted: next } : {}), ...(detail ? { detail } : {}), revokedGrants };
    });
  }

  /**
   * "Replace guardian", the old guardian's side: the phone and the hardware wallet (a `retire-wallet`
   * approval) retire the active wallet. From then on nothing is co-signed or started for it, its
   * recovery access grants are gone, and pairing is open for a new wallet. Not while a recovery runs
   * (cancel it first): a hardware-held thief must not be able to end the guardian's protection in
   * the middle of its own recovery.
   */
  async retireWallet(approval: HardwareApproval): Promise<Result<{ walletId: string; retiredAt: number }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'wallet_retire_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const active = activeRecovery(draft);
      if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
      const r = this.checkApproval(draft, now, approval, { action: 'retire-wallet' });
      if (r) return refuse(r);
      const walletId = w.registration.walletId;
      const revokedGrants = this.retireActive(draft, now, { reason: 'retired', sequence: approval.sequence });
      this.log(draft, now, { type: 'wallet_retired', walletId, sequence: approval.sequence, revokedGrants });
      return { ok: true as const, walletId, retiredAt: now };
    });
  }

  /** Re-enables phone-only payments after a contested recovery. Needs the hardware wallet. */
  async resumePhoneSpending(approval: HardwareApproval): Promise<Result<{}>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'phone_spending_resume_refused', refusal });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const active = activeRecovery(draft);
      if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
      if (w.phoneSpending.state !== 'paused_contested') return refuse({ reason: 'nothing_to_resume' });
      const r = this.checkApproval(draft, now, approval, { action: 'resume-phone' });
      if (r) return refuse(r);
      w.phoneSpending = { state: 'enabled' };
      this.log(draft, now, { type: 'phone_spending_resumed', sequence: approval.sequence });
      return { ok: true as const };
    });
  }

  /**
   * Forgets every wallet (active and retired), recovery and limit record: the web UI's "reset
   * guardian", which the service only runs together with a new key 3 (see guardian.ts). Refused
   * while a recovery is pending or ready, so a reset can never make a running recovery disappear.
   */
  async reset(): Promise<Result<{ forgotten: string[] }>> {
    return this.mutate((draft, now) => {
      const running = activeRecovery(draft);
      if (running) return refused({ reason: 'recovery_in_progress', recoveryId: running.id });
      const forgotten = [...(draft.active ? [draft.active.registration.walletId] : []), ...draft.retired.map((r) => r.registration.walletId)];
      const nextActivityId = draft.nextActivityId;
      Object.assign(draft, emptyState(), { nextActivityId });
      delete draft.active;
      this.log(draft, now, { type: 'guardian_reset' });
      return { ok: true as const, forgotten };
    });
  }

  /** Records that the service delivered `alertId` to `recipients`. */
  async markAlertSent(alertId: string, recipients: string[]): Promise<Result<{}>> {
    return this.mutate((draft, now) => {
      const rec = draft.recoveries.find((r) => isKnownAlertId(r, alertId));
      if (!rec) return refused({ reason: 'unknown_alert', alertId });
      const sent = new Set(rec.alertsSent[alertId] ?? []);
      const added = recipients.map((r) => r.toLowerCase()).filter((r) => rec.recipients.includes(r) && !sent.has(r));
      for (const r of added) sent.add(r);
      rec.alertsSent[alertId] = [...sent];
      if (added.length) this.log(draft, now, { type: 'alert_sent', alertId, recipients: added });
      return { ok: true as const };
    });
  }

  /** Records that the service delivered limit notice `noticeId` to `recipients`. */
  async markNoticeSent(noticeId: string, recipients: string[]): Promise<Result<{}>> {
    return this.mutate((draft, now) => {
      const n = draft.notices?.find((x) => x.id === noticeId);
      if (!n) return refused({ reason: 'unknown_alert', alertId: noticeId });
      const added = [...new Set(recipients.map((r) => r.toLowerCase()))].filter((r) => n.recipients.includes(r) && !n.sent.includes(r));
      n.sent.push(...added);
      if (added.length) this.log(draft, now, { type: 'limit_alert_sent', noticeId, kind: n.kind, recipients: added });
      return { ok: true as const };
    });
  }

  /** Applies time-based transitions (pending -> ready) and persists them. Call periodically. */
  async tick(): Promise<void> {
    await this.mutex.run(async () => {
      const draft = cloneState(this.state);
      if (!this.refresh(draft, this.clock.now())) return;
      await this.store.save(draft);
      this.state = draft;
    });
  }
}
