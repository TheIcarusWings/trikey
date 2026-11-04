/**
 * "Speed up" of a Spending payment for the guardian mode's real wallet (`WalletService.speedUp`): the wallet's
 * `quoteSpeedUp` at each speed, and `speedUp` with the keys the chosen quote names. Kept apart from ./real.ts, which
 * hands it what it needs (`SpeedUpHost`).
 */
import { WalletError, type GuardianRefusal, type SpeedUpQuote as WalletSpeedUpQuote, type TrikeyWallet } from '@trikey/wallet';
import { WalletServiceError } from './errors';
import { mapError, refusalToError } from './real-errors';
import type { SpeedUpActions } from './speed-up-actions';
import type { FeeSpeed, IsoDate, SpeedUpOutcome, SpeedUpQuote, Transaction } from './types';

export interface SpeedUpHost {
  /** The wallet, if there is one (quotes never throw for want of it). */
  wallet(): TrikeyWallet | undefined;
  requireWallet(): TrikeyWallet;
  /** Runs a signing job: one at a time with the other device jobs, with the guardian's answer (or silence) noted. */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** The payment is out (or failed): no longer "Sending…". */
  sendingDone(): void;
  /** After a replacement went out: show it, and sync on its own. */
  sent(): void;
  /** A broadcast that failed after signing, in words (listed in Activity when the guardian may have sent it). */
  broadcastError(refusal: GuardianRefusal): WalletServiceError;
  iso(ms: number): IsoDate;
  now(): number;
}

const SPEEDS: FeeSpeed[] = ['slow', 'normal', 'fast'];

export function createSpeedUpActions(host: SpeedUpHost): SpeedUpActions {
  const quotes = new Map<string, WalletSpeedUpQuote>();
  let counter = 0;
  const view = (q: WalletSpeedUpQuote, speed: FeeSpeed): SpeedUpQuote => {
    const ref = `b${++counter}`;
    quotes.set(ref, q);
    if (quotes.size > 30) quotes.delete(quotes.keys().next().value!);
    return {
      ref,
      txid: q.replaces,
      speed,
      address: q.recipient,
      amountSats: q.amountSats,
      oldFeeSats: q.oldFeeSats,
      feeSats: q.feeSats,
      oldFeeRate: q.oldFeeRate,
      feeRate: q.feeRate,
      extraFeeSats: q.extraFeeSats,
      plan: q.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'hardware', reason: q.plan.reason },
      limitSats: q.limitSats,
      ...(q.alreadyAtRate ? { alreadyAtRate: true as const } : {}),
    };
  };

  return {
    async quote(txid, opts = {}): Promise<SpeedUpOutcome> {
      const w = host.wallet();
      if (!w || w.stage !== 'paired') return { ok: false, message: 'The wallet is not set up yet.' };
      try {
        const out: Partial<Record<FeeSpeed, SpeedUpQuote>> = {};
        // One after the other: the first reads the transaction (from the phone, else the guardian), the others reuse it.
        for (const speed of SPEEDS) out[speed] = view(await w.quoteSpeedUp(txid, { speed, ...(opts.signer ? { signer: opts.signer } : {}) }), speed);
        return { ok: true, quotes: out };
      } catch (e) {
        // Reading the transaction goes through the guardian: its refusals and timeouts read as everywhere else.
        return { ok: false, message: e instanceof WalletError && e.code === 'cannot_speed_up' ? e.message : mapError(e).message };
      }
    },

    send(quote): Promise<Transaction> {
      return host.run(async () => {
        const w = host.requireWallet();
        const real = quote.ref ? quotes.get(quote.ref) : undefined;
        if (!real) throw new WalletServiceError('quote_stale', 'This needs a fresh quote. Go back and check it again.');
        // What the person saw (the keys it names) is what happens: no silent fallback to the hardware wallet after a
        // refusal (the screen offers it). The sync after it runs on its own, so "Sending…" ends when it is out.
        const plan: WalletSpeedUpQuote['plan'] = quote.plan.signer === 'phone+guardian' ? { signer: 'phone+guardian' } : { signer: 'phone+hardware', reason: real.plan.signer === 'phone+hardware' ? real.plan.reason : 'requested' };
        let res: Awaited<ReturnType<TrikeyWallet['speedUp']>>;
        try {
          res = await w.speedUp({ ...real, plan }, { fallbackToHardware: false, syncAfter: false });
        } finally {
          host.sendingDone();
        }
        if (!res.ok) {
          if (res.signedTx) throw host.broadcastError(res.refusal);
          throw refusalToError(res.refusal);
        }
        host.sent();
        return {
          id: res.txid,
          kind: 'sent' as const,
          amountSats: res.amountSats,
          feeSats: res.feeSats,
          status: 'pending' as const,
          at: host.iso(host.now()),
          address: quote.address,
          txid: res.txid,
          signedBy: res.signedBy,
          canSpeedUp: true as const,
          spedUp: true as const,
        };
      });
    },
  };
}
