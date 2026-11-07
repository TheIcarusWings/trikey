import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { api, ApiError, REMOVE_WALLET_CONFIRMATION, type OwnWalletSecurity } from '@/api';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { REMOVE_BLOCKED_BY_RECOVERY, REMOVE_WALLET_CONSEQUENCES, UNLOCK_OFF_TEXT } from '@/lib/own-wallets';

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'That did not work. Try again.';
}

/**
 * Settings > Wallets and hardware unlock: every wallet of this guardian, which of them can unlock it with their hardware
 * wallet, and a running recovery. The owner can turn hardware unlock off for any wallet, and remove a wallet after the
 * first without its hardware wallet (typed confirmation), never while it is being recovered: a wallet they no longer want
 * guarded, or one they did not add.
 */
export function OwnWalletsPage() {
  usePageTitle('Wallets and hardware unlock');
  const { data, error, loading, reload } = useApi(() => api.getOwnWallets(), []);
  const [view, setView] = useState<typeof data>();
  const shown = view ?? data;
  const [removing, setRemoving] = useState<OwnWalletSecurity>();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const act = async (fn: () => Promise<NonNullable<typeof data>>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      setView(await fn());
      setRemoving(undefined);
      setConfirm('');
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-[640px] flex-col gap-5 md:gap-6">
      <PageHeader title="Wallets and hardware unlock" />
      <p className="m-0 text-sm leading-5 text-muted-foreground">
        Every wallet this guardian guards, and which can unlock it with their hardware wallet. Adding a wallet needs your first wallet's
        hardware wallet. If you see a wallet or a hardware unlock you did not add, turn the unlock off and remove the wallet here.
      </p>
      {loading && !shown ? (
        <PageSkeleton rows={2} />
      ) : !shown ? (
        <ErrorState error={error!} onRetry={reload} title="Couldn't load the wallets" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Wallets">
          {shown.wallets.map((w) => (
            <li key={w.walletId} className="flex flex-col gap-2 rounded-xl border px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[15px] leading-5 font-semibold">{w.name}</span>
                <span className="font-mono text-[13px] text-muted-foreground">{w.walletId}</span>
              </div>
              <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
                {w.first ? 'The first wallet: it holds the pairing.' : `Account ${w.account}${w.addedAt ? `, added ${formatDateTime(w.addedAt)}` : ''}.`} Hardware wallet{' '}
                <span className="font-mono">{w.hardwareFingerprint}</span>.
              </p>
              {w.recovery && (
                <p role="status" className="m-0 flex items-start gap-2 text-[13px] leading-[18px]">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />A recovery of this wallet is running ({w.recovery.id}), ready{' '}
                  {formatDateTime(w.recovery.readyAt)}.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {w.unlockSlot ? (
                  <>
                    <span className="text-[13px] leading-[18px]">Hardware unlock is on (since {formatDateTime(w.unlockSlot.addedAt)}).</span>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => api.removeUnlockSlot(w.walletId))}>
                      Turn hardware unlock off
                    </Button>
                  </>
                ) : (
                  <span className="text-[13px] leading-[18px] text-muted-foreground">Hardware unlock is off.</span>
                )}
                {!w.first && !w.recovery && (
                  <Button variant="outline-destructive" size="sm" disabled={busy} onClick={() => setRemoving(w)}>
                    Remove…
                  </Button>
                )}
              </div>
              {!w.first && w.recovery && <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">{REMOVE_BLOCKED_BY_RECOVERY(w)}</p>}
              {removing?.walletId === w.walletId && (
                <form
                  className="flex flex-col gap-2 rounded-lg bg-warn-soft px-3 py-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (confirm === REMOVE_WALLET_CONFIRMATION) void act(() => api.removeOwnWallet(w.walletId, { confirm }));
                  }}
                >
                  <p className="m-0 text-[13px] leading-[18px]">{REMOVE_WALLET_CONSEQUENCES(w)}</p>
                  <Label htmlFor={`remove-${w.walletId}`}>
                    Type <span className="font-mono">{REMOVE_WALLET_CONFIRMATION}</span> to remove "{w.name}"
                  </Label>
                  <Input id={`remove-${w.walletId}`} autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} className="h-10" />
                  <div className="flex gap-2">
                    <Button type="submit" variant="destructive" size="sm" disabled={busy || confirm !== REMOVE_WALLET_CONFIRMATION}>
                      {busy ? 'Removing…' : 'Remove wallet'}
                    </Button>
                    <Button type="button" variant="link" size="sm" onClick={() => setRemoving(undefined)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
          {problem}
        </p>
      )}
      <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
        {UNLOCK_OFF_TEXT} The first wallet is not removed here: <Link to="/reset">Reset</Link> forgets every wallet.
      </p>
    </div>
  );
}
