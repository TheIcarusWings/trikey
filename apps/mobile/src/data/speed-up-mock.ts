/**
 * The demo's "Speed up" (`WalletService.speedUp`): a payment sent in the demo (guardian mode) waits to confirm and can be
 * sent again with a higher fee. The demo's payments are about 210 vbytes; the fee of each speed is the demo's
 * (`FEE_SATS`), and never less than the old fee plus 1 sat/vB, as for a real replacement (BIP 125).
 */
import { WalletServiceError } from './errors';
import { FEE_SATS, planSend } from './rules';
import type { SpeedUpActions } from './speed-up-actions';
import type { ActivityItem, FeeSpeed, SpeedUpQuote, Transaction, WalletState } from './types';

/** The demo's size of a payment (vbytes). */
export const DEMO_PAYMENT_VSIZE = 210;

export interface SpeedUpMockHost {
  get(): WalletState;
  update(change: (s: WalletState) => Partial<WalletState>): void;
  wait(ms: number): Promise<void>;
  deviceDelay: number;
  networkDelay: number;
  now: Date;
  nextTxid(): string;
  nextId(prefix: string): string;
}

const SPEEDS: FeeSpeed[] = ['slow', 'normal', 'fast'];

export function createMockSpeedUp(h: SpeedUpMockHost): SpeedUpActions {
  const find = (txid: string) => h.get().activity.find((a): a is Extract<ActivityItem, { type: 'payment' }> => a.type === 'payment' && a.tx.txid === txid);
  return {
    async quote(txid, opts = {}) {
      await h.wait(h.networkDelay);
      const s = h.get();
      const item = find(txid);
      if (s.mode !== 'guardian' || !item) return { ok: false, message: 'That is not a payment of this wallet that Trikey knows of.' };
      const tx = item.tx;
      if (tx.kind !== 'sent') return { ok: false, message: 'Only a payment out of this wallet can be sped up from here. An incoming payment can be sped up by whoever sent it.' };
      if (tx.status === 'confirmed') return { ok: false, message: 'This payment has confirmed already: there is nothing to speed up.' };
      if (!tx.canSpeedUp) return { ok: false, message: 'This payment sends everything, with no change back: there is nothing to pay a higher fee from without lowering what it pays.' };
      const oldFee = tx.feeSats ?? FEE_SATS.normal;
      const quotes: Partial<Record<FeeSpeed, SpeedUpQuote>> = {};
      for (const speed of SPEEDS) {
        const feeSats = Math.max(FEE_SATS[speed], oldFee + DEMO_PAYMENT_VSIZE);
        const extra = feeSats - oldFee;
        // The guardian counts the coins once a day: after it approved the payment, only the extra fee is new.
        const limitSats = tx.signedBy === 'phone+guardian' ? extra : tx.amountSats + feeSats;
        quotes[speed] = {
          txid,
          speed,
          address: tx.address ?? '',
          amountSats: tx.amountSats,
          oldFeeSats: oldFee,
          feeSats,
          oldFeeRate: oldFee / DEMO_PAYMENT_VSIZE,
          feeRate: feeSats / DEMO_PAYMENT_VSIZE,
          extraFeeSats: extra,
          plan: opts.signer === 'hardware' ? { signer: 'hardware', reason: 'requested' } : planSend(s, limitSats),
          limitSats,
          ...(FEE_SATS[speed] <= oldFee ? { alreadyAtRate: true as const } : {}),
        };
      }
      return { ok: true, quotes };
    },

    async send(quote) {
      const item = find(quote.txid);
      if (!item || item.tx.status !== 'pending') throw new WalletServiceError('quote_stale', 'This payment is no longer waiting. Go back and look again.');
      await h.wait(quote.plan.signer === 'hardware' ? h.deviceDelay : h.networkDelay);
      const guardian = quote.plan.signer === 'phone+guardian';
      const next: Transaction = {
        ...item.tx,
        id: h.nextId('tx'),
        txid: h.nextTxid(),
        feeSats: quote.feeSats,
        at: h.now.toISOString(),
        signedBy: guardian ? 'phone+guardian' : 'phone+hardware',
        canSpeedUp: true,
        spedUp: true,
      };
      // One row: the new version takes the old one's place.
      h.update((s) => ({
        activity: s.activity.map((a) => (a === item ? { type: 'payment' as const, at: next.at, tx: next } : a)),
        balanceSats: s.balanceSats - quote.extraFeeSats,
        ...(guardian ? { dailyLimit: { ...s.dailyLimit, usedSats: s.dailyLimit.usedSats + quote.limitSats } } : {}),
      }));
      return next;
    },
  };
}
