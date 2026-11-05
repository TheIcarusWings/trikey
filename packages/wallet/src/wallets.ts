/**
 * Several wallets in one app (docs/design/multi-wallet.md): the phone's wallets on one guardian, sharing one seed (key 2),
 * one nostr identity and one backup; only the hardware wallet differs. Each wallet sits at its own hardened BIP 48 account
 * of the phone seed (the first at 0', the n-th added at 2n') and of the guardian's key 3 seed, so nothing on chain links
 * two of them.
 *
 * - The first wallet is the `TrikeyWallet` at the app's storage key, untouched: an install with one wallet has nothing
 *   else, and every code path runs as before.
 * - Each wallet added is a `TrikeyWallet` of its own at `<storageKey>.a<account>`, marked `own` with its account and name;
 *   it shares the first wallet's secrets and talks to the guardian with its `walletId`.
 * - The index (`<storageKey>.wallets`, a separate key so an older app saving the first wallet cannot strip it) keeps the
 *   order, the names, every account ever used (an account is never used twice) and the wallet shown last.
 */
import { z } from 'zod';
import { GUARDIAN_FEATURES, type Policy } from '@trikey/protocol';
import { WalletError } from './errors.js';
import type { HardwareKind } from './platform.js';
import { TrikeyWallet, type ReplaceOutcome, type ReplacePlan, type WalletDeps, type WalletEvent } from './wallet.js';

/** "Replace guardian" with several wallets: what moves, wallet by wallet (`WalletSet.previewReplaceGuardian`). */
export interface MoveAllPlan {
  /** The first wallet's plan: it pairs with the new guardian's code. */
  first: ReplacePlan;
  /** Every wallet of the phone, the first included, in the order they move. */
  wallets: { account: number; name: string; hardwareKind: HardwareKind; balanceSats: number; coins: number; moved: boolean }[];
}

/** One wallet's part of the move (`WalletSet.replaceGuardian`). */
export interface WalletMove {
  account: number;
  name: string;
  /** `done`: on the new guardian, its coins moved; `awaiting_broadcast`: signed, no node took the sweep yet; `failed`: see `error`, nothing of it moved or it stopped half way (call again: every step is kept). */
  status: 'done' | 'awaiting_broadcast' | 'failed';
  outcome?: ReplaceOutcome;
  error?: WalletError;
}

export interface MoveAllOutcome {
  /** `done`: every wallet is on the new guardian with its money; `partial`: some still wait (`wallets`), call again. */
  status: 'done' | 'partial';
  /** "2 of 3 moved". */
  moved: number;
  total: number;
  wallets: WalletMove[];
  /** The old guardian retired the first wallet's old wallet (it goes last there, after every other wallet). */
  firstRetiredOnOldGuardian: boolean;
}

/** Most wallets on one phone (and one guardian), the first included. */
export const MAX_WALLETS = 8;
/** What the first wallet is called until the person names it. */
export const DEFAULT_FIRST_NAME = 'Main';

export const WalletIndex = z.object({
  version: z.literal(1),
  /** The first wallet's name. */
  firstName: z.string().min(1).max(16).optional(),
  /** The wallets added after the first, in the order shown. */
  wallets: z.array(z.object({ account: z.int().min(2).max(14), storageKey: z.string().min(1) })),
  /** Every account a wallet ever took (removed ones included). */
  accounts: z.array(z.int().min(2).max(14)),
  /** The account of the wallet shown last (0: the first). */
  shown: z.int().min(0).max(14).optional(),
});
export type WalletIndex = z.infer<typeof WalletIndex>;

const emptyIndex = (): WalletIndex => ({ version: 1, wallets: [], accounts: [] });

/** Where the index and each added wallet are kept, from the first wallet's storage key. */
export function walletKeys(storageKey = 'trikey.wallet.v1', indexKey?: string): { index: string; ownWallet: (account: number) => string } {
  return { index: indexKey ?? `${storageKey}.wallets`, ownWallet: (account) => `${storageKey}.a${account}` };
}

/** The master fingerprints of a wallet's devices: its hardware wallet, and its Savings' (the same one, and the Recovery Key). */
function devicesOf(w: TrikeyWallet): string[] {
  const s = w.state;
  return [s.hardware?.fingerprint, s.savings?.hardware.fingerprint, s.savings?.recoveryKey.fingerprint].filter((x): x is string => !!x);
}

export class WalletSet {
  private constructor(
    private readonly deps: WalletDeps,
    private readonly indexKey: string,
    private index: WalletIndex,
    readonly first: TrikeyWallet,
    private readonly others: TrikeyWallet[],
  ) {
    this.link();
  }

  /** The phone's wallets, or undefined while it has none. */
  static async open(deps: WalletDeps, opts: { indexKey?: string } = {}): Promise<WalletSet | undefined> {
    const first = await TrikeyWallet.open(deps);
    if (!first) return undefined;
    const keys = walletKeys(deps.storageKey, opts.indexKey);
    const index = await WalletSet.readIndex(deps, keys.index);
    const others: TrikeyWallet[] = [];
    for (const e of index.wallets) {
      const w = await TrikeyWallet.open({ ...deps, storageKey: e.storageKey });
      if (w) others.push(w);
    }
    return new WalletSet(deps, keys.index, index, first, others);
  }

  /** The first wallet (just created, restored or paired) as a set of one, with the index it may need. */
  static async of(deps: WalletDeps, first: TrikeyWallet, opts: { indexKey?: string } = {}): Promise<WalletSet> {
    const keys = walletKeys(deps.storageKey, opts.indexKey);
    const index = await WalletSet.readIndex(deps, keys.index);
    const others: TrikeyWallet[] = [];
    for (const w of first.restoredOwnWallets) others.push(w);
    for (const e of index.wallets) {
      if (others.some((o) => o.account === e.account)) continue;
      const w = await TrikeyWallet.open({ ...deps, storageKey: e.storageKey });
      if (w) others.push(w);
    }
    const set = new WalletSet(deps, keys.index, index, first, others);
    if (first.restoredOwnWallets.length) await set.saveIndex();
    return set;
  }

  /**
   * Restores the phone from its backup: the first wallet and every other wallet (version 4), plus any the guardian lists
   * that the backup is older than. As `TrikeyWallet.restoreFromBackup`.
   */
  static async restoreFromBackup(
    deps: WalletDeps,
    unlock: Parameters<typeof TrikeyWallet.restoreFromBackup>[1],
    opts: Omit<NonNullable<Parameters<typeof TrikeyWallet.restoreFromBackup>[2]>, 'ownWalletKey'> & { indexKey?: string } = {},
  ): Promise<WalletSet> {
    let used = deps;
    const first = await TrikeyWallet.restoreFromBackup(deps, unlock, {
      ...opts,
      ...(opts.switchNetwork ? { switchNetwork: (n) => (used = opts.switchNetwork!(n)) } : {}),
      ownWalletKey: (account) => walletKeys(used.storageKey, opts.indexKey).ownWallet(account),
    });
    return WalletSet.of(used, first, { indexKey: opts.indexKey });
  }

  private static async readIndex(deps: WalletDeps, key: string): Promise<WalletIndex> {
    const raw = await deps.store.get(key);
    if (raw === null) return emptyIndex();
    try {
      return WalletIndex.parse(JSON.parse(raw));
    } catch (e) {
      throw new WalletError('internal', 'The stored list of wallets is invalid.', { cause: e });
    }
  }

  private async saveIndex(): Promise<void> {
    const index: WalletIndex = {
      ...this.index,
      wallets: this.others.map((w) => ({ account: w.account, storageKey: walletKeys(this.deps.storageKey, this.indexKey).ownWallet(w.account) })),
      accounts: [...new Set([...this.index.accounts, ...this.others.map((w) => w.account)])].sort((a, b) => a - b),
    };
    await this.deps.store.set(this.indexKey, JSON.stringify(WalletIndex.parse(index)));
    this.index = index;
  }

  /**
   * Every wallet's alerts about the others go to them, not to it (`TrikeyWallet.siblings`: the others' wallet ids and
   * their Savings' ids, which Savings alerts name), and no wallet takes another's device as a Savings Recovery Key
   * (`TrikeyWallet.otherDevices`).
   */
  private link(): void {
    const idsOf = (w: TrikeyWallet) => [w.state.wallet?.walletId, w.state.savings?.walletId].filter((x): x is string => !!x);
    for (const w of this.list) {
      w.siblings = () => this.list.filter((o) => o !== w).flatMap(idsOf);
      w.otherDevices = () => this.list.filter((o) => o !== w).flatMap((o) => devicesOf(o));
    }
  }

  /** The phone's wallets: the first, then the ones added, in order. */
  get list(): TrikeyWallet[] {
    return [this.first, ...this.others];
  }

  /** More than one wallet: the app shows the switcher, names wallets everywhere and the total of the limits. */
  get several(): boolean {
    return this.others.length > 0;
  }

  byAccount(account: number): TrikeyWallet | undefined {
    return this.list.find((w) => w.account === account);
  }

  /** The wallet whose id is `walletId`, or whose Savings it is (Savings alerts name the Savings wallet). */
  byWalletId(walletId: string): TrikeyWallet | undefined {
    return this.list.find((w) => w.state.wallet?.walletId === walletId) ?? this.list.find((w) => w.state.savings?.walletId === walletId);
  }

  nameOf(w: TrikeyWallet): string {
    return w.ownWallet?.name ?? this.index.firstName ?? DEFAULT_FIRST_NAME;
  }

  /** The wallet shown last (the first by default). */
  get shown(): TrikeyWallet {
    return this.byAccount(this.index.shown ?? 0) ?? this.first;
  }

  async show(w: TrikeyWallet): Promise<void> {
    if (!this.list.includes(w)) throw new WalletError('wrong_state', 'Not a wallet of this phone.');
    if ((this.index.shown ?? 0) === w.account) return;
    this.index = { ...this.index, shown: w.account };
    await this.saveIndex();
  }

  async rename(w: TrikeyWallet, name: string): Promise<void> {
    const n = name.trim();
    if (!n || n.length > 16) throw new WalletError('invalid_rules', 'A wallet name has 1 to 16 characters.');
    if (w === this.first) {
      this.index = { ...this.index, firstName: n };
      await this.saveIndex();
    } else await w.renameOwnWallet(n);
  }

  /** Whether "Add a wallet" can be offered: a guardian with `own_wallets`, and room for one more. */
  get canAdd(): boolean {
    return this.first.ownWalletsSupported && this.list.length < MAX_WALLETS && this.nextAccount() !== undefined;
  }

  /** The next free account: even, above every account this phone or its guardian ever used. */
  nextAccount(): number | undefined {
    const used = [...this.index.accounts, ...this.others.map((w) => w.account), ...(this.first.state.guardianStatus?.wallets ?? []).map((w) => w.account)];
    const next = Math.max(0, ...used) + 2;
    return next <= 2 * (MAX_WALLETS - 1) ? next : undefined;
  }

  /** Master fingerprints of every device already in a wallet of this phone (hardware wallets, Savings' devices). */
  takenFingerprints(): string[] {
    return [...new Set(this.list.flatMap((w) => devicesOf(w)))];
  }

  /**
   * The total of the daily limits: what someone who unlocks this phone can send in a day with the guardian, every wallet
   * together (the app shows it on a shared phone). `off`: one wallet has no daily limit.
   */
  totalDailyLimit(): { sats: number; off: boolean } {
    let sats = 0;
    let off = false;
    for (const w of this.list) {
      const lim = w.state.guardianStatus?.dailyLimit;
      if (lim?.off || w.limitOff) off = true;
      else sats += lim?.limitSats ?? w.state.rules?.policy.dailyLimitSats ?? 0;
    }
    return { sats, off };
  }

  /**
   * "Add a wallet": a name, the new hardware wallet, the rules. The guardian must list `own_wallets` (`guardian_unsupported`
   * otherwise: "Update your guardian to add a wallet"). Returns the new wallet; the app asks for a new backup next.
   */
  async addWallet(opts: { name: string; rules: Policy; hardwareKind?: HardwareKind; verifyAddress?: boolean }): Promise<TrikeyWallet> {
    if (!this.first.ownWalletsSupported) throw new WalletError('guardian_unsupported', 'Update your guardian to add a wallet.');
    if (this.list.length >= MAX_WALLETS) throw new WalletError('wrong_state', `A phone holds at most ${MAX_WALLETS} wallets.`);
    const name = opts.name.trim();
    if (this.list.some((w) => this.nameOf(w).toLowerCase() === name.toLowerCase())) throw new WalletError('invalid_rules', `A wallet is called "${name}" already.`);
    const account = this.nextAccount();
    if (account === undefined) throw new WalletError('wrong_state', `A phone holds at most ${MAX_WALLETS} wallets.`);
    const storageKey = walletKeys(this.deps.storageKey, this.indexKey).ownWallet(account);
    // The account is taken once the guardian took the wallet (it remembers it too, and lists it in `guardian.status`).
    const w = await this.first.addOwnWallet({
      account,
      name,
      rules: opts.rules,
      storageKey,
      ...(opts.hardwareKind ? { hardwareKind: opts.hardwareKind } : {}),
      ...(opts.verifyAddress !== undefined ? { verifyAddress: opts.verifyAddress } : {}),
      takenFingerprints: this.takenFingerprints(),
      firstName: this.nameOf(this.first),
    });
    this.others.push(w);
    await this.saveIndex();
    this.link();
    return w;
  }

  /**
   * Wallets the guardian lists that this phone does not hold (a backup older than the last wallet added): checked against
   * the phone's key at their account (one biometric prompt) and kept. Returns the wallets rebuilt.
   */
  async rebuildFromGuardian(): Promise<TrikeyWallet[]> {
    await this.first.refreshStatus();
    const missing = this.first.listedOwnWallets().filter((spec) => !this.byAccount(spec.account) && !this.byWalletId(spec.walletId));
    const out: TrikeyWallet[] = [];
    for (const spec of missing) {
      const w = await this.first.restoreOwnWallet(spec, walletKeys(this.deps.storageKey, this.indexKey).ownWallet(spec.account));
      if (w) {
        this.others.push(w);
        out.push(w);
      }
    }
    if (out.length) {
      this.others.sort((a, b) => a.account - b.account);
      await this.saveIndex();
      this.link();
    }
    return out;
  }

  /**
   * "Remove" in Settings > Wallets: an added wallet leaves this phone and its guardian. Only when it is empty (on this
   * phone's last sync and on the guardian's view: it refuses with `wallet_not_empty`), so first move its money out
   * (`moveFunds`), and its Savings' too. Released on the guardian first (`wallet.retire`, with its hardware wallet's
   * approval; the guardian announces it), unless the guardian no longer guards it (retired, recovered elsewhere, reset).
   * Its account stays taken. The first wallet goes last, with `TrikeyWallet.forget` (today's "Remove this wallet"),
   * once it is the only one.
   */
  async removeWallet(w: TrikeyWallet, opts: { retire?: boolean } = {}): Promise<void> {
    if (w === this.first) throw new WalletError('wrong_state', 'Remove your other wallets first: the first wallet goes last.');
    if (!this.others.includes(w)) throw new WalletError('wrong_state', 'Not a wallet of this phone.');
    const snap = w.snapshot();
    if (snap && snap.balance.totalSats > 0) throw new WalletError('wrong_state', 'Move the money out of this wallet before you remove it.');
    const sv = w.savingsSnapshot();
    if (sv && sv.balance.totalSats > 0) throw new WalletError('wrong_state', "Move the money out of this wallet's Savings before you remove it.");
    if (w.state.replacing) throw new WalletError('replace_in_progress', 'This wallet is moving to a new guardian: finish that first.');
    if (opts.retire !== false && w.stage === 'paired' && !w.state.retiredByGuardian) await w.retireWallet();
    await w.forget();
    this.others.splice(this.others.indexOf(w), 1);
    if (this.index.shown === w.account) this.index = { ...this.index, shown: 0 };
    await this.saveIndex();
    this.link();
  }

  // ---------------------------------------------------------------------------
  // "Replace guardian": every wallet moves (docs/design/multi-wallet.md, section 6)

  /**
   * Step 1 of "Replace guardian" with several wallets: the first wallet's plan (it pairs with the new guardian's code),
   * and every other wallet with what it holds. A new guardian that cannot hold the phone's other wallets (no
   * `own_wallets_2`) is refused before anything changes: the wallets would be split over two guardians.
   */
  async previewReplaceGuardian(newGuardianUri: string): Promise<MoveAllPlan> {
    const first = await this.first.previewReplaceGuardian(newGuardianUri);
    if (this.several && !first.newGuardian.features?.includes(GUARDIAN_FEATURES.ownWallets2)) {
      await this.first.abandonReplaceGuardian().catch(() => undefined);
      throw new WalletError('guardian_unsupported', "Your new guardian can't take several wallets yet. Update it, then scan its code again.");
    }
    return { first, wallets: this.list.map((w) => this.moveLine(w)) };
  }

  private moveLine(w: TrikeyWallet): MoveAllPlan['wallets'][number] {
    const snap = w.snapshot();
    const utxos = w.state.chain?.utxos ?? [];
    return {
      account: w.account,
      name: this.nameOf(w),
      hardwareKind: w.state.hardware?.kind ?? 'trezor',
      balanceSats: snap?.balance.totalSats ?? utxos.reduce((a, u) => a + u.valueSats, 0),
      coins: utxos.length,
      moved: false,
    };
  }

  /** The new guardian every wallet moves to: where the first wallet is moving, or moved. */
  private moveTarget() {
    return this.first.state.replacing?.guardian ?? this.first.state.guardian;
  }

  /** Wallets after the first still on another guardian than the first (a move under way or not finished). */
  get moveUnfinished(): TrikeyWallet[] {
    const target = this.moveTarget();
    if (!target) return [];
    return this.others.filter((w) => !w.state.retiredByGuardian && (!!w.state.replacing || w.state.guardian?.pubkey !== target.pubkey));
  }

  /**
   * "Replace guardian" with several wallets: one pairing code, every wallet moves, each with its own hardware wallet.
   *
   * 1. The first wallet pairs with the new guardian (the code from `previewReplaceGuardian`, or `newGuardianUri`), sweeps
   *    its coins into its new wallet and switches (`TrikeyWallet.replaceGuardian`). The old guardian does not retire it
   *    yet: there the first wallet goes last.
   * 2. Each other wallet, in order: added on the new guardian at its own account naming the wallet it replaces, its
   *    coins swept with its own device, retired on the old guardian once empty, switched (`TrikeyWallet.moveToGuardian`).
   *    `onWallet` says which one is next ("Connect the Ledger of 'Business'"). One wallet's failure does not stop the
   *    others: it is reported (`failed`, with the error) and kept where it stopped.
   * 3. Once every other wallet left, the old guardian retires the first wallet's old wallet (one more approval on its
   *    device), when it answers.
   *
   * Call again to finish a `partial` move: done wallets are skipped, the others resume where they stopped. Nothing of a
   * wallet moves until the new guardian holds its new wallet, so a wallet that failed before that is still guarded by the
   * old guardian as before.
   */
  async replaceGuardian(
    opts: {
      newGuardianUri?: string;
      oldGuardianReachable?: false;
      onWallet?: (w: TrikeyWallet, index: number, total: number) => void;
      onEvent?: (w: TrikeyWallet, e: WalletEvent) => void;
    } = {},
  ): Promise<MoveAllOutcome> {
    const total = this.list.length;
    const moves: WalletMove[] = [];
    const watch = (w: TrikeyWallet) => (opts.onEvent ? w.on((e) => opts.onEvent!(w, e)) : () => undefined);
    const failure = (w: TrikeyWallet, e: unknown): WalletMove => ({
      account: w.account,
      name: this.nameOf(w),
      status: 'failed',
      error: e instanceof WalletError ? e : new WalletError('internal', (e as Error)?.message ?? String(e), { cause: e }),
    });
    const ofOutcome = (w: TrikeyWallet, outcome: ReplaceOutcome): WalletMove => ({ account: w.account, name: this.nameOf(w), status: outcome.status, outcome });

    // 1. The first wallet.
    const firstStarted = !!this.first.state.replacing || !!opts.newGuardianUri || this.first.replaceSessionOpen;
    // The first wallet's old wallet: the one it is leaving now, or the one its current wallet replaced.
    const firstOldId = firstStarted ? this.first.state.wallet?.walletId : this.first.retiredWallets.find((r) => r.successorWalletId === this.first.state.wallet?.walletId)?.walletId;
    if (firstStarted) {
      opts.onWallet?.(this.first, 0, total);
      const off = watch(this.first);
      try {
        moves.push(ofOutcome(this.first, await this.first.replaceGuardian({ ...(opts.newGuardianUri ? { newGuardianUri: opts.newGuardianUri } : {}), ...(opts.oldGuardianReachable === false ? { oldGuardianReachable: false as const } : {}) })));
      } catch (e) {
        // Not paired with the new guardian: nothing moved, and the other wallets cannot be added there.
        if (!this.first.state.replacing) throw e;
        moves.push(failure(this.first, e));
      } finally {
        off();
      }
    } else moves.push({ account: 0, name: this.nameOf(this.first), status: 'done' });
    const target = this.moveTarget();
    if (!target) throw new WalletError('wrong_state', 'No guardian is paired.');

    // 2. Every other wallet, each with its own device.
    for (const [i, w] of this.others.entries()) {
      if (w.state.retiredByGuardian || (!w.state.replacing && w.state.guardian?.pubkey === target.pubkey)) {
        moves.push({ account: w.account, name: this.nameOf(w), status: 'done' });
        continue;
      }
      opts.onWallet?.(w, i + 1, total);
      const off = watch(w);
      try {
        moves.push(ofOutcome(w, await w.moveToGuardian(target, opts.oldGuardianReachable === false ? { oldGuardianReachable: false } : {})));
      } catch (e) {
        moves.push(failure(w, e));
      } finally {
        off();
      }
    }

    // 3. On the old guardian: any other wallet's old wallet a retire missed (it saw the sweep's coins a moment too early,
    //    or did not answer), then the first wallet's, which goes last there.
    if (opts.oldGuardianReachable !== false)
      for (const w of this.others) {
        const old = w.retiredWallets.find((r) => !r.retiredOnGuardian && r.successorWalletId === w.state.wallet?.walletId);
        if (old && !w.state.replacing && w.state.guardian?.pubkey === target.pubkey) await w.retireOldWallet(old.walletId).catch(() => undefined);
      }
    let firstRetired = !firstOldId || !this.first.retiredWallets.some((r) => !r.retiredOnGuardian && r.walletId === firstOldId);
    if (!firstRetired && moves.every((m) => m.status === 'done') && opts.oldGuardianReachable !== false) {
      try {
        await this.first.retireOldWallet(firstOldId);
        firstRetired = true;
      } catch {
        // Offline, or the person declined: the old wallet is empty; `retireOldWallet()` later.
      }
    }
    const moved = moves.filter((m) => m.status === 'done').length;
    return { status: moved === total ? 'done' : 'partial', moved, total, wallets: moves, firstRetiredOnOldGuardian: firstRetired };
  }

  /**
   * Moves everything `from` holds to `to` (another wallet of this phone): "send max" to `to`'s next address, signed as
   * any payment (within `from`'s daily limit the guardian co-signs, over it `from`'s hardware wallet signs). The explicit
   * move of funds before removing a wallet.
   */
  async moveFunds(from: TrikeyWallet, to: TrikeyWallet, opts: { speed?: 'slow' | 'normal' | 'fast' } = {}): ReturnType<TrikeyWallet['send']> {
    if (from === to || !this.list.includes(from) || !this.list.includes(to)) throw new WalletError('wrong_state', 'Choose another wallet of this phone to move the money to.');
    await from.sync();
    const { address } = await to.receiveAddress();
    const quote = from.quoteSendMax({ address, speed: opts.speed ?? 'normal', label: `Moved to ${this.nameOf(to)}` });
    return from.send(quote, { fallbackToHardware: true });
  }

  /** One backup for every wallet (version 4 once there is more than one), made from the first wallet. */
  createBackup(opts: Omit<NonNullable<Parameters<TrikeyWallet['createBackup']>[0]>, 'ownWallets'> = { passkey: true }): ReturnType<TrikeyWallet['createBackup']> {
    return this.first.createBackup({ ...opts, ownWallets: this.others.map((w) => w.ownWalletSpec()) });
  }

  /** Starts every wallet (one guardian connection each, on the one nostr identity). */
  async start(): Promise<void> {
    for (const w of this.list) await w.start();
  }

  async close(): Promise<void> {
    for (const w of this.list) await w.close();
  }
}
