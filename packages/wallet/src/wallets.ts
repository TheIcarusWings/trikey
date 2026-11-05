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
import { type Policy } from '@trikey/protocol';
import { WalletError } from './errors.js';
import type { HardwareKind } from './platform.js';
import { TrikeyWallet, type WalletDeps } from './wallet.js';

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

  /** Every wallet's alerts about the others go to them, not to it (`TrikeyWallet.siblings`). */
  private link(): void {
    const ids = () => this.list.map((w) => w.state.wallet?.walletId).filter((x): x is string => !!x);
    for (const w of this.list) w.siblings = () => ids().filter((id) => id !== w.state.wallet?.walletId);
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

  byWalletId(walletId: string): TrikeyWallet | undefined {
    return this.list.find((w) => w.state.wallet?.walletId === walletId);
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
    const out = new Set<string>();
    for (const w of this.list) {
      const s = w.state;
      if (s.hardware) out.add(s.hardware.fingerprint);
      if (s.savings) {
        out.add(s.savings.hardware.fingerprint);
        out.add(s.savings.recoveryKey.fingerprint);
      }
    }
    return [...out];
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
   * Removes an added wallet from this phone. Only when it is empty; the app first releases it on the guardian
   * (`retireWallet`, its hardware approval). Its account stays taken. The first wallet goes last, with
   * `TrikeyWallet.forget` (today's "Remove this wallet"), once it is the only one.
   */
  async removeWallet(w: TrikeyWallet): Promise<void> {
    if (w === this.first) throw new WalletError('wrong_state', 'Remove your other wallets first: the first wallet goes last.');
    if (!this.others.includes(w)) throw new WalletError('wrong_state', 'Not a wallet of this phone.');
    const snap = w.snapshot();
    if (snap && snap.balance.totalSats > 0) throw new WalletError('wrong_state', 'Move the money out of this wallet before you remove it.');
    await w.forget();
    this.others.splice(this.others.indexOf(w), 1);
    if (this.index.shown === w.account) this.index = { ...this.index, shown: 0 };
    await this.saveIndex();
    this.link();
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
