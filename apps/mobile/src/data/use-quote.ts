import { useEffect, useMemo, useState } from 'react';
import { useWallet, useWalletService } from './provider';
import type { QuoteOutcome, SendRequest } from './types';

/**
 * The wallet's quote for a payment, kept out of the way of typing. Planning a payment is real work (coin selection, fee,
 * the keys of every input), so the quote is made once the form has been still for `debounceMs`, and only again when
 * something the plan depends on changed: the form, the coins, the guardian's state or the limit. While the form is
 * ahead of the quote, `pending` is true and the caller should not offer to continue.
 */
export function useQuote(request: SendRequest, debounceMs = 0): { outcome: QuoteOutcome; pending: boolean } {
  const wallet = useWalletService();
  const state = useWallet();
  const [settled, setSettled] = useState(request);

  useEffect(() => {
    if (debounceMs <= 0) return;
    const id = setTimeout(() => setSettled(request), debounceMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.address, request.amountSats, request.speed, request.signer, debounceMs]);

  const current = debounceMs <= 0 ? request : settled;
  // Everything the plan depends on besides the form. (A progress text or a device prompt changing is not one of them.)
  const planKey = [
    state.balanceSats,
    state.dailyLimit.limitSats,
    state.dailyLimit.usedSats,
    state.guardian.status,
    state.phoneSpending,
    state.recovery?.id ?? '',
    state.hardware.kind,
    state.synced,
    state.mode,
  ].join('|');

  const outcome = useMemo(
    () => wallet.quoteSend({ address: current.address, amountSats: current.amountSats, speed: current.speed, ...(current.signer ? { signer: current.signer } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, planKey, current.address, current.amountSats, current.speed, current.signer],
  );
  const pending = debounceMs > 0 && (settled.address !== request.address || settled.amountSats !== request.amountSats);
  return { outcome, pending };
}
