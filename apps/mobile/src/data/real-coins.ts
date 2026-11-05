/**
 * Coin control for the guardian mode's real wallet (`WalletService.coins`): the wallet's coin list, labels and freezes,
 * `quoteConsolidate` / `consolidate` (Spending) and `quoteSavingsConsolidate` / `sendFromSavings` (Savings), and BIP 329
 * export and import through the share sheet and the file picker. Kept apart from ./real.ts, which hands it what it needs
 * (`CoinsHost`).
 */
import { WalletError, smallCoins, type Coin, type CoinList, type GuardianRefusal, type SavingsQuote as WalletSavingsQuote, type SendQuote as WalletQuote, type TrikeyWallet } from '@trikey/wallet';
import type { CoinActions } from './coin-actions';
import { WalletServiceError } from './errors';
import { mapError, refusalToError } from './real-errors';
import type { CoinListView, CoinView, CoinWallet, ConsolidateOutcome, ConsolidateQuote, IsoDate, LabelsImportSummary, SavingsSigners } from './types';

export interface CoinsHost {
  /** The wallet shown, if there is one (the list never throws for want of it). */
  wallet(): TrikeyWallet | undefined;
  requireWallet(): TrikeyWallet;
  /** Its name on this phone (several wallets), for the export's file name. */
  walletName(): string | undefined;
  /** Runs a signing job: one at a time with the other device jobs, with the guardian's answer (or silence) noted. */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** The payment is out (or failed): no longer "Sending…". */
  sendingDone(): void;
  /** After a consolidation went out: show it, and sync on its own. */
  sent(wallet: CoinWallet): void;
  /** A label or freeze changed: the screens read the list again. */
  changed(): void;
  /** A broadcast that failed after signing, in words (listed in Activity when the guardian may have sent it). */
  broadcastError(refusal: GuardianRefusal): WalletServiceError;
  iso(ms: number): IsoDate;
  now(): number;
  /** Hands a text file to the OS share sheet. Absent: not on this platform. */
  shareTextFile?: (name: string, text: string) => Promise<void>;
  /** Lets the person choose a file. Null: they cancelled. Absent: not on this platform. */
  pickFile?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
}

const which = (w: CoinWallet): 'main' | 'savings' => (w === 'savings' ? 'savings' : 'main');

/** Coins of a wallet as the screens show them. */
export function coinListView(list: CoinList, wallet: CoinWallet, iso: (ms: number) => IsoDate, labelsProblem?: string): CoinListView {
  const coin = (c: Coin): CoinView => ({
    outpoint: c.outpoint,
    txid: c.txid,
    vout: c.vout,
    valueSats: c.valueSats,
    confirmations: c.confirmations,
    unconfirmed: c.unconfirmed,
    pendingChange: c.pendingChange,
    change: c.chain === 1,
    frozen: c.frozen,
    ...(c.label !== undefined ? { label: c.label } : {}),
    source: {
      kind: c.source.kind,
      txid: c.source.txid,
      ...(c.source.label ? { label: c.source.label } : {}),
      ...(c.source.recipient ? { recipient: c.source.recipient } : {}),
      ...(c.source.amountSats !== undefined ? { amountSats: c.source.amountSats } : {}),
      ...(c.source.time !== undefined ? { at: iso(c.source.time * 1000) } : c.source.at !== undefined ? { at: iso(c.source.at) } : {}),
    },
  });
  return { wallet, coins: list.coins.map(coin), totals: { ...list.totals }, truncated: list.truncated, ...(labelsProblem ? { labelsProblem } : {}) };
}

/** A wallet error a consolidation quote can say as it is (its message is written for the person). */
function quoteProblem(e: unknown): string {
  if (e instanceof WalletError && ['nothing_to_send', 'send_max_too_small', 'coin_unavailable'].includes(e.code)) return e.message;
  return mapError(e).message;
}

type Held = { wallet: 'spending'; quote: WalletQuote } | { wallet: 'savings'; quote: WalletSavingsQuote };

export function createCoinActions(host: CoinsHost): CoinActions {
  const quotes = new Map<string, Held>();
  let counter = 0;

  const ready = () => {
    const w = host.wallet();
    return w && w.stage === 'paired' ? w : undefined;
  };

  const labelsProblem = (w: TrikeyWallet) => (w.labelsProblem ? "The labels on this phone couldn't be read, so coins show without them." : undefined);

  const change = async (job: (w: TrikeyWallet) => Promise<void>) => {
    try {
      await job(host.requireWallet());
    } catch (e) {
      throw mapError(e);
    }
    host.changed();
  };

  return {
    list(wallet) {
      const w = ready();
      if (!w || (wallet === 'savings' && !w.state.savings)) return null;
      try {
        return coinListView(w.coins(which(wallet)), wallet, host.iso, labelsProblem(w));
      } catch (e) {
        if (e instanceof WalletError && (e.code === 'no_chain_data' || e.code === 'no_savings' || e.code === 'wrong_state')) return null;
        throw mapError(e);
      }
    },

    setLabel: (wallet, outpoint, label) => change((w) => w.setCoinLabel(outpoint, label, which(wallet))),
    setFrozen: (wallet, outpoint, frozen) => change((w) => w.setCoinFrozen(outpoint, frozen, which(wallet))),

    smallCoins(wallet) {
      const w = ready();
      if (!w) return [];
      try {
        return smallCoins(w.coins(which(wallet))).map((c) => c.outpoint);
      } catch {
        return [];
      }
    },

    quoteConsolidate(wallet, req): ConsolidateOutcome {
      const w = ready();
      if (!w) return { ok: false, message: 'The wallet is not set up yet.' };
      const speed = req.speed ?? 'slow';
      try {
        const ref = `c${++counter}`;
        let view: ConsolidateQuote;
        if (wallet === 'savings') {
          const q = w.quoteSavingsConsolidate({ ...(req.coins ? { coins: req.coins } : {}), speed });
          quotes.set(ref, { wallet, quote: q });
          view = {
            ref,
            wallet,
            speed,
            coins: q.request.coins ?? [],
            inputSats: q.consolidate!.inputSats,
            amountSats: q.request.amountSats,
            feeSats: q.feeSats,
            feeRateSatPerVb: q.feeRate,
            feesLow: q.consolidate!.feesLow,
            ...(q.mixesLabels ? { mixesLabels: q.mixesLabels.labels } : {}),
          };
        } else {
          const q = w.quoteConsolidate({ ...(req.coins ? { coins: req.coins } : {}), speed, ...(req.signer === 'hardware' ? { signer: 'hardware' as const } : {}) });
          quotes.set(ref, { wallet, quote: q });
          view = {
            ref,
            wallet,
            speed,
            coins: q.request.coins ?? [],
            inputSats: q.consolidate!.inputSats,
            amountSats: q.request.amountSats,
            feeSats: q.feeSats,
            feeRateSatPerVb: q.feeRate,
            feesLow: q.consolidate!.feesLow,
            plan: q.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'hardware', reason: q.plan.reason },
            remainingAfterSats: q.remainingAfterSats,
            ...(q.mixesLabels ? { mixesLabels: q.mixesLabels.labels } : {}),
          };
        }
        if (quotes.size > 30) quotes.delete(quotes.keys().next().value!);
        return { ok: true, quote: view };
      } catch (e) {
        return { ok: false, message: quoteProblem(e) };
      }
    },

    consolidate(quote, opts = {}) {
      return host.run(async () => {
        const w = host.requireWallet();
        const held = quote.ref ? quotes.get(quote.ref) : undefined;
        if (!held || held.wallet !== quote.wallet) throw new WalletServiceError('quote_stale', 'This needs a fresh quote. Go back and check it again.');
        if (held.wallet === 'savings') {
          const signers: SavingsSigners = opts.signers ?? 'phone+hardware';
          const res = await w.sendFromSavings(held.quote, { signers });
          if (!res.ok) throw res.signedTx ? host.broadcastError(res.refusal) : refusalToError(res.refusal);
          host.sent('savings');
          return { id: res.txid, txid: res.txid, amountSats: held.quote.request.amountSats, feeSats: res.feeSats, signedBy: signers };
        }
        // What the person saw (the keys it names) is what happens: no silent fallback to the hardware wallet after a
        // refusal (the screen offers it). The sync after it runs on its own.
        const plan: WalletQuote['plan'] =
          quote.plan?.signer === 'hardware' ? { signer: 'phone+hardware', reason: held.quote.plan.signer === 'phone+hardware' ? held.quote.plan.reason : 'requested' } : { signer: 'phone+guardian' };
        let res: Awaited<ReturnType<TrikeyWallet['consolidate']>>;
        try {
          res = await w.consolidate({ ...held.quote, plan }, { fallbackToHardware: false, syncAfter: false });
        } finally {
          host.sendingDone();
        }
        if (!res.ok) throw res.signedTx ? host.broadcastError(res.refusal) : refusalToError(res.refusal);
        host.sent('spending');
        return { id: res.txid, txid: res.txid, amountSats: held.quote.request.amountSats, feeSats: res.feeSats, signedBy: res.signedBy };
      });
    },

    async exportLabels(wallet) {
      const w = host.requireWallet();
      if (!host.shareTextFile) throw new WalletServiceError('not_available', "This phone can't share a file from here yet.");
      let text: string;
      try {
        text = w.exportLabels(which(wallet));
      } catch (e) {
        throw mapError(e);
      }
      const name = (host.walletName() ?? 'wallet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wallet';
      const day = new Date(host.now()).toISOString().slice(0, 10);
      await host.shareTextFile(`trikey-${name}${wallet === 'savings' ? '-savings' : ''}-labels-${day}.jsonl`, text);
    },

    async importLabels(wallet): Promise<LabelsImportSummary | null> {
      const w = host.requireWallet();
      if (!host.pickFile) throw new WalletServiceError('not_available', "This phone can't open a file from here yet.");
      const picked = await host.pickFile();
      if (!picked) return null;
      try {
        const r = await w.importLabels(picked.bytes, which(wallet));
        host.changed();
        return {
          coinLabels: r.coinLabels,
          frozen: r.frozen,
          unfrozen: r.unfrozen,
          txLabels: r.txLabels,
          kept: r.kept,
          otherWallet: r.otherWallet,
          errorCount: r.errorCount,
          ...(r.errors[0] ? { firstError: `line ${r.errors[0].line}: ${r.errors[0].message}` } : {}),
          truncated: r.truncated,
        };
      } catch (e) {
        throw mapError(e);
      }
    },
  };
}
