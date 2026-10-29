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
} from './authorizer.js';
import { Clock, DAY, HOUR, systemClock } from './clock.js';
import { addCosignerSignatures, inspectPsbt } from './inspect.js';
import { pruneSpends, splitOutflow, usageWith, windowUsage } from './limit.js';
import { isNostrPubkey, normalizeRules, phoneMayApply } from './rules.js';
import { CosignerSigner } from './signer.js';
import { StateStore, deserializeState, serializeState } from './storage.js';
import {
  ActivityEntry,
  ActivityEvent,
  CancelActor,
  CancelledBy,
  GuardianState,
  HardwareApproval,
  HardwareAuthKey,
  RecoveryDelayDays,
  RecoveryRecord,
  RecoveryStatus,
  Refusal,
  Registration,
  Result,
  Rules,
  SurvivingRole,
  emptyState,
} from './types.js';

/** A hardware approval may be valid for at most this long from the moment the guardian checks it. */
export const MAX_APPROVAL_TTL_MS = 24 * HOUR;
export const DEFAULT_MAX_ACTIVITY = 5000;
/** Largest allowed jump in hardware sequence numbers (so one approval can't exhaust the space). */
export const MAX_SEQUENCE_STEP = 1000;

export interface PolicyEngineOptions {
  store: StateStore;
  clock?: Clock;
  /** Key 3. Absent while the guardian is locked. */
  signer?: CosignerSigner;
  /** Hardware authorization mechanisms; defaults to BIP137 signmessage. */
  authorizers?: HardwareAuthorizer[];
  /** Activity entries kept (oldest dropped first). */
  maxActivity?: number;
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
  dailyLimit?: { limit: bigint; used: bigint; available: bigint };
}

export interface CosignResult {
  psbt: Uint8Array;
  txid: string;
  outflow: bigint;
  usedAfter: bigint;
  /** True when this exact transaction had already been co-signed (nothing new was counted). */
  replay: boolean;
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
const eqHex = (a: Uint8Array, b: Uint8Array) => hex.encode(a) === hex.encode(b);
const refused = (refusal: Refusal) => ({ ok: false as const, refusal });

function activeRecovery(s: GuardianState): RecoveryRecord | undefined {
  const last = s.recoveries[s.recoveries.length - 1];
  return last && (last.status === 'pending' || last.status === 'ready') ? last : undefined;
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

export class PolicyEngine {
  private readonly mutex = new Mutex();
  private readonly clock: Clock;
  private readonly authorizers: Map<string, HardwareAuthorizer>;
  private readonly maxActivity: number;
  private signer?: CosignerSigner;

  private constructor(
    private readonly store: StateStore,
    private state: GuardianState,
    opts: PolicyEngineOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.authorizers = new Map((opts.authorizers ?? [bip137Authorizer]).map((a) => [a.kind, a]));
    this.maxActivity = opts.maxActivity ?? DEFAULT_MAX_ACTIVITY;
    this.setSigner(opts.signer);
  }

  /** Loads persisted state (or starts empty). */
  static async open(opts: PolicyEngineOptions): Promise<PolicyEngine> {
    const state = (await opts.store.load()) ?? emptyState();
    return new PolicyEngine(opts.store, state, opts);
  }

  // -------------------------------------------------------------------------
  // Lock / unlock

  /** Installs key 3 after unlock, or removes it (`undefined`) to lock. */
  setSigner(signer: CosignerSigner | undefined): void {
    const reg = this.state.registration;
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
    const reg = s.registration;
    const active = activeRecovery(s);
    const last = s.recoveries[s.recoveries.length - 1];
    let phoneSpending: PhoneSpendingStatus;
    if (active) phoneSpending = 'paused_recovery';
    else if (s.phoneSpending.state === 'paused_contested') phoneSpending = 'paused_contested';
    else if (s.phoneSpending.state === 'retired') phoneSpending = 'retired';
    else phoneSpending = 'enabled';
    const used = windowUsage(s.spends, now);
    return {
      registered: !!reg,
      locked: this.locked,
      walletId: reg?.walletId,
      network: reg?.network,
      rules: s.rules,
      phoneSpending,
      recoveryStatus: active ? viewOf(active, now).status : 'none',
      recovery: last ? viewOf(last, now) : undefined,
      nextHardwareSequence: s.hardwareSequence + 1,
      dailyLimit: s.rules
        ? { limit: s.rules.dailyLimitSats, used, available: s.rules.dailyLimitSats > used ? s.rules.dailyLimitSats - used : 0n }
        : undefined,
    };
  }

  /** Newest first. */
  activity(opts: { limit?: number; beforeId?: number } = {}): ActivityEntry[] {
    const all = this.state.activity.filter((e) => opts.beforeId === undefined || e.id < opts.beforeId);
    return all.slice(-(opts.limit ?? 100)).reverse();
  }

  registration(): Registration | undefined {
    return this.state.registration;
  }

  /** Alerts the service should send now (nostr DMs), with the recipients still owed each one. */
  dueAlerts(): DueAlert[] {
    return computeDueAlerts(this.state.recoveries, this.clock.now());
  }

  // -------------------------------------------------------------------------
  // Internals

  private async mutate<T>(fn: (draft: GuardianState, now: number) => Promise<T> | T): Promise<T> {
    return this.mutex.run(async () => {
      const draft = cloneState(this.state);
      const now = this.clock.now();
      this.refresh(draft, now);
      const out = await fn(draft, now);
      draft.spends = pruneSpends(draft.spends, now);
      if (draft.activity.length > this.maxActivity) draft.activity = draft.activity.slice(-this.maxActivity);
      await this.store.save(draft);
      this.state = draft;
      return out;
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

  private log(draft: GuardianState, now: number, event: ActivityEvent): void {
    draft.activity.push({ id: draft.nextActivityId++, at: now, ...event } as ActivityEntry);
  }

  private wallet(reg: Registration): MultisigWallet {
    return MultisigWallet.fromDescriptor(reg.descriptor, getNetwork(reg.network));
  }

  /** Checks a hardware approval for `action` and consumes its sequence number on success. */
  private checkApproval(draft: GuardianState, now: number, approval: HardwareApproval, action: HardwareAction): Refusal | undefined {
    const reg = draft.registration!;
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

  // -------------------------------------------------------------------------
  // Registration

  async register(input: RegisterInput): Promise<Result<{ walletId: string }>> {
    return this.mutate((draft, now) => {
      if (draft.registration) return refused({ reason: 'already_registered' });
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
      if (this.signer && hex.encode(this.signer.accountPubkey) !== cosignerHex) return bad('the unlocked guardian key differs from cosignerAccountPubkey');
      const appNostr = String(input.appNostrPubkey).toLowerCase();
      if (!isNostrPubkey(appNostr)) return bad('appNostrPubkey must be 32-byte hex');
      let rules: Rules;
      try {
        rules = normalizeRules(input.rules);
      } catch (e) {
        return bad(`rules: ${(e as Error).message}`);
      }
      const hwKey: HardwareAuthKey = { ...input.hardwareAuth, pubkey: String(input.hardwareAuth?.pubkey).toLowerCase() };
      const authorizer = this.authorizers.get(hwKey.kind);
      if (!authorizer) return bad(`unsupported hardware authorization kind: ${hwKey.kind}`);
      try {
        authorizer.validateKey(hwKey);
      } catch (e) {
        return bad(`hardwareAuth: ${(e as Error).message}`);
      }
      // If the authorization key sits below the hardware wallet's multisig account by
      // non-hardened steps, the guardian can check it belongs to that device itself.
      const hwOrigin = `m/${wallet.keys.hardware.originPath}`;
      const path = normalizeHdPath(hwKey.path);
      if (path.startsWith(`${hwOrigin}/`)) {
        const rest = path.slice(hwOrigin.length + 1);
        if (/^\d+(\/\d+)*$/.test(rest)) {
          const derived = HDKey.fromExtendedKey(wallet.keys.hardware.xpub, network.bip32).derive(`m/${rest}`).publicKey!;
          if (hex.encode(derived) !== hwKey.pubkey) return bad('authorization key does not derive from the hardware xpub at its path');
        }
      }
      const walletId = wallet.fingerprint();
      if (!authorizer.verify(pairingMessage(walletId, cosignerHex), input.hardwareAuthProof, hwKey))
        return bad('hardware pairing proof does not verify');

      draft.registration = {
        walletId,
        network: network.name,
        descriptor: wallet.descriptor(),
        cosignerAccountPubkey: cosignerHex,
        hardwareAuth: hwKey,
        appNostrPubkey: appNostr,
        registeredAt: now,
      };
      draft.rules = rules;
      this.log(draft, now, { type: 'registered', walletId });
      return { ok: true as const, walletId };
    });
  }

  // -------------------------------------------------------------------------
  // Phone-only spends

  /** Co-signs a phone-signed spend within the daily limit. */
  async cosign(psbt: Uint8Array): Promise<Result<CosignResult>> {
    return this.mutate(async (draft, now) => {
      const refuse = (refusal: Refusal, txid?: string) => {
        this.log(draft, now, { type: 'cosign_refused', txid, refusal });
        return refused(refusal);
      };
      const reg = draft.registration;
      const rules = draft.rules;
      if (!reg || !rules) return refused({ reason: 'not_registered' });
      const active = activeRecovery(draft);
      if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
      const ps = draft.phoneSpending;
      if (ps.state !== 'enabled')
        return refuse({
          reason: 'phone_spending_paused',
          cause: ps.state === 'retired' ? 'wallet_retired' : 'contested_recovery',
          recoveryId: ps.recoveryId,
        });

      const checked = inspectPsbt(psbt, this.wallet(reg));
      if (!checked.ok) return refuse(checked.refusal);
      const { analysis, outflow } = checked.inspection;
      const txid = analysis.txid;
      for (const inp of analysis.inputs) {
        if (inp.signedBy.length !== 1) return refuse({ reason: 'signature_count', input: inp.index, count: inp.signedBy.length }, txid);
        if (inp.signedBy[0] === 'hardware') return refuse({ reason: 'hardware_signed_outside_recovery', input: inp.index }, txid);
        if (inp.signedBy[0] !== 'app') return refuse({ reason: 'not_signed_by_app', input: inp.index, signedBy: inp.signedBy }, txid);
      }

      const replay = draft.spends.some((s) => s.txid === txid);
      const used = windowUsage(draft.spends, now);
      const shares = splitOutflow(analysis.inputs, outflow);
      const wouldUse = replay ? used : usageWith(draft.spends, shares, now);
      if (!replay && wouldUse > rules.dailyLimitSats)
        return refuse({ reason: 'over_daily_limit', limit: rules.dailyLimitSats, used, outflow, wouldUse }, txid);

      if (!this.signer) return refuse({ reason: 'guardian_locked' }, txid);
      const signed = await addCosignerSignatures(psbt, analysis, this.signer);
      if (!replay) draft.spends.push({ txid, at: now, outflow, shares });
      this.log(draft, now, { type: 'cosign_signed', txid, outflow, usedAfter: wouldUse, replay });
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
      const current = draft.rules;
      if (!draft.registration || !current) return refused({ reason: 'not_registered' });
      let rules: Rules;
      try {
        rules = normalizeRules(next);
      } catch (e) {
        return refuse({ reason: 'invalid_rules', detail: (e as Error).message });
      }
      let sequence: number | undefined;
      if (auth.authenticatedBy === 'app') {
        const may = phoneMayApply(current, rules);
        if (!may.ok) return refuse({ reason: 'hardware_approval_required', detail: may.detail });
      } else if (auth.authenticatedBy === 'hardware') {
        // A hardware-held thief must not be able to weaken the rules while its own recovery runs.
        const active = activeRecovery(draft);
        if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
        const r = this.checkApproval(draft, now, auth.approval, { action: 'policy', rules });
        if (r) return refuse(r);
        sequence = auth.approval.sequence;
      } else {
        return refuse({ reason: 'not_authorized' });
      }
      draft.rules = rules;
      this.log(draft, now, { type: 'rules_changed', by, sequence, from: current, to: rules });
      return { ok: true as const, rules };
    });
  }

  // -------------------------------------------------------------------------
  // Delay & Notify recovery

  /**
   * Starts a recovery with a sweep signed (on every input) by the surviving
   * key, paying only to `destinationDescriptor`, which must keep that key and
   * drop the other user key.
   */
  async startRecovery(req: { psbt: Uint8Array; destinationDescriptor: string }): Promise<Result<{ recovery: RecoveryView }>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_start_refused', refusal });
        return refused(refusal);
      };
      const reg = draft.registration;
      const rules = draft.rules;
      if (!reg || !rules) return refused({ reason: 'not_registered' });
      const running = activeRecovery(draft);
      if (running) return refuse({ reason: 'recovery_in_progress', recoveryId: running.id });

      const wallet = this.wallet(reg);
      let dest: MultisigWallet;
      try {
        dest = MultisigWallet.fromDescriptor(req.destinationDescriptor, wallet.network);
      } catch (e) {
        return refuse({ reason: 'invalid_destination', detail: (e as Error).message });
      }
      if (dest.fingerprint() === wallet.fingerprint()) return refuse({ reason: 'invalid_destination', detail: 'destination is the current wallet' });

      const checked = inspectPsbt(req.psbt, wallet, dest);
      if (!checked.ok) return refuse(checked.refusal);
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

      const rec: RecoveryRecord = {
        id: `${draft.recoveries.length + 1}-${analysis.txid.slice(0, 12)}`,
        status: 'pending',
        survivingRole: surviving,
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
        readyAt: now + rules.recoveryDelayDays * DAY,
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
      const reg = draft.registration;
      const rules = draft.rules;
      if (!reg || !rules) return refused({ reason: 'not_registered' });
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
      if (contested) draft.phoneSpending = { state: 'paused_contested', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_cancelled', recoveryId: rec.id, by, contested });
      return { ok: true as const, recovery: viewOf(rec, now), contested };
    });
  }

  /** After the delay, co-signs the sweep and returns it (and the raw tx) for broadcast. */
  async completeRecovery(): Promise<Result<{ psbt: Uint8Array; txHex: string; txid: string; recovery: RecoveryView }>> {
    return this.mutate(async (draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'recovery_complete_refused', refusal });
        return refused(refusal);
      };
      const reg = draft.registration;
      const rules = draft.rules;
      if (!reg || !rules) return refused({ reason: 'not_registered' });
      const rec = activeRecovery(draft);
      if (!rec) return refuse({ reason: 'no_recovery' });
      if (now < rec.readyAt) return refuse({ reason: 'delay_not_elapsed', readyAt: rec.readyAt });

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
      draft.phoneSpending = { state: 'retired', recoveryId: rec.id };
      this.log(draft, now, { type: 'recovery_completed', recoveryId: rec.id, txid });
      return { ok: true as const, psbt: signed, txHex, txid, recovery: viewOf(rec, now) };
    });
  }

  /** Re-enables phone-only payments after a contested recovery. Needs the hardware wallet. */
  async resumePhoneSpending(approval: HardwareApproval): Promise<Result<{}>> {
    return this.mutate((draft, now) => {
      const refuse = (refusal: Refusal) => {
        this.log(draft, now, { type: 'phone_spending_resume_refused', refusal });
        return refused(refusal);
      };
      if (!draft.registration) return refused({ reason: 'not_registered' });
      const active = activeRecovery(draft);
      if (active) return refuse({ reason: 'recovery_in_progress', recoveryId: active.id });
      if (draft.phoneSpending.state !== 'paused_contested') return refuse({ reason: 'nothing_to_resume' });
      const r = this.checkApproval(draft, now, approval, { action: 'resume-phone' });
      if (r) return refuse(r);
      draft.phoneSpending = { state: 'enabled' };
      this.log(draft, now, { type: 'phone_spending_resumed', sequence: approval.sequence });
      return { ok: true as const };
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
