/**
 * Coin labels, frozen coins and payment labels, per wallet (DESIGN.md, "Next: coin control"). Owner's decision 1: they
 * live on the phone and in its backup, with export and import in BIP 329 (`labels-bip329.ts`), and are not sent to the
 * guardian.
 *
 * - **One document per phone**, in the app's `KeyValueStore` at `<storageKey>.labels` (`labelStoreKey`), next to the
 *   wallet state and the wallet index, never inside them: an older app saving the wallet state cannot strip it, and
 *   it holds every wallet of the phone (Spending, Savings, own wallets) keyed by wallet id, so one backup field carries
 *   them all (`exportForBackup` / `importFromBackup`).
 * - **Per wallet:** `coins`, keyed by outpoint (`txid:vout`), each a label and/or `frozen`; `txs`, labels of payments
 *   keyed by txid (received payments, and labels imported for this phone's own payments, which win over the send log's,
 *   `paymentLabel`); `kept`, the BIP 329 records Trikey does not use (addresses, inputs, xpubs, other wallets' types),
 *   kept so an export gives them back.
 * - **Versioned** (`version: 1`) and validated on load: a document from a newer app is refused (`labels_invalid`)
 *   rather than overwritten.
 * - **Bounded** (`MAX_COIN_MARKS`, `MAX_TX_LABELS`, `MAX_KEPT_RECORDS` per wallet, `MAX_LABELED_WALLETS`): a change
 *   that would pass a limit is refused whole (`labels_full`), an import included.
 *
 * Writes are queued, so two changes made at once both land. A failed write leaves the store as it was.
 */
import { z } from 'zod';
import { WalletError } from './errors.js';
import { MAX_LABEL_CHARS, outpointRef, parseBip329, parseOutpoint, sameOrigin, serializeBip329, type Bip329LineError, type Bip329Record } from './labels-bip329.js';
import type { KeyValueStore } from './platform.js';
import { DEFAULT_STORAGE_KEY } from './state.js';

export const LABELS_VERSION = 1;
/** Coins with a label or a freeze, per wallet. Spent coins keep theirs (the history still shows where a payment came from). */
export const MAX_COIN_MARKS = 10_000;
/** Payment labels per wallet. */
export const MAX_TX_LABELS = 10_000;
/** BIP 329 records kept as read (types Trikey does not use), per wallet. */
export const MAX_KEPT_RECORDS = 5_000;
/** Wallets with labels on one phone: every wallet ever held, retired ones included. */
export const MAX_LABELED_WALLETS = 64;

/** Where the labels of the phone whose first wallet is at `storageKey` are kept. */
export function labelStoreKey(storageKey: string = DEFAULT_STORAGE_KEY): string {
  return `${storageKey}.labels`;
}

const WalletIdKey = z.string().regex(/^[0-9a-f]{16}$/);
const Txid = z.string().regex(/^[0-9a-f]{64}$/);
const Outpoint = z.string().refine((s) => parseOutpoint(s) !== undefined && s === s.toLowerCase(), 'expected txid:vout');
const Label = z.string().min(1).max(MAX_LABEL_CHARS * 2);

const CoinMark = z
  .strictObject({ label: Label.optional(), frozen: z.literal(true).optional() })
  .refine((m) => m.label !== undefined || m.frozen, 'a coin mark needs a label or a freeze');
export type CoinMark = z.infer<typeof CoinMark>;

const KeptRecord = z.strictObject({
  type: z.string().min(1).max(32),
  ref: z.string().min(1).max(1024),
  label: z.string().max(MAX_LABEL_CHARS * 2).optional(),
  origin: z.string().max(1024).optional(),
  spendable: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const WalletLabels = z.strictObject({
  coins: z.record(Outpoint, CoinMark).default({}),
  txs: z.record(Txid, Label).default({}),
  kept: z.array(KeptRecord).max(MAX_KEPT_RECORDS).default([]),
});
type WalletLabels = z.infer<typeof WalletLabels>;

/** What `<storageKey>.labels` holds, and what the backup will carry (`exportForBackup`). */
export const LabelsDocument = z
  .strictObject({
    version: z.literal(LABELS_VERSION),
    wallets: z.record(WalletIdKey, WalletLabels),
    /** ms, the phone's clock: the last change made on this phone (not a restore), so the app can tell the backup is older. */
    changedAt: z.number().int().min(0).optional(),
  })
  .refine((d) => Object.keys(d.wallets).length <= MAX_LABELED_WALLETS, `at most ${MAX_LABELED_WALLETS} wallets`)
  .refine(
    (d) => Object.values(d.wallets).every((w) => Object.keys(w.coins).length <= MAX_COIN_MARKS && Object.keys(w.txs).length <= MAX_TX_LABELS),
    'too many labels for one wallet',
  );
export type LabelsDocument = z.infer<typeof LabelsDocument>;

/** One wallet's labels as the coin list reads them (`coins.ts`): a snapshot, unaffected by later changes. */
export interface WalletLabelsView {
  /** The coin's label and freeze (`frozen: false` when it has neither). */
  coin(outpoint: string): { label?: string; frozen: boolean };
  /** The label set on a payment here (not the send log's: see `paymentLabel`). */
  tx(txid: string): string | undefined;
  /** Every frozen coin's outpoint. */
  readonly frozen: ReadonlySet<string>;
}

/** A payment of the send log (Spending's or Savings'), for its label. */
export interface LabeledPayment {
  txid: string;
  label?: string;
}

/** What `importBip329` did. */
export interface Bip329ImportResult {
  coinLabels: number;
  /** Coins frozen (`spendable: false`) and unfrozen (`spendable: true`). */
  frozen: number;
  unfrozen: number;
  txLabels: number;
  /** Records kept as read, for the next export (addresses, inputs, xpubs, ...). */
  kept: number;
  /** Records of another wallet (their `origin` is not this wallet's): left out. */
  otherWallet: number;
  /** Lines skipped (`errors` lists the first ones). */
  errorCount: number;
  errors: Bip329LineError[];
  /** Labels cut to `MAX_LABEL_CHARS`. */
  truncated: number;
}

/** A label as stored: trimmed, at most `MAX_LABEL_CHARS` characters; empty means none. */
export function cleanLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const text = Array.from(label.trim()).slice(0, MAX_LABEL_CHARS).join('').trim();
  return text || undefined;
}

/** A deep copy (Hermes has no structuredClone; the document is plain JSON). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const emptyDoc = (): LabelsDocument => ({ version: LABELS_VERSION, wallets: {} });
const emptyWallet = (): WalletLabels => ({ coins: {}, txs: {}, kept: [] });
const keptKey = (r: Pick<Bip329Record, 'type' | 'ref' | 'origin'>) => `${r.type}\u0000${r.ref}\u0000${r.origin ?? ''}`;

function checkOutpoint(outpoint: string): string {
  const o = parseOutpoint(outpoint);
  if (!o) throw new WalletError('labels_invalid', `Not a coin: ${outpoint}.`);
  return outpointRef(o.txid, o.vout);
}

function checkTxid(txid: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new WalletError('labels_invalid', `Not a transaction id: ${txid}.`);
  return txid.toLowerCase();
}

function checkWalletId(walletId: string): void {
  if (!WalletIdKey.safeParse(walletId).success) throw new WalletError('labels_invalid', `Not a wallet id: ${walletId}.`);
}

/** Throws `labels_full` when `doc` passes a limit. */
function checkLimits(doc: LabelsDocument): void {
  if (Object.keys(doc.wallets).length > MAX_LABELED_WALLETS) throw new WalletError('labels_full', `Labels are kept for at most ${MAX_LABELED_WALLETS} wallets.`);
  for (const w of Object.values(doc.wallets)) {
    if (Object.keys(w.coins).length > MAX_COIN_MARKS) throw new WalletError('labels_full', `A wallet keeps at most ${MAX_COIN_MARKS} coin labels and freezes.`);
    if (Object.keys(w.txs).length > MAX_TX_LABELS) throw new WalletError('labels_full', `A wallet keeps at most ${MAX_TX_LABELS} payment labels.`);
    if (w.kept.length > MAX_KEPT_RECORDS) throw new WalletError('labels_full', `A wallet keeps at most ${MAX_KEPT_RECORDS} other labels.`);
  }
}

/** Parses a stored or backed-up document; throws `labels_invalid` (a newer version says so). */
function readDocument(json: unknown, where: string): LabelsDocument {
  const v = (json as { version?: unknown } | null)?.version;
  if (typeof v === 'number' && v > LABELS_VERSION) throw new WalletError('labels_invalid', `The ${where} labels were saved by a newer version of Trikey. Update the app.`);
  const parsed = LabelsDocument.safeParse(json);
  if (!parsed.success) throw new WalletError('labels_invalid', `The ${where} labels are invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export class LabelStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly kv: KeyValueStore,
    readonly key: string,
    private doc: LabelsDocument,
    private readonly now: () => number,
  ) {}

  /**
   * Opens the phone's labels (none yet: an empty store, nothing written until a change). Throws `labels_invalid`.
   * `now` (ms) stamps each change (`changedAt`).
   */
  static async open(kv: KeyValueStore, key: string = labelStoreKey(), opts: { now?: () => number } = {}): Promise<LabelStore> {
    const now = opts.now ?? (() => Date.now());
    const raw = await kv.get(key);
    if (raw === null) return new LabelStore(kv, key, emptyDoc(), now);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new WalletError('labels_invalid', 'The stored labels are not valid JSON.', { cause: e });
    }
    return new LabelStore(kv, key, readDocument(json, 'stored'), now);
  }

  /** When a label or freeze was last changed on this phone (ms), or undefined: none since the store began or was restored. */
  get changedAt(): number | undefined {
    return this.doc.changedAt;
  }

  /** Called after every change that landed (labels, freezes, an import, a restore). Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One wallet's labels, as a snapshot for the coin list. */
  view(walletId: string): WalletLabelsView {
    const w = this.doc.wallets[walletId] ?? emptyWallet();
    const coins = new Map(Object.entries(w.coins));
    const txs = new Map(Object.entries(w.txs));
    const frozen = new Set([...coins].filter(([, m]) => m.frozen).map(([op]) => op));
    return {
      coin: (outpoint) => {
        const m = coins.get(outpoint);
        return { ...(m?.label !== undefined ? { label: m.label } : {}), frozen: !!m?.frozen };
      },
      tx: (txid) => txs.get(txid),
      frozen,
    };
  }

  /** The label of a payment: the one set here, else the send log's. */
  paymentLabel(walletId: string, payment: LabeledPayment): string | undefined {
    return this.doc.wallets[walletId]?.txs[payment.txid] ?? cleanLabel(payment.label);
  }

  /** Sets a coin's label; an empty `label` clears it (a frozen coin stays frozen). */
  async setCoinLabel(walletId: string, outpoint: string, label: string): Promise<void> {
    const op = checkOutpoint(outpoint);
    const text = cleanLabel(label);
    await this.change(walletId, (w) => {
      const m: CoinMark = { ...w.coins[op] };
      if (text) m.label = text;
      else delete m.label;
      setMark(w, op, m);
    });
  }

  /** Freezes (true) or unfreezes a coin: a frozen coin is left out of automatic selection and Send max (`coins.ts`). */
  async setFrozen(walletId: string, outpoint: string, frozen: boolean): Promise<void> {
    const op = checkOutpoint(outpoint);
    await this.change(walletId, (w) => {
      const m: CoinMark = { ...w.coins[op] };
      if (frozen) m.frozen = true;
      else delete m.frozen;
      setMark(w, op, m);
    });
  }

  /** Sets a payment's label (any payment of the wallet, received ones included); empty clears it. */
  async setTxLabel(walletId: string, txid: string, label: string): Promise<void> {
    const id = checkTxid(txid);
    const text = cleanLabel(label);
    await this.change(walletId, (w) => {
      if (text) w.txs[id] = text;
      else delete w.txs[id];
    });
  }

  /** Drops every label of a wallet (removed from the phone). */
  async forgetWallet(walletId: string): Promise<void> {
    if (!this.doc.wallets[walletId]) return;
    await this.enqueue(async () => {
      const next = copy(this.doc);
      delete next.wallets[walletId];
      next.changedAt = this.now();
      await this.save(next);
    });
  }

  /**
   * The wallet's labels as a BIP 329 file: a `tx` record per labeled payment (this store's, then the send log's
   * `payments`), an `output` record per labeled or frozen coin (`spendable: false` when frozen), then every record kept
   * from an import. `origin` (`bip329Origin` of the wallet's descriptor) goes on every Trikey record.
   */
  exportBip329(walletId: string, opts: { origin?: string; payments?: readonly LabeledPayment[] } = {}): string {
    const w = this.doc.wallets[walletId] ?? emptyWallet();
    const origin = opts.origin ? { origin: opts.origin } : {};
    const records: Bip329Record[] = [];
    const txs = new Map(Object.entries(w.txs));
    for (const p of opts.payments ?? []) {
      const label = cleanLabel(p.label);
      if (label && !txs.has(p.txid)) txs.set(p.txid, label);
    }
    for (const [txid, label] of txs) records.push({ type: 'tx', ref: txid, label, ...origin });
    for (const [op, m] of Object.entries(w.coins)) records.push({ type: 'output', ref: op, ...(m.label ? { label: m.label } : {}), ...origin, ...(m.frozen ? { spendable: false } : {}) });
    records.push(...w.kept);
    return serializeBip329(records);
  }

  /**
   * Reads a BIP 329 file into a wallet's labels. Per the BIP, a record without `label` (or `spendable`) leaves that value
   * as it is; an empty label clears it. `output` records set coin labels and freezes, `tx` records payment labels, and
   * every other record is kept for the next export. A record whose `origin` is not `opts.origin` (another wallet in the
   * same file) is left out; one without `origin` is taken as this wallet's. Lines that break the format are skipped
   * and reported. All or nothing: `labels_full` (a limit) or `labels_invalid` (an unreadable file) change nothing.
   */
  async importBip329(walletId: string, file: string | Uint8Array, opts: { origin?: string } = {}): Promise<Bip329ImportResult> {
    const parsed = parseBip329(file);
    const result: Bip329ImportResult = { coinLabels: 0, frozen: 0, unfrozen: 0, txLabels: 0, kept: 0, otherWallet: 0, errorCount: parsed.errorCount, errors: parsed.errors, truncated: parsed.truncated };
    await this.change(walletId, (w) => {
      const kept = new Map(w.kept.map((r) => [keptKey(r), r]));
      for (const r of parsed.records) {
        if (r.origin && opts.origin && !sameOrigin(r.origin, opts.origin)) {
          result.otherWallet++;
          continue;
        }
        if (r.type === 'output') {
          const m: CoinMark = { ...w.coins[r.ref] };
          if (r.label !== undefined) {
            const text = cleanLabel(r.label);
            if (text) m.label = text;
            else delete m.label;
            result.coinLabels++;
          }
          if (r.spendable === false) {
            m.frozen = true;
            result.frozen++;
          } else if (r.spendable === true) {
            delete m.frozen;
            result.unfrozen++;
          }
          setMark(w, r.ref, m);
        } else if (r.type === 'tx') {
          if (r.label === undefined) continue;
          const text = cleanLabel(r.label);
          if (text) w.txs[r.ref] = text;
          else delete w.txs[r.ref];
          result.txLabels++;
        } else {
          kept.set(keptKey(r), r);
          result.kept++;
        }
      }
      w.kept = [...kept.values()];
    });
    return result;
  }

  /** The whole document for the phone's backup, or undefined when there is nothing to keep (the field is then left out). */
  exportForBackup(): LabelsDocument | undefined {
    const wallets = Object.entries(this.doc.wallets).filter(([, w]) => Object.keys(w.coins).length || Object.keys(w.txs).length || w.kept.length);
    if (!wallets.length) return undefined;
    return copy({ version: LABELS_VERSION, wallets: Object.fromEntries(wallets) });
  }

  /**
   * Puts a backup's labels back (a restore), replacing what the store held. `undefined`: a backup without labels. The
   * restored labels are the backup's, so nothing is newer than it (`changedAt` cleared).
   */
  async importFromBackup(doc: unknown): Promise<void> {
    const next = doc === undefined ? emptyDoc() : readDocument(doc, 'backed-up');
    delete next.changedAt;
    await this.enqueue(() => this.save(next));
  }

  /** Applies `edit` to a copy of one wallet's labels, checks the limits, writes, and only then keeps it. */
  private async change(walletId: string, edit: (w: WalletLabels) => void): Promise<void> {
    checkWalletId(walletId);
    await this.enqueue(async () => {
      const next = copy(this.doc);
      const w = next.wallets[walletId] ?? emptyWallet();
      edit(w);
      if (Object.keys(w.coins).length || Object.keys(w.txs).length || w.kept.length) next.wallets[walletId] = w;
      else delete next.wallets[walletId];
      checkLimits(next);
      next.changedAt = this.now();
      await this.save(next);
    });
  }

  private async save(next: LabelsDocument): Promise<void> {
    const valid = LabelsDocument.parse(next);
    await this.kv.set(this.key, JSON.stringify(valid));
    this.doc = valid;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Sets or removes (no label, not frozen) a coin's mark. */
function setMark(w: WalletLabels, outpoint: string, m: CoinMark): void {
  if (m.label === undefined && !m.frozen) delete w.coins[outpoint];
  else w.coins[outpoint] = m;
}
