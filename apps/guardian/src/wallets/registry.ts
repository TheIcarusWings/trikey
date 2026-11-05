/**
 * `wallets.json`: the box owner's own wallets after the first (docs/design/multi-wallet.md, section 3, "Storage").
 *
 * Each own wallet has a slot (8 random bytes, hex) with its files under `wallets/<slotId>/`, the BIP 48 account its phone
 * key and key 3 sit at (2, 4, ... 14), and a name. Every account ever used stays in `accounts`, so an address of a removed
 * or retired wallet can never receive into a new one. The first wallet is not in here: it is the `Guardian`'s own, with
 * its files where they always were; `first` only remembers the name the phone gave it.
 *
 * Absent file: no own wallets, which is every guardian before them, and every code path runs as before.
 */
import { hex } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';
import { MAX_OWN_WALLETS } from '@trikey/protocol';
import { readJsonFile, writeFileAtomic } from '../files.js';

/** One own wallet after the first. */
export interface OwnWalletRecord {
  /** 8 random bytes, hex: the directory `wallets/<slotId>/` and the recovery id prefix `<slotId>w`. */
  slotId: string;
  /** Its BIP 48 account on the phone seed and the key 3 seed: 2n for the n-th wallet added. */
  account: number;
  /** The name the phone gave it (1-16 characters). */
  name: string;
  /** ms */
  addedAt: number;
  /** ms, once `wallet.retire` retired it (or a reset forgot it): it co-signs nothing any more; its account stays taken. */
  retiredAt?: number;
  /**
   * The kind of hardware wallet the phone named at `wallet.add` (`own_wallets_2`: "trezor", "ledger", ...), listed in
   * `guardian.status.wallets` so a phone rebuilding the wallet connects the right device. Absent for older entries.
   */
  hardwareKind?: string;
}

export interface WalletsFile {
  version: 1;
  /** The first wallet's name on the phone, once it told the guardian (`wallet.add`'s `firstName`). */
  first?: { name: string };
  wallets: OwnWalletRecord[];
  /** Every account ever given to an own wallet (the first wallet's 0 is never in here). */
  accounts: number[];
}

/** Most own wallets after the first: the box holds `MAX_OWN_WALLETS` in all (accounts 0 to 14). */
export const MAX_ADDED_WALLETS = MAX_OWN_WALLETS - 1;

export const isSlotId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);

/** True for an account an own wallet after the first may take: even, 2 to 14. */
export function isOwnAccount(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 2 && (n as number) <= 2 * MAX_ADDED_WALLETS && (n as number) % 2 === 0;
}

function parse(raw: unknown): WalletsFile {
  const f = raw as Partial<WalletsFile> | undefined;
  if (!f || f.version !== 1 || !Array.isArray(f.wallets) || !Array.isArray(f.accounts)) throw new Error('unsupported wallets.json');
  for (const w of f.wallets) {
    if (!w || !isSlotId(w.slotId) || !isOwnAccount(w.account) || typeof w.name !== 'string' || !w.name || w.name.length > 16 || !Number.isFinite(w.addedAt))
      throw new Error('unsupported wallets.json: bad wallet record');
    // A kind this version cannot read is dropped, not fatal: the phone then asks which device it is.
    if (w.hardwareKind !== undefined && (typeof w.hardwareKind !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(w.hardwareKind))) delete w.hardwareKind;
  }
  if (!f.accounts.every(isOwnAccount)) throw new Error('unsupported wallets.json: bad account');
  return { version: 1, ...(f.first && typeof f.first.name === 'string' ? { first: { name: f.first.name } } : {}), wallets: f.wallets, accounts: f.accounts };
}

export class WalletsRegistry {
  private file: WalletsFile = { version: 1, wallets: [], accounts: [] };
  /** Whether `wallets.json` exists (a guardian that never had an own wallet has none, and writes none). */
  private present = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const raw = await readJsonFile(this.path);
    if (raw === undefined) return;
    this.file = parse(raw);
    this.present = true;
  }

  get exists(): boolean {
    return this.present;
  }

  get wallets(): readonly OwnWalletRecord[] {
    return this.file.wallets;
  }

  /** Own wallets that still co-sign (not retired). */
  active(): OwnWalletRecord[] {
    return this.file.wallets.filter((w) => w.retiredAt === undefined);
  }

  get firstName(): string | undefined {
    return this.file.first?.name;
  }

  /** Accounts ever taken. */
  get accounts(): readonly number[] {
    return this.file.accounts;
  }

  wallet(slotId: string): OwnWalletRecord | undefined {
    return this.file.wallets.find((w) => w.slotId === slotId);
  }

  /** Why `account` cannot take a new wallet now, or undefined when it can. */
  refuseAccount(account: number): string | undefined {
    if (!isOwnAccount(account)) return `Account ${account} is not an own wallet's: use an even account from 2 to ${2 * MAX_ADDED_WALLETS}.`;
    if (this.file.accounts.includes(account)) return `Account ${account} was used by a wallet already: an account is never used twice.`;
    if (this.file.wallets.length >= MAX_ADDED_WALLETS) return `This guardian keeps at most ${MAX_OWN_WALLETS} wallets of yours.`;
    return undefined;
  }

  /** The next account a wallet may take: the lowest even account above every one used. */
  nextAccount(): number | undefined {
    for (let a = 2; a <= 2 * MAX_ADDED_WALLETS; a += 2) if (!this.refuseAccount(a) && a > Math.max(0, ...this.file.accounts)) return a;
    return undefined;
  }

  /** A fresh slot id no wallet uses. */
  newSlotId(): string {
    for (;;) {
      const id = hex.encode(secureRandomBytes(8));
      if (!this.wallet(id)) return id;
    }
  }

  /** Changes a copy and writes it atomically before it becomes visible. */
  async update<T>(fn: (f: WalletsFile) => T): Promise<T> {
    const next = structuredClone(this.file);
    const out = fn(next);
    await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.file = next;
    this.present = true;
    return out;
  }
}
