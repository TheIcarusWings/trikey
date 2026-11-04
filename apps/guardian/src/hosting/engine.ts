/**
 * One guest wallet's policy engine (docs/design/family-hosting.md, sections 2, 4 and 5): the host's `PolicyEngine`
 * rules for a wallet the guardian knows only by its three account pubkeys (BIP 89 delegation, "private mode").
 *
 * The host's own wallet never comes here: it keeps `PolicyEngine` and `guardian-state.json`, byte for byte as before.
 * Each guest slot gets one `HostedEngine` with its own state file, mutex, counters, caps and recovery ids
 * (`<slotId>g<n>-<txid12>`), and its own key 3 (`trikey/key3-hosted/v1`), so nothing a guest sends can reach the host's
 * wallet or another guest's.
 *
 * What differs from the host's engine, and why:
 * - Inputs are the wallet's when their tweaks rebuild their script from the account pubkeys (core's `analyzePsbt`); an
 *   output is change when its tweaks do (`isSelf`). There is no descriptor, so no index window ("change only within
 *   reach of a scan" cannot be checked without learning the addresses, section 4). Instead every change coin key 3
 *   co-signs goes into the slot's LEDGER, which the phone reads back (`hosted.coins`) and a recovery must sweep.
 * - The hardware authorization key is `hardware account key + tweak·G` at `m/48'/<coin>'/0'/2'/0/0`, the tweak sent by
 *   the phone (section 7), since the guardian never sees the hardware xpub.
 * - A recovery names its destination by account pubkeys and brings the destination's encrypted wallet map; its sweep's
 *   outputs must be tweak-proven to the destination. Completion needs every unspent ledger coin swept or named in
 *   `abandon` (checked by the hosted recovery runner, with the host's Electrs, by the coins' own scripts).
 * - Phase 1 features only (decision 12): the daily limit, the delay, the fee cap, alert contacts and hardware-approved
 *   rule changes. No "limit off", no contact lock, no Savings, no silent payments, no watched wallet.
 */
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  PsbtError,
  ROLES,
  analyzePsbt,
  finalizePsbt,
  findTweak,
  getNetwork,
  keySetId,
  parsePsbt,
  tweakPublicKey,
  tweakToBytes,
  type AccountPubkeys,
  type NetworkName,
  type PsbtAnalysis,
  type Role,
} from '@trikey/core';
import { Mutex } from '../files.js';
import { dueAlerts as computeDueAlerts, isKnownAlertId, type DueAlert } from '../policy/alerts.js';
import { bip137Authorizer, approvalMessage, pairingMessage, proofId, recoveryAccessMessage, type HardwareAction, type HardwareAuthorizer } from '../policy/authorizer.js';
import { DAY, systemClock, type ChainTime, type ChainTimeSource, type Clock } from '../policy/clock.js';
import { BLOCKS_PER_DAY, MAINNET_CONTACT_REQUIRED, LIMIT_OFF_AT_PAIRING, MAX_ACCESS_GRANTS, MAX_APPROVAL_TTL_MS, MAX_CLOCK_AHEAD_OF_CHAIN_MS, MAX_SEQUENCE_STEP, NOTICE_TTL_MS, isRefusalEvent, policyWarnings, pruneActivity, type CosignResult, type GuardianStatus, type PhoneSpendingStatus, type RecoveryView } from '../policy/engine.js';
import { addCosignerSignatures } from '../policy/inspect.js';
import { pruneSpends, splitOutflow, usageWith, windowUsage } from '../policy/limit.js';
import { isContactLockOn, isLimitOff, isNostrPubkey, normalizeRules, phoneMayApply } from '../policy/rules.js';
import type { CosignerSigner } from '../policy/signer.js';
import type { AccessGrant, CancelActor, CancelledBy, HardwareApproval, Rules, SurvivingRole } from '../policy/index.js';
import {
  HOSTED_MAX_ACTIVITY,
  HOSTED_MAX_REFUSALS,
  MAX_LEDGER_COINS,
  MAX_WALLET_MAPS,
  emptyHostedState,
  type HostedActivityEntry,
  type HostedActivityEvent,
  type HostedNotice,
  type HostedRecoveryRecord,
  type HostedRefusal,
  type HostedRegistration,
  type HostedResult,
  type HostedState,
  type HostedWallet,
  type LedgerEntry,
} from './types.js';
import { MAX_WALLET_MAP_BYTES } from '@trikey/protocol';

const MAX_NOTICES = 32;

/** Where a hosted engine keeps its state. `save` must be durable before it resolves. */
export interface HostedStore {
  load(): Promise<HostedState | undefined>;
  save(state: HostedState): Promise<void>;
}

const BIGINT_TAG = '$bigint';
export function serializeHosted(state: HostedState): string {
  return JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v), 2);
}
export function deserializeHosted(text: string): HostedState {
  const s = JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof v[BIGINT_TAG] === 'string' && /^-?\d+$/.test(v[BIGINT_TAG])) return BigInt(v[BIGINT_TAG]);
    }
    return v;
  }) as HostedState;
  if (!s || s.version !== 1 || s.kind !== 'hosted' || !Array.isArray(s.retired) || !Array.isArray(s.recoveries)) throw new Error('unsupported hosted slot state');
  s.notices ??= [];
  s.maps ??= {};
  return s;
}

export class MemoryHostedStore implements HostedStore {
  private text?: string;
  saves = 0;
  async load() {
    return this.text === undefined ? undefined : deserializeHosted(this.text);
  }
  async save(state: HostedState) {
    this.text = serializeHosted(state);
    this.saves++;
  }
}

export interface HostedEngineOptions {
  slotId: string;
  store: HostedStore;
  clock?: Clock;
  chain?: ChainTimeSource;
  blocksPerDay?: number;
  signer?: CosignerSigner;
  authorizers?: HardwareAuthorizer[];
  /** Override `MAX_LEDGER_COINS` (tests). */
  maxLedgerCoins?: number;
}

export interface HostedRegisterInput {
  network: NetworkName;
  accountPubkeys: { app: string; hardware: string };
  /** Key 3 of this slot (its account pubkey goes in the cosigner role). */
  cosignerAccountPubkey: string;
  rules: Rules;
  hardwareAuth: { pubkey: string; path: string; tweak: string };
  hardwareAuthProof: string;
  appNostrPubkey: string;
  walletLabel: string;
  walletMap: string;
  /** Key sets this slot must never register (the host's wallets, other slots'): compared as sorted pubkeys. */
  forbiddenKeySets?: Set<string>;
}

export type HostedRecoveryView = RecoveryView & { abandon: string[]; abandonSats: bigint };

export interface HostedStatus extends Omit<GuardianStatus, 'recovery'> {
  recovery?: HostedRecoveryView;
}

/** `m/48'/<coin>'/0'/2'/0/0`, both apostrophe and `h` spellings: the only authorization path a hosted wallet may use. */
export function hostedAuthPath(network: NetworkName): string {
  return `m/48'/${getNetwork(network).coinType}'/0'/2'/0/0`;
}
const samePath = (a: string, b: string) => a.replace(/h/g, "'") === b.replace(/h/g, "'");

/** Sorted account pubkeys: what "the same wallet" means to key 3. */
export function keySetKey(a: { app: string; hardware: string; cosigner: string }): string {
  return [a.app, a.hardware, a.cosigner].map((x) => x.toLowerCase()).sort().join(',');
}

const refused = (refusal: HostedRefusal) => ({ ok: false as const, refusal });
const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
function eventKey(e: object): string {
  const { id: _i, at: _a, count: _c, lastAt: _l, ...rest } = e as Record<string, unknown>;
  return JSON.stringify(rest, bigintJson);
}
const withoutActivity = (s: HostedState) => JSON.stringify({ ...s, activity: undefined, nextActivityId: undefined }, bigintJson);
const clone = (s: HostedState) => deserializeHosted(serializeHosted(s));
const isPubkey = (s: unknown): s is string => typeof s === 'string' && /^0[23][0-9a-f]{64}$/.test(s);
const acctOf = (a: { app: string; hardware: string; cosigner: string }): AccountPubkeys => ({ app: hex.decode(a.app), hardware: hex.decode(a.hardware), cosigner: hex.decode(a.cosigner) });
const outpointOf = (txid: string, vout: number) => `${txid}:${vout}`;

function activeRecovery(s: HostedState): HostedRecoveryRecord | undefined {
  const id = s.active?.registration.walletId;
  if (!id) return undefined;
  for (let i = s.recoveries.length - 1; i >= 0; i--) {
    const r = s.recoveries[i];
    if (r.walletId === id) return r.status === 'pending' || r.status === 'ready' ? r : undefined;
  }
  return undefined;
}

function viewOf(r: HostedRecoveryRecord, now: number): HostedRecoveryView {
  return {
    id: r.id,
    status: r.status === 'pending' && now >= r.readyAt ? 'ready' : r.status,
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
    abandon: [...r.abandon],
    abandonSats: r.abandonSats,
  };
}

function liveGrants(w: HostedWallet, now: number): AccessGrant[] {
  return w.accessGrants.filter((g) => g.until > now);
}

/** Maps core's PSBT errors to the engine's refusals (as the host's inspect.ts does). */
function psbtRefusal(e: unknown): HostedRefusal {
  if (!(e instanceof PsbtError)) return { reason: 'invalid_psbt', detail: e instanceof Error ? e.message : String(e) };
  switch (e.code) {
    case 'missing_non_witness_utxo':
      return { reason: 'missing_non_witness_utxo', input: e.input ?? -1 };
    case 'non_witness_utxo_mismatch':
      return { reason: 'non_witness_utxo_mismatch', input: e.input ?? -1 };
    case 'missing_tweaks':
    case 'foreign_input':
      return { reason: 'foreign_input', input: e.input, detail: e.message };
    case 'unknown_signer':
    case 'invalid_signature':
      return { reason: 'invalid_signature', input: e.input, detail: e.message };
    default:
      return { reason: 'invalid_psbt', detail: e.message };
  }
}

/** Checks a PSBT against the wallet's account pubkeys (inputs) and `outputs` (default the same): no descriptor involved. */
function analyze(psbt: Uint8Array, acct: AccountPubkeys, network: NetworkName, outputs?: AccountPubkeys): { ok: true; analysis: PsbtAnalysis } | { ok: false; refusal: HostedRefusal } {
  let analysis: PsbtAnalysis;
  try {
    analysis = analyzePsbt(psbt, acct, getNetwork(network), { requireNonWitnessUtxo: true, ...(outputs ? { outputsAcct: outputs } : {}) });
  } catch (e) {
    return { ok: false, refusal: psbtRefusal(e) };
  }
  if (!analysis.inputs.length) return { ok: false, refusal: { reason: 'invalid_psbt', detail: 'no inputs' } };
  if (!analysis.outputs.length) return { ok: false, refusal: { reason: 'invalid_psbt', detail: 'no outputs' } };
  return { ok: true, analysis };
}

/** The ledger entries of a co-signed PSBT's self outputs: outpoint, script, amount and the three tweaks it carried. */
function selfOutputs(psbt: Uint8Array, analysis: PsbtAnalysis, acct: AccountPubkeys, now: number): LedgerEntry[] {
  const tx = parsePsbt(psbt);
  const out: LedgerEntry[] = [];
  for (const o of analysis.outputs) {
    if (!o.isSelf) continue;
    const prop = tx.getOutput(o.index).proprietary;
    const t = {} as Record<Role, string>;
    for (const r of ROLES) t[r] = hex.encode(tweakToBytes(findTweak(prop, acct[r])!));
    out.push({ txid: analysis.txid, vout: o.index, valueSats: o.amount, script: hex.encode(o.script), tweaks: t, at: now });
  }
  return out;
}

export class HostedEngine {
  readonly slotId: string;
  private readonly mutex = new Mutex();
  private readonly clock: Clock;
  private readonly chain?: ChainTimeSource;
  private readonly blocksPerDayOverride?: number;
  private readonly authorizers: Map<string, HardwareAuthorizer>;
  private signer?: CosignerSigner;
  private nextSigner?: CosignerSigner;
  private readonly maxLedger: number;

  private constructor(
    private readonly store: HostedStore,
    private state: HostedState,
    opts: HostedEngineOptions,
  ) {
    this.slotId = opts.slotId;
    this.clock = opts.clock ?? systemClock;
    this.chain = opts.chain;
    this.blocksPerDayOverride = opts.blocksPerDay;
    this.authorizers = new Map((opts.authorizers ?? [bip137Authorizer]).map((a) => [a.kind, a]));
    this.maxLedger = opts.maxLedgerCoins ?? MAX_LEDGER_COINS;
    this.setSigner(opts.signer);
  }

  static async open(opts: HostedEngineOptions): Promise<HostedEngine> {
    if (!/^[0-9a-f]{16}$/.test(opts.slotId)) throw new Error('slotId must be 8 bytes of hex');
    const state = (await opts.store.load()) ?? emptyHostedState(opts.slotId);
    if (state.slotId !== opts.slotId) throw new Error('the slot state belongs to another slot');
    return new HostedEngine(opts.store, state, opts);
  }

  // -------------------------------------------------------------------------
  // Key 3

  setSigner(signer: CosignerSigner | undefined): void {
    const reg = this.state.active?.registration;
    if (signer && reg && hex.encode(signer.accountPubkey) !== reg.accountPubkeys.cosigner) throw new Error("signer does not hold the slot's key 3");
    this.signer = signer;
  }

  get locked(): boolean {
    return !this.signer;
  }

  // -------------------------------------------------------------------------
  // Reads

  /** The state as last saved (read-only). */
  get snapshot(): Readonly<HostedState> {
    return this.state;
  }

  registration(): HostedRegistration | undefined {
    return this.state.active?.registration;
  }

  rules(): Rules | undefined {
    return this.state.active?.rules;
  }

  /** Every key set this slot guards or guarded (sorted pubkeys). */
  keySets(): string[] {
    const regs = [...(this.state.active ? [this.state.active.registration] : []), ...this.state.retired.map((r) => r.registration)];
    return regs.map((r) => keySetKey(r.accountPubkeys));
  }

  walletById(walletId: string): HostedRegistration | undefined {
    const a = this.state.active?.registration;
    if (a?.walletId === walletId) return a;
    return this.state.retired.find((r) => r.registration.walletId === walletId)?.registration;
  }

  status(): HostedStatus {
    const s = this.state;
    const now = this.clock.now();
    const w = s.active;
    const reg = w?.registration;
    const active = activeRecovery(s);
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
      dailyLimit: rules ? { limit: rules.dailyLimitSats, used, available: rules.dailyLimitSats > used ? rules.dailyLimitSats - used : 0n } : undefined,
      hardwareConfirmRequired: !!reg && !reg.hardwareAuthConfirmed,
      retiredWallets: s.retired.length,
      warnings: policyWarnings(rules),
    };
  }

  activity(opts: { limit?: number } = {}): HostedActivityEntry[] {
    return this.state.activity.slice(-(opts.limit ?? 100)).reverse();
  }

  /** The running recovery of the active wallet, if any. */
  activeRecord(): HostedRecoveryRecord | undefined {
    return activeRecovery(this.state);
  }

  records(): readonly HostedRecoveryRecord[] {
    return this.state.recoveries;
  }

  /** Co-signatures (not replays) in the last `ms`: the host's web UI shows only this count. */
  cosignCount(sinceMs: number): number {
    return this.state.activity.filter((e) => e.type === 'cosign_signed' && !e.replay && e.at >= sinceMs).length;
  }

  /** Was `txid` co-signed by this slot (a payment or a recovery's sweep)? `tx.broadcast` relays only those. */
  signedTxid(txid: string): boolean {
    const w = this.state.active;
    return !!w?.spends.some((s) => s.txid === txid) || this.state.recoveries.some((r) => r.status === 'completed' && r.sweepTxid === txid);
  }

  /** The active wallet's ledger, oldest first. */
  ledger(): readonly LedgerEntry[] {
    return this.state.active?.ledger ?? [];
  }

  /** The encrypted wallet map of `walletId` (default the active wallet), if the slot keeps one. */
  walletMap(walletId?: string): { walletId: string; map: string | null } | undefined {
    const id = walletId ?? this.state.active?.registration.walletId;
    if (!id) return undefined;
    const known = id === this.state.active?.registration.walletId || this.state.recoveries.some((r) => r.destinationWalletId === id && r.walletId === this.state.active?.registration.walletId);
    if (!known) return undefined;
    return { walletId: id, map: this.state.maps[id] ?? null };
  }

  dueAlerts(): DueAlert[] {
    // The engine's alert schedule reads only what both record types share.
    return computeDueAlerts(this.state.recoveries as never, this.clock.now());
  }

  dueNotices(): (HostedNotice & { recipients: string[] })[] {
    const now = this.clock.now();
    return this.state.notices
      .filter((n) => n.at > now - NOTICE_TTL_MS)
      .map((n) => ({ ...n, recipients: n.recipients.filter((r) => !n.sent.includes(r)) }))
      .filter((n) => n.recipients.length > 0);
  }

  hasRecoveryAccess(pubkey: string): boolean {
    const w = this.state.active;
    return !!w && liveGrants(w, this.clock.now()).some((g) => g.pubkey === pubkey);
  }

  recoveryPeers(): string[] {
    const w = this.state.active;
    return w ? liveGrants(w, this.clock.now()).map((g) => g.pubkey) : [];
  }

  /** The alert contacts of the active wallet and the running recovery's recipients. */
  isAlertContact(pubkey: string): boolean {
    if (this.state.active?.rules.alertContacts.includes(pubkey)) return true;
    return !!activeRecovery(this.state)?.recipients.includes(pubkey);
  }

  blocksPerDay(network: NetworkName): number {
    return this.blocksPerDayOverride ?? BLOCKS_PER_DAY[network] ?? 144;
  }

  heightNeeded(rec: HostedRecoveryRecord): number {
    const reg = this.walletById(rec.walletId);
    return rec.startHeight + rec.delayDays * this.blocksPerDay(reg?.network ?? 'bitcoin');
  }

  // -------------------------------------------------------------------------
  // Internals (as the host's engine)

  private async mutate<T>(fn: (draft: HostedState, now: number) => Promise<T> | T): Promise<T> {
    return this.mutex.run(async () => {
      this.nextSigner = undefined;
      try {
        const draft = clone(this.state);
        const now = this.clock.now();
        this.refresh(draft, now);
        const out = await fn(draft, now);
        if (draft.active) draft.active.spends = pruneSpends(draft.active.spends, now);
        draft.activity = pruneActivity(draft.activity as never, HOSTED_MAX_ACTIVITY, HOSTED_MAX_REFUSALS) as never;
        const refusalOnly = (out as { ok?: unknown })?.ok === false && withoutActivity(draft) === withoutActivity(this.state);
        if (!refusalOnly) await this.store.save(draft);
        this.state = draft;
        if (this.nextSigner && this.signer) this.signer = this.nextSigner;
        return out;
      } finally {
        this.nextSigner = undefined;
      }
    });
  }

  private refresh(draft: HostedState, now: number): boolean {
    const r = activeRecovery(draft);
    if (r && r.status === 'pending' && now >= r.readyAt) {
      r.status = 'ready';
      this.log(draft, now, { type: 'recovery_ready', recoveryId: r.id });
      return true;
    }
    return false;
  }

  private async chainTime(): Promise<ChainTime | undefined> {
    if (!this.chain) return undefined;
    try {
      const t = await this.chain.tip();
      return Number.isSafeInteger(t?.height) && t.height >= 0 && Number.isFinite(t.medianTimePastMs) ? { height: t.height, medianTimePastMs: t.medianTimePastMs } : undefined;
    } catch {
      return undefined;
    }
  }

  private noteChain(draft: HostedState, now: number, chain: ChainTime | undefined): void {
    const seen = draft.chainSeen;
    if (chain && (!seen || chain.height > seen.height || (chain.height === seen.height && chain.medianTimePastMs > seen.medianTimePastMs))) draft.chainSeen = { ...chain, at: now };
  }

  private limitTime(draft: HostedState, now: number, chain: ChainTime | undefined): { ok: true; at: number } | { ok: false; refusal: HostedRefusal } {
    const seen = chain ?? draft.chainSeen;
    if (!seen) return { ok: false, refusal: { reason: 'chain_unavailable', detail: 'no chain data to check the clock against yet' } };
    if (now > seen.medianTimePastMs + MAX_CLOCK_AHEAD_OF_CHAIN_MS) return { ok: false, refusal: { reason: 'clock_ahead_of_chain', systemTime: now, chainTime: seen.medianTimePastMs } };
    return { ok: true, at: Math.max(draft.timeFloor ?? 0, now) };
  }

  private log(draft: HostedState, now: number, event: HostedActivityEvent): void {
    const last = draft.activity[draft.activity.length - 1];
    if (isRefusalEvent(event) && last && last.type === event.type && eventKey(last) === eventKey(event)) {
      last.count = (last.count ?? 1) + 1;
      last.lastAt = now;
      return;
    }
    draft.activity.push({ id: draft.nextActivityId++, at: now, ...event } as HostedActivityEntry);
  }

  private addNotice(draft: HostedState, now: number, notice: HostedNotice): void {
    const live = draft.notices.filter((n) => n.at > now - NOTICE_TTL_MS && n.sent.length < n.recipients.length);
    draft.notices = [...live, notice].slice(-MAX_NOTICES);
  }

  private checkApproval(draft: HostedState, now: number, approval: HardwareApproval, action: HardwareAction): HostedRefusal | undefined {
    const reg = draft.active!.registration;
    if (!reg.hardwareAuthConfirmed || !reg.hardwareAuth) return { reason: 'hardware_auth_unconfirmed', walletId: reg.walletId };
    const authorizer = this.authorizers.get(approval?.kind);
    if (!authorizer || approval.kind !== reg.hardwareAuth.kind) return { reason: 'unsupported_approval', kind: String(approval?.kind) };
    if (!Number.isSafeInteger(approval.sequence) || approval.sequence <= draft.hardwareSequence)
      return { reason: 'approval_stale_sequence', sequence: approval.sequence, lastSequence: draft.hardwareSequence };
    if (approval.sequence > draft.hardwareSequence + MAX_SEQUENCE_STEP) return { reason: 'approval_sequence_too_far', sequence: approval.sequence, lastSequence: draft.hardwareSequence };
    if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt * 1000 <= now) return { reason: 'approval_expired', expiresAt: approval.expiresAt };
    const maxExpiresAt = Math.floor((now + MAX_APPROVAL_TTL_MS) / 1000);
    if (approval.expiresAt > maxExpiresAt) return { reason: 'approval_expiry_too_far', expiresAt: approval.expiresAt, maxExpiresAt };
    let message: string;
    try {
      message = approvalMessage(action, { walletId: reg.walletId, sequence: approval.sequence, expiresAt: approval.expiresAt });
    } catch {
      return { reason: 'approval_invalid_signature' };
    }
    if (typeof approval.signature !== 'string' || !authorizer.verify(message, approval.signature, reg.hardwareAuth)) return { reason: 'approval_invalid_signature' };
    draft.hardwareSequence = approval.sequence;
    return undefined;
  }

  /**
   * The authorization key of a hosted wallet: at `m/48'/<coin>'/0'/2'/0/0`, and `pubkey == hardware + tweak·G`. Whoever
   * signs for that key knows the discrete log of the hardware account key, because the tweak is public (section 7).
   */
  private authKeyRefusal(network: NetworkName, hardware: string, key: { pubkey: string; path: string; tweak: string }): string | undefined {
    if (!isPubkey(key.pubkey)) return 'the authorization key must be a compressed pubkey';
    if (typeof key.path !== 'string' || !samePath(key.path, hostedAuthPath(network))) return `the authorization key of a hosted wallet must be at ${hostedAuthPath(network)}`;
    if (!/^[0-9a-f]{64}$/.test(String(key.tweak))) return 'the authorization tweak must be 32 bytes of hex';
    let derived: string;
    try {
      derived = hex.encode(tweakPublicKey(hex.decode(hardware), BigInt(`0x${key.tweak}`)));
    } catch {
      return 'the authorization tweak is not usable';
    }
    return derived === key.pubkey ? undefined : 'the authorization key is not the hardware account key plus the tweak';
  }

  private retireActive(draft: HostedState, now: number, retirement: HostedState['retired'][number]['retirement']): number {
    const w = draft.active!;
    const live = liveGrants(w, now);
    draft.revokedAccess = [...(draft.revokedAccess ?? []).filter((r) => r.until > now), ...live.flatMap((g) => (g.sig ? [{ sig: g.sig, until: g.until }] : []))].slice(-64);
    draft.retired.push({ registration: w.registration, rules: w.rules, retiredAt: now, retirement });
    draft.active = undefined;
    // Only the maps of wallets still guarded (or being recovered to) are kept.
    draft.maps = {};
    return live.length;
  }

  private phase1Rules(rules: Rules): string | undefined {
    if (isLimitOff(rules)) return 'a hosted wallet cannot turn the daily limit off yet (phase 2)';
    if (isContactLockOn(rules)) return "a hosted wallet's contacts cannot lock the guardian yet (phase 2)";
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Registration (`hosted.pair`)

  async register(input: HostedRegisterInput, signer?: CosignerSigner): Promise<HostedResult<{ walletId: string }>> {
    return this.mutate((draft, now) => {
      if (draft.active) return refused({ reason: 'already_registered' });
      const bad = (detail: string) => refused({ reason: 'invalid_registration', detail });
      let network: ReturnType<typeof getNetwork>;
      try {
        network = getNetwork(input.network);
      } catch {
        return bad('unknown network');
      }
      const keys = { app: String(input.accountPubkeys?.app).toLowerCase(), hardware: String(input.accountPubkeys?.hardware).toLowerCase(), cosigner: String(input.cosignerAccountPubkey).toLowerCase() };
      if (!ROLES.every((r) => isPubkey(keys[r]))) return bad('account pubkeys must be compressed secp256k1 keys');
      try {
        for (const r of ROLES) secp256k1.Point.fromBytes(hex.decode(keys[r]));
      } catch {
        return bad('an account pubkey is not on the curve');
      }
      if (new Set(ROLES.map((r) => keys[r])).size !== 3) return bad('the three keys must be distinct');
      if (signer && hex.encode(signer.accountPubkey) !== keys.cosigner) return bad("the slot's key 3 differs from cosignerAccountPubkey");
      const appNostr = String(input.appNostrPubkey).toLowerCase();
      if (!isNostrPubkey(appNostr)) return bad('appNostrPubkey must be 32-byte hex');
      const label = String(input.walletLabel ?? '').trim();
      if (!label || label.length > 64) return bad('walletLabel must be 1 to 64 characters');
      let rules: Rules;
      try {
        rules = normalizeRules(input.rules);
      } catch (e) {
        return bad(`rules: ${(e as Error).message}`);
      }
      if (network.name === 'bitcoin' && !rules.alertContacts.length) return bad(`rules: ${MAINNET_CONTACT_REQUIRED}`);
      if (isLimitOff(rules)) return bad(`rules: ${LIMIT_OFF_AT_PAIRING}`);
      const phase1 = this.phase1Rules(rules);
      if (phase1) return bad(`rules: ${phase1}`);
      const authRefusal = this.authKeyRefusal(network.name, keys.hardware, input.hardwareAuth);
      if (authRefusal) return bad(authRefusal);
      const walletId = keySetId(acctOf(keys));
      const ks = keySetKey(keys);
      if (draft.retired.some((r) => keySetKey(r.registration.accountPubkeys) === ks)) return refused({ reason: 'wallet_retired', walletId });
      if (input.forbiddenKeySets?.has(ks)) return bad('this key set is already guarded by this guardian');
      const hwKey = { kind: 'bip137' as const, pubkey: input.hardwareAuth.pubkey.toLowerCase(), path: input.hardwareAuth.path };
      const authorizer = this.authorizers.get('bip137')!;
      try {
        authorizer.validateKey(hwKey);
      } catch (e) {
        return bad(`hardwareAuth: ${(e as Error).message}`);
      }
      if (!authorizer.verify(pairingMessage(walletId, keys.cosigner), input.hardwareAuthProof, hwKey)) return bad('hardware pairing proof does not verify');
      const mapBad = this.mapRefusal(input.walletMap);
      if (mapBad) return bad(mapBad);
      draft.active = {
        registration: {
          mode: 'delegated',
          walletId,
          network: network.name,
          accountPubkeys: keys,
          hardwareAuth: { ...hwKey, tweak: input.hardwareAuth.tweak.toLowerCase() },
          hardwareAuthConfirmed: true,
          appNostrPubkey: appNostr,
          walletLabel: label,
          registeredAt: now,
          origin: { kind: 'paired' },
        },
        rules,
        spends: [],
        phoneSpending: { state: 'enabled' },
        accessGrants: [],
        ledger: [],
      };
      draft.maps = { [walletId]: input.walletMap };
      this.log(draft, now, { type: 'hosted_registered', walletId });
      if (signer) this.nextSigner = signer;
      return { ok: true as const, walletId };
    });
  }

  private mapRefusal(map: unknown): string | undefined {
    if (typeof map !== 'string' || !/^[A-Za-z0-9_-]+$/.test(map)) return 'the wallet map must be base64url';
    let bytes: Uint8Array;
    try {
      bytes = base64.decode(map.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (map.length % 4)) % 4));
    } catch {
      return 'the wallet map is not valid base64url';
    }
    if (bytes.length < 40) return 'the wallet map is too short to be one';
    if (bytes.length > MAX_WALLET_MAP_BYTES) return `the wallet map is larger than ${MAX_WALLET_MAP_BYTES} bytes`;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Hardware authorization after a rotation

  async confirmHardwareAuth(input: { hardwareAuth: { pubkey: string; path: string; tweak?: string }; proof: string }): Promise<HostedResult<{ registration: HostedRegistration; changed: boolean }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'hardware_auth_confirm_refused', refusal: refusal as never });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const reg = w.registration;
      const bad = (detail: string) => refuse({ reason: 'invalid_registration', detail });
      const key = { pubkey: String(input.hardwareAuth?.pubkey).toLowerCase(), path: String(input.hardwareAuth?.path), tweak: String(input.hardwareAuth?.tweak ?? reg.hardwareAuth?.tweak ?? '') };
      if (reg.hardwareAuth && (reg.hardwareAuth.pubkey !== key.pubkey || !samePath(reg.hardwareAuth.path, key.path)))
        return bad(reg.hardwareAuthConfirmed ? 'the hardware authorization key is already confirmed' : 'not the authorization key the guardian expects for this wallet');
      const why = this.authKeyRefusal(reg.network, reg.accountPubkeys.hardware, key);
      if (why) return bad(why);
      const hwKey = { kind: 'bip137' as const, pubkey: key.pubkey, path: key.path };
      if (typeof input.proof !== 'string' || !this.authorizers.get('bip137')!.verify(pairingMessage(reg.walletId, reg.accountPubkeys.cosigner), input.proof, hwKey))
        return bad('hardware pairing proof does not verify');
      if (reg.hardwareAuthConfirmed) return { ok: true as const, registration: reg, changed: false };
      reg.hardwareAuth = { ...hwKey, tweak: key.tweak };
      reg.hardwareAuthConfirmed = true;
      this.log(draft, now, { type: 'hardware_auth_confirmed', walletId: reg.walletId });
      return { ok: true as const, registration: reg, changed: true };
    });
  }

  // -------------------------------------------------------------------------
  // Phone-only payments

  /** Co-signs a phone-signed payment within the daily limit; every tweak-proven change coin goes into the ledger. */
  async cosign(psbt: Uint8Array): Promise<HostedResult<CosignResult & { ledgered: number }>> {
    const chain = await this.chainTime();
    return this.mutate(async (draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: HostedRefusal, txid?: string) => {
        this.log(draft, now, { type: 'cosign_refused', txid, refusal: refusal as never });
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
      if (ps.state !== 'enabled') return refuse({ reason: 'phone_spending_paused', cause: ps.state === 'retired' ? 'wallet_retired' : 'contested_recovery', recoveryId: ps.recoveryId });
      const time = this.limitTime(draft, now, chain);
      if (!time.ok) return refuse(time.refusal);
      const at = time.at;
      const acct = acctOf(reg.accountPubkeys);
      const checked = analyze(psbt, acct, reg.network);
      if (!checked.ok) {
        const retired = checked.refusal.reason === 'foreign_input' ? this.retiredOwner(draft, psbt) : undefined;
        return refuse(retired ? { reason: 'wallet_retired', walletId: retired } : checked.refusal);
      }
      const { analysis } = checked;
      const txid = analysis.txid;
      for (const inp of analysis.inputs) {
        if (inp.signedBy.length !== 1) return refuse({ reason: 'signature_count', input: inp.index, count: inp.signedBy.length }, txid);
        if (inp.signedBy[0] === 'hardware') return refuse({ reason: 'hardware_signed_outside_recovery', input: inp.index }, txid);
        if (inp.signedBy[0] !== 'app') return refuse({ reason: 'not_signed_by_app', input: inp.index, signedBy: inp.signedBy }, txid);
      }
      // Value leaving the key set, fee included: Σ inputs − Σ tweak-proven change (core's `outflow`).
      const outflow = analysis.outflow;
      const replay = w.spends.some((s) => s.txid === txid);
      const used = windowUsage(w.spends, at);
      const shares = splitOutflow(analysis.inputs, outflow);
      const wouldUse = replay ? used : usageWith(w.spends, shares, at);
      if (!replay && wouldUse > rules.dailyLimitSats) return refuse({ reason: 'over_daily_limit', limit: rules.dailyLimitSats, used, outflow, wouldUse }, txid);
      // The ledger: this PSBT's change replaces the coins it spends. Bounded, so a guest cannot grow the host's disk without end.
      const spent = new Set(analysis.inputs.map((i) => i.outpoint));
      const fresh = selfOutputs(psbt, analysis, acct, now).filter((e) => !w.ledger.some((l) => l.txid === e.txid && l.vout === e.vout));
      const kept = w.ledger.filter((l) => !spent.has(outpointOf(l.txid, l.vout)));
      if (kept.length + fresh.length > this.maxLedger) return refuse({ reason: 'ledger_full', limit: this.maxLedger }, txid);
      if (!this.signer) return refuse({ reason: 'guardian_locked' }, txid);
      const signed = await addCosignerSignatures(psbt, analysis, this.signer);
      if (!replay) w.spends.push({ txid, at, outflow, shares });
      w.ledger = [...kept, ...fresh];
      draft.timeFloor = at;
      this.log(draft, now, { type: 'cosign_signed', txid, outflow, usedAfter: wouldUse, replay });
      if (fresh.length) this.log(draft, now, { type: 'ledger_added', txid, coins: fresh.length });
      return { ok: true as const, psbt: signed, txid, outflow, usedAfter: wouldUse, replay, ledgered: fresh.length };
    });
  }

  private retiredOwner(draft: HostedState, psbt: Uint8Array): string | undefined {
    for (const r of draft.retired) {
      try {
        analyzePsbt(psbt, acctOf(r.registration.accountPubkeys), getNetwork(r.registration.network));
        return r.registration.walletId;
      } catch {
        /* not this one */
      }
    }
    return undefined;
  }

  /** Drops ledger coins a check found spent (the recovery runner, by script on the host's Electrs). */
  async pruneLedger(spent: string[]): Promise<number> {
    const gone = new Set(spent);
    if (!this.state.active?.ledger.some((l) => gone.has(outpointOf(l.txid, l.vout)))) return 0;
    return this.mutate((draft) => {
      const w = draft.active;
      if (!w) return 0;
      const before = w.ledger.length;
      w.ledger = w.ledger.filter((l) => !gone.has(outpointOf(l.txid, l.vout)));
      return before - w.ledger.length;
    });
  }

  // -------------------------------------------------------------------------
  // Rules

  async changeRules(next: Rules, auth: { authenticatedBy: 'app' } | { authenticatedBy: 'hardware'; approval: HardwareApproval }): Promise<HostedResult<{ rules: Rules }>> {
    return this.mutate((draft, now) => {
      const by = auth.authenticatedBy === 'hardware' ? 'hardware' : 'app';
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'rules_change_refused', by, refusal: refusal as never });
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
      const phase1 = this.phase1Rules(rules);
      if (phase1) return refuse({ reason: 'invalid_rules', detail: phase1 });
      let sequence: number | undefined;
      if (auth.authenticatedBy === 'app') {
        const may = phoneMayApply(current, rules);
        if (!may.ok) return refuse({ reason: 'hardware_approval_required', detail: may.detail });
      } else if (auth.authenticatedBy === 'hardware') {
        const active = activeRecovery(draft);
        if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
        const r = this.checkApproval(draft, now, auth.approval, { action: 'policy', rules, contactLockBefore: false });
        if (r) return refuse(r);
        sequence = auth.approval.sequence;
      } else {
        return refuse({ reason: 'not_authorized' });
      }
      w.rules = rules;
      this.log(draft, now, { type: 'rules_changed', by, sequence, from: current, to: rules });
      return { ok: true as const, rules };
    });
  }

  // -------------------------------------------------------------------------
  // Recovery access (a new phone without the old one or its backup)

  /** As the host's, but only the version-2 text (bound to this wallet's key-set id) is accepted for a hosted wallet. */
  async grantRecoveryAccess(req: { phonePubkey: string; guardianPubkey: string; approval: { kind: string; expiresAt: number; signature: string } }): Promise<HostedResult<{ until: number; renewed: boolean }>> {
    const check = (s: HostedState, now: number): HostedRefusal | { walletId: string; phone: string; until: number; sig?: string } => {
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
      let ok = false;
      try {
        ok = authorizer.verify(recoveryAccessMessage({ guardianPubkey: String(req.guardianPubkey).toLowerCase(), phonePubkey: phone, expiresAt, walletId: reg.walletId }), signature, reg.hardwareAuth);
      } catch {
        ok = false;
      }
      if (!ok) return { reason: 'approval_invalid_signature' };
      const sig = proofId(signature);
      return { walletId: reg.walletId, phone, until: expiresAt * 1000, ...(sig ? { sig } : {}) };
    };
    const first = check(this.state, this.clock.now());
    if ('reason' in first) return refused(first);
    return this.mutate((draft, now) => {
      const again = check(draft, now);
      if ('reason' in again) return refused(again);
      if (again.walletId !== first.walletId) return refused({ reason: 'not_registered' });
      const w = draft.active!;
      const live = liveGrants(w, now);
      const renewed = live.some((g) => g.pubkey === again.phone);
      w.accessGrants = [...live.filter((g) => g.pubkey !== again.phone), { pubkey: again.phone, until: again.until, grantedAt: now, ...(again.sig ? { sig: again.sig } : {}) }].slice(-MAX_ACCESS_GRANTS);
      this.log(draft, now, { type: 'recovery_access_granted', phone: again.phone, until: again.until });
      return { ok: true as const, until: again.until, renewed };
    });
  }

  // -------------------------------------------------------------------------
  // Delay & Notify recovery, by account pubkeys

  /** Checks a sweep against the wallet (inputs), the destination (every output) and the signer rules. */
  private checkSweep(
    psbt: Uint8Array,
    reg: HostedRegistration,
    dest: { app: string; hardware: string; cosigner: string },
  ): { ok: true; analysis: PsbtAnalysis; surviving: SurvivingRole; targetOut: bigint } | { ok: false; refusal: HostedRefusal } {
    const checked = analyze(psbt, acctOf(reg.accountPubkeys), reg.network, acctOf(dest));
    if (!checked.ok) return checked;
    const { analysis } = checked;
    const roles = new Set<Role>();
    for (const inp of analysis.inputs) {
      if (inp.signedBy.length !== 1) return { ok: false, refusal: { reason: 'recovery_signers', detail: `input ${inp.index} has ${inp.signedBy.length} signatures, expected 1` } };
      roles.add(inp.signedBy[0]);
    }
    if (roles.size !== 1) return { ok: false, refusal: { reason: 'recovery_signers', detail: 'inputs are signed by different keys' } };
    const surviving = [...roles][0];
    if (surviving === 'cosigner') return { ok: false, refusal: { reason: 'recovery_signers', detail: 'the sweep must be signed by the phone or the hardware wallet' } };
    const stray = analysis.outputs.find((o) => !o.isSelf);
    if (stray) return { ok: false, refusal: { reason: 'sweep_not_to_destination', output: stray.index } };
    return { ok: true, analysis, surviving, targetOut: analysis.selfOut };
  }

  /** `abandon`: ledger coins of the active wallet, none of them spent by the sweep. Returns their total. */
  private abandonCheck(w: HostedWallet, analysis: PsbtAnalysis, abandon: string[]): { ok: true; sats: bigint; list: string[] } | { ok: false; refusal: HostedRefusal } {
    const list = [...new Set(abandon.map((a) => String(a).toLowerCase()))];
    const ledger = new Map(w.ledger.map((l) => [outpointOf(l.txid, l.vout), l]));
    const spent = new Set(analysis.inputs.map((i) => i.outpoint));
    let sats = 0n;
    for (const o of list) {
      const l = ledger.get(o);
      if (!l) return { ok: false, refusal: { reason: 'invalid_abandon', detail: `${o} is not a coin this guardian co-signed` } };
      if (spent.has(o)) return { ok: false, refusal: { reason: 'invalid_abandon', detail: `${o} is both swept and abandoned` } };
      sats += l.valueSats;
    }
    return { ok: true, sats, list };
  }

  async startRecovery(req: {
    psbt: Uint8Array;
    destinationKeys: { app: string; hardware: string; cosigner: string };
    destinationMap: string;
    abandon?: string[];
    initiator?: string;
  }): Promise<HostedResult<{ recovery: HostedRecoveryView }>> {
    const chain = await this.chainTime();
    return this.mutate((draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'recovery_start_refused', refusal: refusal as never });
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
      const dest = { app: String(req.destinationKeys?.app).toLowerCase(), hardware: String(req.destinationKeys?.hardware).toLowerCase(), cosigner: String(req.destinationKeys?.cosigner).toLowerCase() };
      if (!ROLES.every((r) => isPubkey(dest[r]))) return refuse({ reason: 'invalid_destination', detail: 'the destination keys must be compressed pubkeys' });
      if (new Set(ROLES.map((r) => dest[r])).size !== 3) return refuse({ reason: 'invalid_destination', detail: 'the destination must have three distinct keys' });
      const destKs = keySetKey(dest);
      if (destKs === keySetKey(reg.accountPubkeys)) return refuse({ reason: 'invalid_destination', detail: 'destination is the current wallet' });
      if (draft.retired.some((r) => keySetKey(r.registration.accountPubkeys) === destKs)) return refuse({ reason: 'invalid_destination', detail: 'destination is a wallet this guardian retired' });
      const mapBad = this.mapRefusal(req.destinationMap);
      if (mapBad) return refuse({ reason: 'invalid_destination', detail: mapBad });
      const swept = this.checkSweep(req.psbt, reg, dest);
      if (!swept.ok) {
        const retired = swept.refusal.reason === 'foreign_input' ? this.retiredOwner(draft, req.psbt) : undefined;
        return refuse(retired ? { reason: 'wallet_retired', walletId: retired } : swept.refusal);
      }
      const { analysis, surviving, targetOut } = swept;
      const lost: SurvivingRole = surviving === 'app' ? 'hardware' : 'app';
      if (dest[surviving] !== reg.accountPubkeys[surviving]) return refuse({ reason: 'destination_drops_surviving_key', survivingRole: surviving });
      if (ROLES.some((r) => dest[r] === reg.accountPubkeys[lost])) return refuse({ reason: 'destination_keeps_lost_key', lostRole: lost });
      if (analysis.fee > rules.sweepFeeCapSats) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: analysis.fee, cap: rules.sweepFeeCapSats });
      const ab = this.abandonCheck(w, analysis, req.abandon ?? []);
      if (!ab.ok) return refuse(ab.refusal);
      if (!chain) return refuse({ reason: 'chain_unavailable', detail: 'the guardian cannot read the chain tip to anchor the recovery delay' });
      const destWalletId = keySetId(acctOf(dest));
      // Write-once: a map already kept for this wallet id is never replaced (a thief with the phone knows its key too).
      const existing = draft.maps[destWalletId];
      if (existing !== undefined && existing !== req.destinationMap) return refuse({ reason: 'invalid_destination', detail: 'the guardian already keeps another wallet map for this destination' });
      if (existing === undefined && Object.keys(draft.maps).length >= MAX_WALLET_MAPS) {
        // Only the active wallet's map is kept besides: maps of earlier (cancelled) destinations make room.
        for (const id of Object.keys(draft.maps)) if (id !== reg.walletId) delete draft.maps[id];
      }
      draft.maps[destWalletId] = req.destinationMap;
      const anchoredAt = Math.max(now, chain.medianTimePastMs);
      const initiator = typeof req.initiator === 'string' && isNostrPubkey(req.initiator.toLowerCase()) ? req.initiator.toLowerCase() : undefined;
      const rec: HostedRecoveryRecord = {
        id: `${this.slotId}g${draft.recoveries.length + 1}-${analysis.txid.slice(0, 12)}`,
        walletId: reg.walletId,
        status: 'pending',
        survivingRole: surviving,
        ...(initiator ? { initiator } : {}),
        sweepPsbt: base64.encode(req.psbt),
        sweepTxid: analysis.txid,
        destinationKeys: dest,
        destinationWalletId: destWalletId,
        abandon: ab.list,
        abandonSats: ab.sats,
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
        destinationWalletId: destWalletId,
      });
      return { ok: true as const, recovery: viewOf(rec, now) };
    });
  }

  async updateRecovery(req: { recoveryId: string; psbt: Uint8Array; abandon?: string[] }): Promise<HostedResult<{ recovery: HostedRecoveryView; addedInputs: number }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'recovery_update_refused', refusal: refusal as never });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const rec = activeRecovery(draft);
      if (!rec || rec.id !== req.recoveryId) return refuse({ reason: 'no_recovery' });
      const swept = this.checkSweep(req.psbt, w.registration, rec.destinationKeys);
      if (!swept.ok) return refuse(swept.refusal);
      if (swept.surviving !== rec.survivingRole) return refuse({ reason: 'recovery_signers', detail: `every input must be signed by the surviving key (${rec.survivingRole}) alone` });
      const before = analyze(base64.decode(rec.sweepPsbt), acctOf(w.registration.accountPubkeys), w.registration.network, acctOf(rec.destinationKeys));
      if (!before.ok) return refuse(before.refusal);
      const spent = new Set(swept.analysis.inputs.map((i) => i.outpoint));
      const missing = before.analysis.inputs.find((i) => !spent.has(i.outpoint));
      if (missing) return refuse({ reason: 'invalid_recovery_update', detail: `the new sweep must still spend ${missing.outpoint}` });
      const cap = rec.feeCapSats < w.rules.sweepFeeCapSats ? rec.feeCapSats : w.rules.sweepFeeCapSats;
      if (swept.analysis.fee > cap) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: swept.analysis.fee, cap });
      const ab = this.abandonCheck(w, swept.analysis, req.abandon ?? rec.abandon.filter((o) => !spent.has(o)));
      if (!ab.ok) return refuse(ab.refusal);
      const addedInputs = spent.size - before.analysis.inputs.length;
      rec.sweepPsbt = base64.encode(req.psbt);
      rec.sweepTxid = swept.analysis.txid;
      rec.amountSats = swept.targetOut;
      rec.feeSats = swept.analysis.fee;
      rec.abandon = ab.list;
      rec.abandonSats = ab.sats;
      this.log(draft, now, { type: 'recovery_updated', recoveryId: rec.id, sweepTxid: rec.sweepTxid, amountSats: rec.amountSats, feeSats: rec.feeSats, addedInputs });
      return { ok: true as const, recovery: viewOf(rec, now), addedInputs };
    });
  }

  async cancelRecovery(actor: CancelActor): Promise<HostedResult<{ recovery: HostedRecoveryView; contested: boolean }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'recovery_cancel_refused', refusal: refusal as never });
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
      const contested = !((by.kind === 'app' && rec.survivingRole === 'app') || (by.kind === 'hardware' && rec.survivingRole === 'hardware'));
      rec.status = 'cancelled';
      rec.cancelledAt = now;
      rec.cancelledBy = by;
      if (contested) w.phoneSpending = { state: 'paused_contested', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_cancelled', recoveryId: rec.id, by, contested });
      return { ok: true as const, recovery: viewOf(rec, now), contested };
    });
  }

  /**
   * After the delay (three clocks), co-signs the stored sweep. The runner checked first, with the host's Electrs, that
   * every input is still unspent and every unspent ledger coin is swept or abandoned.
   */
  async completeRecovery(): Promise<HostedResult<{ psbt: Uint8Array; txHex: string; txid: string; recovery: HostedRecoveryView }>> {
    const chain = await this.chainTime();
    return this.mutate(async (draft, now) => {
      this.noteChain(draft, now, chain);
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'recovery_complete_refused', refusal: refusal as never });
        return refused(refusal);
      };
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const { registration: reg, rules } = w;
      const rec = activeRecovery(draft);
      if (!rec) return refuse({ reason: 'no_recovery' });
      if (now < rec.readyAt) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt });
      if (!chain) return refuse({ reason: 'chain_unavailable', detail: 'the guardian cannot read the chain tip to check the recovery delay' });
      if (chain.medianTimePastMs < rec.readyAt) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt, waitingFor: 'chain_time', chainTime: chain.medianTimePastMs });
      const heightNeeded = rec.startHeight + rec.delayDays * this.blocksPerDay(reg.network);
      if (chain.height < heightNeeded) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt, waitingFor: 'blocks', height: chain.height, heightNeeded });
      const psbt = base64.decode(rec.sweepPsbt);
      const swept = this.checkSweep(psbt, reg, rec.destinationKeys);
      if (!swept.ok) return refuse(swept.refusal);
      if (swept.surviving !== rec.survivingRole) return refuse({ reason: 'recovery_signers', detail: 'stored sweep is not signed by the surviving key alone' });
      const cap = rec.feeCapSats < rules.sweepFeeCapSats ? rec.feeCapSats : rules.sweepFeeCapSats;
      if (swept.analysis.fee > cap) return refuse({ reason: 'sweep_fee_exceeds_cap', fee: swept.analysis.fee, cap });
      if (!this.signer) return refuse({ reason: 'guardian_locked' });
      const signed = await addCosignerSignatures(psbt, swept.analysis, this.signer);
      const { txHex, txid } = finalizePsbt(signed);
      rec.status = 'completed';
      rec.completedAt = now;
      w.phoneSpending = { state: 'retired', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_completed', recoveryId: rec.id, txid });
      return { ok: true as const, psbt: signed, txHex, txid, recovery: viewOf(rec, now) };
    });
  }

  /**
   * Rotation once the sweep was accepted by a node: the swept wallet retires; the destination is adopted when it keeps
   * this slot's key 3. The hardware authorization key carries over when the hardware wallet survived; otherwise the new
   * phone confirms it with `hardware.confirm` (pubkey, path and tweak). The ledger starts with the sweep's outputs and
   * the destination's map becomes the wallet's.
   */
  async rotateAfterSweep(recoveryId: string): Promise<HostedResult<{ retiredWalletId: string; adopted?: HostedRegistration; detail?: string; revokedGrants: number; previousPhone: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const old = w.registration;
      const rec = draft.recoveries.find((r) => r.id === recoveryId);
      if (!rec || rec.status !== 'completed') return refused({ reason: 'no_recovery' });
      if (rec.walletId !== old.walletId) return refused({ reason: 'not_adoptable', detail: 'the recovery is not of the active wallet' });
      if (rec.rotatedAt !== undefined) return refused({ reason: 'not_adoptable', detail: 'already rotated' });
      const dest = rec.destinationKeys;
      const phone = rec.initiator ?? (rec.survivingRole === 'app' ? old.appNostrPubkey : undefined);
      let next: HostedRegistration | undefined;
      let detail: string | undefined;
      let ledger: LedgerEntry[] = [];
      if (dest.cosigner !== old.accountPubkeys.cosigner) detail = 'the new wallet uses another guardian key';
      else if (!phone) detail = 'the phone that started the recovery is not known';
      else {
        const hardwareAuth = rec.survivingRole === 'hardware' && old.hardwareAuth ? { ...old.hardwareAuth } : undefined;
        next = {
          mode: 'delegated',
          walletId: rec.destinationWalletId,
          network: old.network,
          accountPubkeys: { ...dest },
          ...(hardwareAuth ? { hardwareAuth } : {}),
          hardwareAuthConfirmed: false,
          appNostrPubkey: phone,
          walletLabel: old.walletLabel,
          registeredAt: now,
          origin: { kind: 'recovery', recoveryId: rec.id, fromWalletId: old.walletId },
        };
        const psbt = base64.decode(rec.sweepPsbt);
        const checked = analyze(psbt, acctOf(old.accountPubkeys), old.network, acctOf(dest));
        if (checked.ok) ledger = selfOutputs(psbt, checked.analysis, acctOf(dest), now);
      }
      const destMap = draft.maps[rec.destinationWalletId];
      for (const other of draft.recoveries) {
        if (other.walletId !== old.walletId || other.id === rec.id || (other.status !== 'pending' && other.status !== 'ready')) continue;
        other.status = 'cancelled';
        other.cancelledAt = now;
        other.cancelledBy = { kind: 'superseded', recoveryId: rec.id };
        this.log(draft, now, { type: 'recovery_cancelled', recoveryId: other.id, by: other.cancelledBy, contested: false });
      }
      const revokedGrants = this.retireActive(draft, now, { reason: 'recovered', recoveryId: rec.id, ...(next ? { successorWalletId: next.walletId } : {}) });
      if (next) {
        draft.active = { registration: next, rules: w.rules, spends: [], phoneSpending: { state: 'enabled' }, accessGrants: [], ledger };
        if (destMap) draft.maps = { [next.walletId]: destMap };
      }
      rec.rotatedAt = now;
      this.log(draft, now, {
        type: 'wallet_rotated',
        recoveryId: rec.id,
        fromWalletId: old.walletId,
        ...(next ? { toWalletId: next.walletId, phone: next.appNostrPubkey } : {}),
        ...(detail ? { detail } : {}),
        revokedGrants,
      });
      return { ok: true as const, retiredWalletId: old.walletId, ...(next ? { adopted: next } : {}), ...(detail ? { detail } : {}), revokedGrants, previousPhone: old.appNostrPubkey };
    });
  }

  async retireWallet(approval: HardwareApproval): Promise<HostedResult<{ walletId: string; retiredAt: number }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'wallet_retire_refused', refusal: refusal as never });
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

  async resumePhoneSpending(approval: HardwareApproval): Promise<HostedResult<{}>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: HostedRefusal) => {
        this.log(draft, now, { type: 'phone_spending_resume_refused', refusal: refusal as never });
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

  // -------------------------------------------------------------------------
  // Stopping hosting (docs/design/family-hosting.md, "Removing a guest")

  /** The host stopped hosting: a durable `hosting_ending` notice to the guest's phone and contacts. */
  async noteHostingEnding(endsAt: number): Promise<HostedResult<{}>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) return refused({ reason: 'not_registered' });
      const phone = w.registration.appNostrPubkey;
      this.addNotice(draft, now, {
        id: `ending-${draft.nextActivityId}`,
        kind: 'hosting_ending',
        walletId: w.registration.walletId,
        at: now,
        endsAt,
        recipients: [phone, ...w.rules.alertContacts.filter((c) => c !== phone)],
        sent: [],
      });
      this.log(draft, now, { type: 'hosting_ending', endsAt });
      return { ok: true as const };
    });
  }

  /** Hosting ended: the active wallet retires (`hosting_ended`). Refused while its recovery runs. */
  async endHosting(): Promise<HostedResult<{ walletId?: string; phone?: string }>> {
    return this.mutate((draft, now) => {
      const w = draft.active;
      if (!w) {
        this.log(draft, now, { type: 'hosting_ended' });
        return { ok: true as const };
      }
      const running = activeRecovery(draft);
      if (running) return refused({ reason: 'recovery_in_progress', recoveryId: running.id });
      const walletId = w.registration.walletId;
      const phone = w.registration.appNostrPubkey;
      this.retireActive(draft, now, { reason: 'hosting_ended' });
      this.log(draft, now, { type: 'hosting_ended', walletId });
      return { ok: true as const, walletId, phone };
    });
  }

  async markAlertSent(alertId: string, recipients: string[]): Promise<HostedResult<{}>> {
    return this.mutate((draft, now) => {
      const rec = draft.recoveries.find((r) => isKnownAlertId(r as never, alertId));
      if (!rec) return refused({ reason: 'unknown_alert', alertId });
      const sent = new Set(rec.alertsSent[alertId] ?? []);
      const added = recipients.map((r) => r.toLowerCase()).filter((r) => rec.recipients.includes(r) && !sent.has(r));
      for (const r of added) sent.add(r);
      rec.alertsSent[alertId] = [...sent];
      if (added.length) this.log(draft, now, { type: 'alert_sent', alertId, recipients: added });
      return { ok: true as const };
    });
  }

  async markNoticeSent(noticeId: string, recipients: string[]): Promise<HostedResult<{}>> {
    return this.mutate((draft) => {
      const n = draft.notices.find((x) => x.id === noticeId);
      if (!n) return refused({ reason: 'unknown_alert', alertId: noticeId });
      const added = [...new Set(recipients.map((r) => r.toLowerCase()))].filter((r) => n.recipients.includes(r) && !n.sent.includes(r));
      n.sent.push(...added);
      return { ok: true as const };
    });
  }

  async tick(): Promise<void> {
    await this.mutex.run(async () => {
      const draft = clone(this.state);
      if (!this.refresh(draft, this.clock.now())) return;
      await this.store.save(draft);
      this.state = draft;
    });
  }
}
