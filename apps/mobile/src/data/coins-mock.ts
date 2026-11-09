/**
 * Coin control for the demo (`WalletService.coins`): the same `CoinActions` as the real wallet, with made-up coins, so
 * every coin control screen can be looked at without a guardian or a chain. Spending starts with seven coins (a few with
 * labels, one tiny one frozen as a dust attack would be); Savings' coins come from what was added to it.
 *
 * The demo moves its balance by itself (payments, "Add to Savings"): the coin lists follow it the way a wallet would,
 * the largest coins that are not frozen paying and the change coming back as a coin (`reconcile`). A manual pick and a
 * consolidation change the list exactly. The coins hold nothing: their txids are samples.
 *
 * "Business", the second wallet some tests start the demo with, has a frozen dust coin too, so "Move everything" before removing it
 * offers "Include 1 frozen coin". An address labeled on Receive names the coins received there afterwards.
 */
import { WalletServiceError } from './errors';
import { planSend, remainingToday } from './rules';
import type { CoinActions } from './coin-actions';
import type { MockHooks } from './rk-mock';
import type { ActivityItem, CoinListView, CoinView, CoinWallet, ConsolidateQuote, FeeSpeed, LabelsImportSummary, Sats, SavingsActivityItem, SendQuote, SendRequest, QuoteOutcome, WalletState } from './types';

/** The demo's fee rate per speed (sat/vB): the slow one is "low", as on a quiet day. */
const DEMO_RATE: Record<FeeSpeed, number> = { slow: 2, normal: 5, fast: 12 };
/** At or under this slow rate fees count as low (the wallet's `LOW_FEE_SAT_PER_VB`). */
const LOW_RATE = 3;
/** A 2-of-3 input, the transaction's overhead and one P2WSH output (vbytes), as the wallet estimates them. */
const VB_INPUT = 105;
const VB_BASE = 11 + 43;
const MIN_COIN: Sats = 546;
/** "All small coins": under this (sats). */
const SMALL: Sats = 100_000;

const sample = (seed: string) => (seed + 'c0ffee5a11ad0b5e7a9e1d3c2b4f6a8e0d9c7b5a3f1e2d4c6b8a0f9e7d5c3b1a').slice(0, 64);
const iso = (s: string) => new Date(s).toISOString();

interface DemoCoin {
  outpoint: string;
  valueSats: Sats;
  confirmations: number;
  change: boolean;
  source: CoinView['source'];
  /** The receive address it came to (coins received in the demo after it started): for address labels. */
  address?: string;
}

/** Spending's coins at the start: 4,210,000 sats, the demo's balance. */
function startingCoins(): DemoCoin[] {
  const c = (seed: string, valueSats: Sats, confirmations: number, source: CoinView['source'], change = false): DemoCoin => ({
    outpoint: `${sample(seed)}:${change ? 1 : 0}`,
    valueSats,
    confirmations,
    change,
    source: { ...source, txid: sample(seed) },
  });
  return [
    c('a1', 2_500_000, 410, { kind: 'received', txid: '', label: 'Salary October', at: iso('2026-10-01T09:12:00') }),
    c('a2', 1_200_000, 260, { kind: 'received', txid: '', at: iso('2026-10-11T18:40:00') }),
    c('a3', 380_000, 120, { kind: 'payment', txid: '', recipient: 'tb1q7tuen4r8m2kd5vq3jw6hf9ztc0p7lsx0ah', amountSats: 120_000, label: 'Shop', at: iso('2026-10-20T12:05:00') }, true),
    c('a4', 85_000, 90, { kind: 'received', txid: '', at: iso('2026-10-22T08:30:00') }),
    c('a5', 30_000, 44, { kind: 'received', txid: '', at: iso('2026-10-25T16:00:00') }),
    c('a6', 12_000, 12, { kind: 'received', txid: '', at: iso('2026-10-28T10:10:00') }),
    c('a7', 3_000, 6, { kind: 'received', txid: '', at: iso('2026-10-29T07:55:00') }),
  ];
}

/** "Business" (account 2) at the start: 850,000 sats, its balance, of which a 3,000 sats dust coin is frozen. */
function businessCoins(): DemoCoin[] {
  return [
    { outpoint: `${sample('b1')}:0`, valueSats: 847_000, confirmations: 380, change: false, source: { kind: 'received', txid: sample('b1'), at: iso('2026-10-21T09:12:00') } },
    { outpoint: `${sample('b2')}:0`, valueSats: 3_000, confirmations: 120, change: false, source: { kind: 'received', txid: sample('b2'), at: iso('2026-10-24T13:40:00') } },
  ];
}

/** Labels and freezes the demo starts with: a few labels, the 3,000 sats coin frozen (it came from nobody the owner knows). */
function startingMarks(coins: DemoCoin[]): Map<string, { label?: string; frozen?: true }> {
  const by = (seed: string) => coins.find((x) => x.outpoint.startsWith(sample(seed)))!.outpoint;
  return new Map<string, { label?: string; frozen?: true }>([
    [by('a1'), { label: 'Salary' }],
    [by('a2'), { label: 'From the exchange' }],
    [by('a7'), { label: 'Dust: unknown sender', frozen: true }],
  ]);
}

export interface CoinsMockHost extends MockHooks {
  nextId(prefix: string): string;
  /** The demo started with "Business" at account 2 (`MockOptions.secondWallet`): its two coins. Else a wallet added there starts empty. */
  businessWallet?: boolean;
}

export interface MockCoins {
  actions: CoinActions;
  /** Spending's (or Savings') frozen coins (sats): left out of the demo's Send max. */
  frozenSats(wallet?: CoinWallet): Sats;
  /** A demo wallet's frozen Spending coins (`account`), shown or not: what "Move everything" leaves unless included. */
  frozenOf(account: number): { coins: number; sats: Sats } | undefined;
  /** "Move everything" with the frozen coins included went out of `account`: they are spent too. */
  spentFrozen(account: number): void;
  /** Savings' coins picked by hand: the quote counts only them (`savings.quote({ coins })`), as the real wallet does. */
  savingsPick(coins: string[]): { sats: Sats; mixesLabels?: string[] } | { problem: string };
  /** A Savings payment of picked coins went out: exactly those coins pay, the change comes back as a coin. */
  paidFromSavings(coins: string[], totalSats: Sats): void;
  /** A quote with `request.coins` (or without, for automatic selection with the frozen coins left out). */
  quoteWithCoins(state: WalletState, request: SendRequest, base: QuoteOutcome): QuoteOutcome;
  /** A payment of the demo went out: a manual pick takes exactly its coins. */
  paid(quote: SendQuote): void;
}

export function createMockCoins(h: CoinsMockHost): MockCoins {
  /** Per demo wallet (account) and per Spending or Savings: the coins, and their labels and freezes. */
  const lists = new Map<string, DemoCoin[]>();
  const markMaps = new Map<string, Map<string, { label?: string; frozen?: true }>>();
  const keyOf = (wallet: CoinWallet, s: WalletState = h.get()) => `${s.wallets?.current.account ?? 0}:${wallet}`;
  const marksAt = (k: string) => {
    if (!markMaps.has(k)) markMaps.set(k, new Map());
    return markMaps.get(k)!;
  };
  const marksOf = (wallet: CoinWallet) => marksAt(keyOf(wallet));
  /** Address labels (Receive's "Label this address"), per demo wallet and Spending or Savings. */
  const addrMaps = new Map<string, Map<string, string>>();
  const addrsOf = (wallet: CoinWallet) => {
    const k = keyOf(wallet);
    if (!addrMaps.has(k)) addrMaps.set(k, new Map());
    return addrMaps.get(k)!;
  };
  const quotes = new Map<string, ConsolidateQuote>();
  let counter = 0;

  const balanceOf = (wallet: CoinWallet, s: WalletState = h.get()) => (wallet === 'savings' ? s.savings.balanceSats : s.balanceSats);
  const available = (wallet: CoinWallet, s: WalletState = h.get()) => (wallet === 'savings' ? s.savings.status === 'active' : s.mode === 'guardian' && s.onboarded);
  const frozen = (wallet: CoinWallet, op: string) => !!marksOf(wallet).get(op)?.frozen;

  /** Savings' first coins: one per payment received into it. */
  const savingsStart = (s: WalletState): DemoCoin[] =>
    s.savings.activity
      .filter((a: SavingsActivityItem) => a.kind === 'received')
      .reverse()
      .map((a) => ({ outpoint: `${a.txid}:0`, valueSats: a.amountSats, confirmations: a.status === 'confirmed' ? 30 : 0, change: false, source: { kind: 'received' as const, txid: a.txid, at: a.at } }));

  /** A wallet's list as it started, made once (no reconciling with the balance: that is `coins`). */
  const started = (key: string, wallet: CoinWallet, s: WalletState): DemoCoin[] => {
    if (!lists.has(key)) {
      // The first wallet's Spending starts with the seven coins, Business with its two; another demo wallet with whatever its balance is.
      const business = key === '2:spending' && !!h.businessWallet;
      const start = wallet === 'savings' ? savingsStart(s) : key === '0:spending' ? startingCoins() : business ? businessCoins() : [];
      lists.set(key, start);
      if (key === '0:spending') markMaps.set(key, startingMarks(start));
      else if (business) markMaps.set(key, new Map([[start[1]!.outpoint, { label: 'Dust: unknown sender', frozen: true as const }]]));
      else if (wallet === 'savings' && start[0]) marksAt(key).set(start[0].outpoint, { label: 'Cold storage' });
    }
    return lists.get(key)!;
  };

  /** The coins as the balance stands now: what changed it by other means paid by the largest coins not frozen, or arrived. */
  const coins = (wallet: CoinWallet): DemoCoin[] => {
    const s = h.get();
    const key = keyOf(wallet, s);
    const list = started(key, wallet, s);
    const diff = list.reduce((t, c) => t + c.valueSats, 0) - balanceOf(wallet, s);
    if (diff < 0) {
      const id = sample(h.nextId('rx').replace(/[^0-9a-f]/g, ''));
      // Received at the address Receive shows now (Spending's): a label set on it there names this coin.
      list.push({ outpoint: `${id}:0`, valueSats: -diff, confirmations: 0, change: false, source: { kind: 'received', txid: id, at: h.now.toISOString() }, ...(wallet === 'spending' && s.receiveAddress ? { address: s.receiveAddress } : {}) });
    } else if (diff > 0) {
      const payers = list.filter((c) => !frozen(wallet, c.outpoint)).sort((a, b) => b.valueSats - a.valueSats);
      let paid = 0;
      for (const c of payers) {
        if (paid >= diff) break;
        list.splice(list.indexOf(c), 1);
        paid += c.valueSats;
      }
      const back = paid - diff;
      if (back > 0) {
        const id = sample(h.nextId('chg').replace(/[^0-9a-f]/g, ''));
        list.push({ outpoint: `${id}:1`, valueSats: back, confirmations: 0, change: true, source: { kind: 'payment', txid: id, at: h.now.toISOString() } });
      }
    }
    return list;
  };

  const view = (wallet: CoinWallet, c: DemoCoin): CoinView => {
    const m = marksOf(wallet).get(c.outpoint);
    const addressLabel = c.address ? addrsOf(wallet).get(c.address) : undefined;
    return {
      outpoint: c.outpoint,
      txid: c.outpoint.split(':')[0]!,
      vout: Number(c.outpoint.split(':')[1]),
      valueSats: c.valueSats,
      confirmations: c.confirmations,
      unconfirmed: c.confirmations === 0,
      pendingChange: c.confirmations === 0 && c.change,
      change: c.change,
      frozen: !!m?.frozen,
      ...(m?.label ? { label: m.label } : addressLabel ? { label: addressLabel, labelFromAddress: true as const } : {}),
      ...(addressLabel ? { addressLabel } : {}),
      source: c.source,
    };
  };

  const list = (wallet: CoinWallet): CoinListView | null => {
    if (!available(wallet)) return null;
    const all = coins(wallet).map((c) => view(wallet, c));
    const sum = (f: (c: CoinView) => boolean) => all.reduce((t, c) => (f(c) ? t + c.valueSats : t), 0);
    all.sort((a, b) => (b.confirmations || -1) - (a.confirmations || -1));
    return { wallet, coins: all, totals: { count: all.length, totalSats: sum(() => true), spendableSats: sum((c) => !c.frozen), frozenSats: sum((c) => c.frozen), unconfirmedSats: sum((c) => c.unconfirmed) }, truncated: false };
  };

  const mark = (wallet: CoinWallet, outpoint: string, change: (m: { label?: string; frozen?: true }) => void) => {
    if (!coins(wallet).some((c) => c.outpoint === outpoint)) throw new WalletServiceError('invalid_input', 'That coin is not in this wallet any more.');
    const m = { ...marksOf(wallet).get(outpoint) };
    change(m);
    if (!m.label && !m.frozen) marksOf(wallet).delete(outpoint);
    else marksOf(wallet).set(outpoint, m);
    bumpLabels();
  };

  /** The coins named (refused: frozen, gone), or every confirmed coin not frozen. */
  const pick = (wallet: CoinWallet, outpoints: string[] | undefined, opts: { confirmedOnly?: boolean } = {}): DemoCoin[] => {
    const all = coins(wallet);
    if (!outpoints) return all.filter((c) => !frozen(wallet, c.outpoint) && (!opts.confirmedOnly || c.confirmations > 0));
    return [...new Set(outpoints)].map((op) => {
      const c = all.find((x) => x.outpoint === op);
      if (!c) throw new WalletServiceError('invalid_input', `The coin ${op.slice(0, 8)}… cannot pay: it is spent.`);
      if (frozen(wallet, op)) throw new WalletServiceError('invalid_input', `The coin ${op.slice(0, 8)}… is frozen. Unfreeze it to spend it.`);
      return c;
    });
  };
  const labelsOf = (wallet: CoinWallet, chosen: DemoCoin[]) => {
    const set = new Set(chosen.map((c) => view(wallet, c).label ?? ''));
    return set.size > 1 ? [...set].filter(Boolean) : undefined;
  };
  const bumpLabels = () => h.update((s) => ({ labelsVersion: (s.labelsVersion ?? 0) + 1, ...(s.backup ? { backup: { ...s.backup, labelsNewer: true as const } } : {}) }));
  /** The change of a payment of picked coins, back as an unconfirmed coin. */
  const payWith = (wallet: CoinWallet, picked: string[], totalSats: Sats, source: Partial<CoinView['source']> = {}) => {
    const list = coins(wallet);
    let spent = 0;
    for (const op of picked) {
      const i = list.findIndex((c) => c.outpoint === op);
      if (i >= 0) spent += list.splice(i, 1)[0]!.valueSats;
    }
    const back = spent - totalSats;
    if (back > 0) {
      const id = sample(h.nextId('chg').replace(/[^0-9a-f]/g, ''));
      list.push({ outpoint: `${id}:1`, valueSats: back, confirmations: 0, change: true, source: { kind: 'payment', txid: id, at: h.now.toISOString(), ...source } });
    }
  };

  const actions: CoinActions = {
    list,
    addressLabel: (wallet, address) => addrsOf(wallet).get(address.trim()),
    async setAddressLabel(wallet, address, label) {
      await h.wait(150);
      const text = label.trim().slice(0, 255);
      if (!/^(tb1|bc1|bcrt1)[a-z0-9]{20,}$/i.test(address.trim())) throw new WalletServiceError('invalid_input', 'That is not an address of this wallet.');
      if (text) addrsOf(wallet).set(address.trim(), text);
      else addrsOf(wallet).delete(address.trim());
      bumpLabels();
    },
    async setLabel(wallet, outpoint, label) {
      await h.wait(150);
      mark(wallet, outpoint, (m) => {
        const text = label.trim().slice(0, 255);
        if (text) m.label = text;
        else delete m.label;
      });
    },
    async setFrozen(wallet, outpoint, isFrozen) {
      await h.wait(150);
      mark(wallet, outpoint, (m) => {
        if (isFrozen) m.frozen = true;
        else delete m.frozen;
      });
    },
    smallCoins: (wallet) => (available(wallet) ? coins(wallet).filter((c) => !frozen(wallet, c.outpoint) && c.confirmations > 0 && c.valueSats < SMALL).map((c) => c.outpoint) : []),
    quoteConsolidate(wallet, req) {
      if (!available(wallet)) return { ok: false, message: wallet === 'savings' ? 'Set up Savings first.' : 'The wallet is not set up yet.' };
      let chosen: DemoCoin[];
      try {
        chosen = pick(wallet, req.coins, { confirmedOnly: true });
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      if (chosen.length < 2) return { ok: false, message: 'Pick at least 2 coins to merge into one.' };
      const speed = req.speed ?? 'slow';
      const rate = DEMO_RATE[speed];
      const feeSats = Math.ceil((VB_BASE + VB_INPUT * chosen.length) * rate);
      const inputSats = chosen.reduce((t, c) => t + c.valueSats, 0);
      if (inputSats - feeSats < MIN_COIN) return { ok: false, message: `After the ${feeSats} sats network fee, these coins would leave less than the smallest coin (${MIN_COIN} sats).` };
      const s = h.get();
      const plan = wallet === 'spending' ? (req.signer === 'hardware' ? ({ signer: 'hardware', reason: 'requested' } as const) : planSend(s, feeSats)) : undefined;
      const quote: ConsolidateQuote = {
        ref: `dc${++counter}`,
        wallet,
        speed,
        coins: chosen.map((c) => c.outpoint),
        inputSats,
        amountSats: inputSats - feeSats,
        feeSats,
        feeRateSatPerVb: rate,
        feesLow: DEMO_RATE.slow <= LOW_RATE,
        ...(plan ? { plan, remainingAfterSats: plan.signer === 'phone+guardian' ? remainingToday(s) - feeSats : remainingToday(s) } : {}),
        ...(labelsOf(wallet, chosen) ? { mixesLabels: labelsOf(wallet, chosen) } : {}),
      };
      quotes.set(quote.ref!, quote);
      return { ok: true, quote };
    },
    async consolidate(quote, opts = {}) {
      const q = quote.ref ? quotes.get(quote.ref) : undefined;
      if (!q) throw new WalletServiceError('quote_stale', 'This needs a fresh quote. Go back and check it again.');
      const hardware = q.wallet === 'savings' || q.plan?.signer === 'hardware';
      await h.wait(hardware ? h.deviceDelay : h.networkDelay);
      const list = coins(q.wallet);
      for (const op of q.coins) {
        const i = list.findIndex((c) => c.outpoint === op);
        if (i < 0) throw new WalletServiceError('quote_stale', 'Your coins changed since this was prepared. Go back and check it again.');
        list.splice(i, 1);
      }
      const id = sample(h.nextId('cons').replace(/[^0-9a-f]/g, ''));
      list.push({ outpoint: `${id}:0`, valueSats: q.amountSats, confirmations: 0, change: true, source: { kind: 'payment', txid: id, at: h.now.toISOString() } });
      const at = h.now.toISOString();
      if (q.wallet === 'savings') {
        const signers = opts.signers ?? 'phone+hardware';
        h.update((s) => ({
          savings: {
            ...s.savings,
            balanceSats: s.savings.balanceSats - q.feeSats,
            activity: [{ id: h.nextId('sv'), txid: id, kind: 'consolidated', amountSats: q.feeSats, feeSats: q.feeSats, at, status: 'pending', signedBy: signers }, ...s.savings.activity],
          },
        }));
        return { id, txid: id, amountSats: q.amountSats, feeSats: q.feeSats, signedBy: signers };
      }
      const signedBy = hardware ? ('phone+hardware' as const) : ('phone+guardian' as const);
      const item: ActivityItem = {
        type: 'payment',
        at,
        tx: { id, kind: 'sent', amountSats: q.feeSats, feeSats: q.feeSats, status: 'pending', at, txid: id, signedBy, consolidated: true, consolidatedSats: q.amountSats, canSpeedUp: true },
      };
      h.update((s) => ({
        balanceSats: s.balanceSats - q.feeSats,
        activity: [item, ...s.activity],
        ...(signedBy === 'phone+guardian' ? { dailyLimit: { ...s.dailyLimit, usedSats: s.dailyLimit.usedSats + q.feeSats, cosignedCount: (s.dailyLimit.cosignedCount ?? 0) + 1 } } : {}),
      }));
      return { id, txid: id, amountSats: q.amountSats, feeSats: q.feeSats, signedBy };
    },
    async exportLabels() {
      // The demo has no file to hand over: the share sheet would open here with a BIP 329 file.
      await h.wait(h.networkDelay);
    },
    async importLabels(wallet): Promise<LabelsImportSummary | null> {
      await h.wait(h.networkDelay);
      // As if the person picked a file another wallet exported: one label for the largest coin, one record of another wallet.
      const largest = [...coins(wallet)].sort((a, b) => b.valueSats - a.valueSats)[0];
      if (largest) mark(wallet, largest.outpoint, (m) => void (m.label = m.label ?? 'Imported from Sparrow'));
      return { coinLabels: largest ? 1 : 0, frozen: 0, unfrozen: 0, txLabels: 0, addrLabels: 0, kept: 1, otherWallet: 1, errorCount: 0, truncated: 0 };
    },
  };

  return {
    actions,
    frozenSats: (wallet = 'spending') => (available(wallet) ? coins(wallet).filter((c) => frozen(wallet, c.outpoint)).reduce((t, c) => t + c.valueSats, 0) : 0),
    quoteWithCoins(state, request, base) {
      if (!base.ok || state.mode !== 'guardian' || !available('spending')) return base;
      if (!request.coins?.length) return base;
      let chosen: DemoCoin[];
      try {
        chosen = pick('spending', request.coins);
      } catch (e) {
        return { ok: false, problem: 'other', message: (e as Error).message };
      }
      const have = chosen.reduce((t, c) => t + c.valueSats, 0);
      if (have < base.quote.request.amountSats + base.quote.feeSats)
        return { ok: false, problem: 'insufficient_funds', message: "The coins you picked don't hold enough for that and the network fee. Pick more, or let Trikey choose." };
      const mixes = labelsOf('spending', chosen);
      return { ok: true, quote: { ...base.quote, request: { ...base.quote.request, coins: chosen.map((c) => c.outpoint) }, ...(mixes ? { mixesLabels: mixes } : {}) } };
    },
    paid(quote) {
      const picked = quote.request.coins;
      if (!picked?.length) return;
      payWith('spending', picked, quote.totalSats, { amountSats: quote.request.amountSats, recipient: quote.request.address });
    },
    frozenOf(account) {
      const key = `${account}:spending`;
      const list = started(key, 'spending', h.get());
      const marks = marksAt(key);
      const frozen = list.filter((c) => marks.get(c.outpoint)?.frozen);
      return frozen.length ? { coins: frozen.length, sats: frozen.reduce((t, c) => t + c.valueSats, 0) } : undefined;
    },
    spentFrozen(account) {
      const key = `${account}:spending`;
      const marks = marksAt(key);
      const list = lists.get(key);
      if (list) lists.set(key, list.filter((c) => !marks.get(c.outpoint)?.frozen));
    },
    savingsPick(picked) {
      if (!available('savings')) return { problem: 'Set up Savings first.' };
      try {
        const chosen = pick('savings', picked);
        const mixes = labelsOf('savings', chosen);
        return { sats: chosen.reduce((t, c) => t + c.valueSats, 0), ...(mixes ? { mixesLabels: mixes } : {}) };
      } catch (e) {
        return { problem: (e as Error).message };
      }
    },
    paidFromSavings(picked, totalSats) {
      if (picked.length) payWith('savings', picked, totalSats);
    },
  };
}
