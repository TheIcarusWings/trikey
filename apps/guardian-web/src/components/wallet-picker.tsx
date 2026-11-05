import { useSearchParams } from 'react-router-dom';
import { useGuardian } from '@/components/guardian-provider';
import { cn } from '@/lib/utils';
import { selectedWalletId, walletChoices } from '@/lib/wallets';

/**
 * The wallet a page shows (own wallets: docs/design/multi-wallet.md), from the address's `?wallet=`. Undefined means the
 * first wallet. With one wallet there is nothing to choose.
 */
export function useSelectedWallet(): { walletId: string | undefined; requested: string | null; set: (id: string | undefined) => void } {
  const { status } = useGuardian();
  const [params, setParams] = useSearchParams();
  const requested = params.get('wallet');
  return {
    walletId: selectedWalletId(status, requested),
    requested,
    set: (id) => {
      const next = new URLSearchParams(params);
      if (id) next.set('wallet', id);
      else next.delete('wallet');
      setParams(next, { replace: true });
    },
  };
}

/** A row of the guardian's wallets above a page; nothing while it guards one. */
export function WalletPicker({ label = 'Wallet', all = false }: { label?: string; all?: boolean }) {
  const { status } = useGuardian();
  const wallets = walletChoices(status);
  const { walletId, requested, set } = useSelectedWallet();
  if (!wallets.length) return null;
  // `all` (Activity): an "All wallets" choice first, and the first wallet chosen by its id.
  const choices = all ? [{ id: '', name: 'All wallets', recoveryInProgress: false }, ...wallets] : wallets;
  const current = all ? (requested && wallets.some((w) => w.id === requested) ? requested : '') : (walletId ?? wallets[0]!.id);
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {choices.map((w, i) => {
        const on = w.id === current;
        return (
          <button
            key={w.id || 'all'}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => set(all ? w.id || undefined : i === 0 ? undefined : w.id)}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-sm leading-5 font-medium transition-colors',
              on ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground hover:bg-muted',
            )}
          >
            {w.name}
            {w.recoveryInProgress ? <span className="ml-1.5 text-warn">· recovery</span> : null}
          </button>
        );
      })}
    </div>
  );
}
