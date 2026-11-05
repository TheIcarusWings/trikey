/**
 * The coin list (DESIGN.md, "Coin control"): what the Coins screen of a wallet (Spending or Savings) shows, and
 * which coins a payment may take. Pure: it reads the wallet's last sync, this phone's own pending spends
 * (`own-spends.ts`), the send log and the labels (`labels-store.ts`), and changes none of them.
 *
 * - **Listed:** every coin of the sync, with this phone's own unconfirmed spends applied again (`applyOwnSpends`, which
 *   changes nothing when the sync already has them): a coin such a payment spends is never listed, whatever the
 *   guardian's server says, and that payment's change is listed as an unconfirmed coin (`pendingChange`).
 * - **Per coin:** amount, confirmations (0: unconfirmed), the payment it came from (`source`: a payment this phone
 *   made, a received payment, or change of a payment made elsewhere), its label and whether it is frozen. A coin without
 *   a label of its own shows its address's label (set on Receive before the address was shared, or imported):
 *   `labelFromAddress`.
 * - **Selection** (`selectableCoins`): automatic selection and Send max take every coin that is not frozen; a manual
 *   pick takes exactly the coins named, and refuses one that is frozen or not listed (`coin_unavailable`). Which of
 *   them pay, and whether unconfirmed ones may, stays with `send.ts`, which this does not change.
 */
import type { WalletUtxo } from '@trikey/protocol';
import { WalletError } from './errors.js';
import { outpointRef } from './labels-bip329.js';
import type { WalletLabelsView } from './labels-store.js';
import { applyOwnSpends, type OwnSpend } from './own-spends.js';
import type { ChainCache } from './state.js';

/** A payment of the send log (Spending's `SendLogEntry` or Savings' `SavingsSendEntry`), as a coin's source. */
export interface CoinSourcePayment {
  txid: string;
  /** ms, the phone's clock. */
  at: number;
  recipient: string;
  amountSats: number;
  label?: string;
  purpose?: string;
}

/** Where a coin came from. */
export interface CoinSource {
  txid: string;
  /**
   * `payment`: change (or another output to the wallet) of a payment this phone made (send log, or its own pending
   * spend); `received`: a payment into a receive address; `change`: change of a payment this phone has no record of
   * (made before a restore, or signed elsewhere).
   */
  kind: 'payment' | 'received' | 'change';
  /** The payment's label: the one set on it (labels store), else the send log's. */
  label?: string;
  /** `payment`: whom it paid, and how much (sats, fee not included). */
  recipient?: string;
  amountSats?: number;
  /** `payment`: when this phone sent it (ms). */
  at?: number;
  /** Its block's time (unix seconds), when the sync's history has it confirmed. */
  time?: number;
}

export interface Coin {
  /** `txid:vout`, the coin's key everywhere (labels, BIP 329, a manual pick). */
  outpoint: string;
  txid: string;
  vout: number;
  valueSats: number;
  /** Receive (0) or change (1) chain, and the address index. */
  chain: 0 | 1;
  index: number;
  /** 0 while unconfirmed. */
  height: number;
  confirmations: number;
  unconfirmed: boolean;
  /** Change of this phone's own payment that no sync has listed yet (`own-spends.ts`). */
  pendingChange: boolean;
  frozen: boolean;
  /** The coin's label, or, when it has none of its own, its address's (`labelFromAddress`). */
  label?: string;
  /** `label` is its address's label: the coin has none of its own. */
  labelFromAddress?: true;
  /** The label of the address it sits at, when that address has one (whether or not the coin has its own). */
  addressLabel?: string;
  source: CoinSource;
}

export interface CoinTotals {
  count: number;
  totalSats: number;
  /** What automatic selection may take: every coin not frozen (unconfirmed ones included, as today). */
  spendableSats: number;
  frozenSats: number;
  unconfirmedSats: number;
}

export interface CoinList {
  walletId: string;
  /** Oldest first (by height; unconfirmed last), then by txid and output. */
  coins: Coin[];
  totals: CoinTotals;
  /** The guardian listed only part of the coins (`utxosTruncated`): the list, and so a manual pick, may miss some. */
  truncated: boolean;
}

export interface CoinListInput {
  walletId: string;
  /** The wallet's last sync (`WalletState.chain`, or Savings' `chain`); undefined before the first one. */
  chain: ChainCache | undefined;
  /** This phone's own pending spends (`WalletState.ownSpends`): only the records of `walletId` count. */
  ownSpends?: readonly OwnSpend[];
  /** The wallet's send log. */
  sendLog?: readonly CoinSourcePayment[];
  /** The wallet's labels (`LabelStore.view(walletId)`). */
  labels?: WalletLabelsView;
  /**
   * The wallet's address at a chain and index, for address labels. Called only when the wallet has an address label (an
   * address takes a few key derivations), and at most once per coin.
   */
  addressOf?: (chain: 0 | 1, index: number) => string;
}

const NO_LABELS: WalletLabelsView = { coin: () => ({ frozen: false }), tx: () => undefined, frozen: new Set(), addr: () => undefined, hasAddressLabels: false, coinLabelsOfTx: () => [] };

/** The wallet's coins as the coin list shows them. Pure. */
export function coinList(input: CoinListInput): CoinList {
  const { walletId } = input;
  const labels = input.labels ?? NO_LABELS;
  const own = (input.ownSpends ?? []).filter((r) => r.walletId === walletId);
  const chain = input.chain ? applyOwnSpends(input.chain, own) : undefined;
  const log = new Map((input.sendLog ?? []).map((e) => [e.txid, e]));
  const ownTx = new Set(own.map((r) => r.txid));
  const history = new Map((chain?.history ?? []).map((h) => [h.txid, h]));
  const listedTx = new Set(input.chain?.utxos.map((u) => u.txid));
  const addressOf = labels.hasAddressLabels ? input.addressOf : undefined;
  const coins = (chain?.utxos ?? []).map((u): Coin => {
    const outpoint = outpointRef(u.txid, u.vout);
    const mark = labels.coin(outpoint);
    const addressLabel = addressOf ? labels.addr(addressOf(u.chain, u.index)) : undefined;
    const sent = log.get(u.txid);
    const h = history.get(u.txid);
    const kind: CoinSource['kind'] = sent || ownTx.has(u.txid) ? 'payment' : u.chain === 0 ? 'received' : 'change';
    const sourceLabel = labels.tx(u.txid) ?? (sent?.label?.trim() || undefined);
    const source: CoinSource = {
      txid: u.txid,
      kind,
      ...(sourceLabel ? { label: sourceLabel } : {}),
      ...(sent ? { recipient: sent.recipient, amountSats: sent.amountSats, at: sent.at } : {}),
      ...(h?.time !== undefined && h.confirmations > 0 ? { time: h.time } : {}),
    };
    return {
      outpoint,
      txid: u.txid,
      vout: u.vout,
      valueSats: u.valueSats,
      chain: u.chain,
      index: u.index,
      height: u.height,
      confirmations: u.confirmations,
      unconfirmed: u.confirmations === 0,
      pendingChange: ownTx.has(u.txid) && !listedTx.has(u.txid),
      frozen: mark.frozen,
      ...(mark.label !== undefined ? { label: mark.label } : addressLabel !== undefined ? { label: addressLabel, labelFromAddress: true as const } : {}),
      ...(addressLabel !== undefined ? { addressLabel } : {}),
      source,
    };
  });
  coins.sort((a, b) => (a.height || Infinity) - (b.height || Infinity) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
  return { walletId, coins, totals: totalsOf(coins), truncated: !!chain?.utxosTruncated };
}

/**
 * The labels a received payment shows in Activity when it has no label of its own: those of the coins it brought in, in
 * output order, without repeats. A coin's own label stays after it is spent (`WalletLabelsView.coinLabelsOfTx`); an
 * address's label shows through a coin still in `list` (the guardian's history does not say which address a spent coin
 * sat at). Pure.
 */
export function receivedLabels(txid: string, list: CoinList | readonly Coin[] | undefined, labels: WalletLabelsView | undefined): string[] {
  const all = !list ? [] : 'coins' in list ? list.coins : list;
  const out = [...(labels?.coinLabelsOfTx(txid) ?? [])];
  for (const c of [...all].filter((x) => x.txid === txid).sort((a, b) => a.vout - b.vout)) if (c.label) out.push(c.label);
  return [...new Set(out)];
}

/** The sums of a list of coins. */
export function totalsOf(coins: readonly Coin[]): CoinTotals {
  const sum = (f: (c: Coin) => boolean) => coins.reduce((s, c) => (f(c) ? s + c.valueSats : s), 0);
  return { count: coins.length, totalSats: sum(() => true), spendableSats: sum((c) => !c.frozen), frozenSats: sum((c) => c.frozen), unconfirmedSats: sum((c) => c.unconfirmed) };
}

/** What a payment may spend. */
export interface SelectableCoins {
  coins: Coin[];
  /** The same coins as `send.ts` takes them (`selectCoins`, `selectAllCoins`). */
  utxos: WalletUtxo[];
  /**
   * The coins carry different labels (a coin without one counts as its own label): spending them together links them on
   * chain, so the app warns first. Only for a manual pick: automatic selection chooses its own subset.
   */
  mixesLabels: boolean;
  /** The distinct coin labels among them (unlabeled coins left out). */
  labels: string[];
}

/**
 * The coins a payment may take. Without `manual`, every coin that is not frozen (automatic selection and Send max).
 * With `manual`, exactly those coins, in the order given; throws `coin_unavailable` (`reason: 'not_found'`) for one the
 * list does not have (spent, spent by this phone's own pending payment, or never the wallet's) and (`reason: 'frozen'`)
 * for a frozen one: the person unfreezes it first. `includeFrozen` takes frozen coins too, for the one move that asks
 * for them by name ("Move everything" before removing a wallet, with "Include 1 frozen coin" on). Pure.
 */
export function selectableCoins(list: CoinList | readonly Coin[], opts: { manual?: readonly string[]; includeFrozen?: boolean } = {}): SelectableCoins {
  const all = 'coins' in list ? list.coins : list;
  let chosen: Coin[];
  if (opts.manual) {
    const by = new Map(all.map((c) => [c.outpoint, c]));
    const seen = new Set<string>();
    chosen = [];
    for (const raw of opts.manual) {
      const op = raw.toLowerCase();
      if (seen.has(op)) continue;
      seen.add(op);
      const c = by.get(op);
      if (!c) throw new WalletError('coin_unavailable', `The coin ${raw} cannot pay: it is spent, or waits in a payment of this phone that has not confirmed.`, { reason: 'not_found' });
      if (c.frozen && !opts.includeFrozen) throw new WalletError('coin_unavailable', `The coin ${raw} is frozen. Unfreeze it to spend it.`, { reason: 'frozen' });
      chosen.push(c);
    }
    if (!chosen.length) throw new WalletError('coin_unavailable', 'Pick at least one coin.', { reason: 'not_found' });
  } else chosen = opts.includeFrozen ? [...all] : all.filter((c) => !c.frozen);
  const distinct = new Set(chosen.map((c) => c.label ?? ''));
  return {
    coins: chosen,
    utxos: chosen.map((c) => ({ txid: c.txid, vout: c.vout, valueSats: c.valueSats, height: c.height, confirmations: c.confirmations, chain: c.chain, index: c.index })),
    mixesLabels: !!opts.manual && distinct.size > 1,
    labels: [...distinct].filter((l) => l !== ''),
  };
}

/**
 * Under this a coin counts as small (sats): the Consolidate screen's "all small coins". A 2-of-3 input is about 105 vB,
 * so at 50 sat/vB spending a 100,000 sats coin costs about 5% of it; merged now, while fees are low, that cost is paid once.
 */
export const SMALL_COIN_SATS = 100_000;

/** The coins worth merging: confirmed, not frozen, under `maxSats` (default `SMALL_COIN_SATS`), oldest first. Pure. */
export function smallCoins(list: CoinList | readonly Coin[], maxSats: number = SMALL_COIN_SATS): Coin[] {
  const all = 'coins' in list ? list.coins : list;
  return all.filter((c) => !c.frozen && !c.unconfirmed && c.valueSats < maxSats);
}
