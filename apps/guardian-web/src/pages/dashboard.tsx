import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clock, KeyRound } from 'lucide-react';
import { api, ApiError } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { ResultBadge } from '@/components/result-badge';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { formatSats, formatShortWhen } from '@/lib/format';

function Stat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <Card className="gap-1.5 px-5 py-4">
      <span className="text-[13px] leading-[18px] text-muted-foreground">{label}</span>
      <span className="text-[22px] leading-7 font-semibold tabular-nums">{value}</span>
      {children}
    </Card>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="text-[13px] leading-[18px] text-muted-foreground">{children}</span>;
}

export function DashboardPage() {
  usePageTitle('Dashboard');
  const navigate = useNavigate();
  const { status, error, loading, refresh, setStatus } = useGuardian();
  const activity = useApi(() => api.listActivity({ limit: 5 }), [status?.state], 15_000);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string>();

  const lockNow = async () => {
    setLocking(true);
    setLockError(undefined);
    try {
      setStatus(await api.lock());
      navigate('/locked');
    } catch (e) {
      setLockError(e instanceof ApiError ? e.message : 'Could not lock the guardian.');
      setLocking(false);
    }
  };

  if (loading) return <PageSkeleton rows={3} />;
  if (!status) return <ErrorState error={error!} onRetry={refresh} />;

  const { dailySpend, relays, chain, wallets } = status;
  const pct = dailySpend.limitSats > 0 ? Math.min(100, Math.round((dailySpend.usedSats / dailySpend.limitSats) * 100)) : 0;
  const connected = relays.filter((r) => r.connected).length;
  const phones = wallets.reduce((n, w) => n + w.phonesPaired, 0);
  const retired = status.retiredWallets?.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">Dashboard</h1>
        <Badge variant="success">Unlocked</Badge>
        <span className="grow" />
        <Button variant="outline" onClick={lockNow} disabled={locking}>
          {locking ? 'Locking…' : 'Lock now'}
        </Button>
      </div>

      {lockError && (
        <ErrorState error={new Error(lockError)} title="Couldn't lock the guardian" className="max-w-none" />
      )}

      {status.warnings?.includes('no_alert_contacts') && (
        <Alert variant="warning" className="max-w-none">
          <AlertTitle>No alert contact</AlertTitle>
          <AlertDescription>
            A recovery would be announced only to the paired phone, which a thief may hold. Add an alert contact in the app; it can be
            your own nostr app on another device.
          </AlertDescription>
        </Alert>
      )}

      {status.recoveryInProgress && (
        <Alert variant="warning" className="max-w-none">
          <Clock aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>A recovery is in progress</AlertTitle>
            <AlertDescription>
              Phone-only payments are paused.{' '}
              <Link to="/recovery" className="font-medium underline underline-offset-3">
                See the details
              </Link>
              .
            </AlertDescription>
          </div>
        </Alert>
      )}

      {status.hardwareConfirmRequired && (
        <Alert variant="warning" className="max-w-none">
          <KeyRound aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>Confirm your hardware wallet in the Trikey app</AlertTitle>
            <AlertDescription>
              This guardian now protects your recovered wallet. Phone payments within the limit work; raising the limit and other
              changes that need the hardware wallet wait until it signs for the new wallet.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <section aria-label="Status" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Stat
          label="Phone-only today"
          value={
            <>
              {formatSats(dailySpend.usedSats)}{' '}
              <span className="text-[13px] font-normal text-muted-foreground">of {formatSats(dailySpend.limitSats)} sats</span>
            </>
          }
        >
          <div
            role="progressbar"
            aria-label="Share of the daily limit used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 overflow-hidden rounded-[3px] bg-muted"
          >
            <div className="h-1.5 rounded-[3px] bg-foreground" style={{ width: `${pct}%` }} />
          </div>
        </Stat>
        <Stat label="Wallets" value={wallets.length}>
          <Sub>
            {phones} {phones === 1 ? 'phone' : 'phones'} paired
            {retired > 0 && ` · ${retired} retired`}
          </Sub>
        </Stat>
        <Stat label="Relays" value={`${connected} of ${relays.length}`}>
          <Sub>connected</Sub>
        </Stat>
        <Stat
          label="Chain data"
          value={chain.state === 'synced' ? 'Synced' : chain.state === 'syncing' ? `Syncing ${Math.round((chain.progress ?? 0) * 100)}%` : 'Unavailable'}
        >
          <Sub>{chain.source}</Sub>
        </Stat>
      </section>

      <Card>
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-base leading-6 font-semibold">Recent activity</h2>
          <Link to="/activity" className="text-sm underline underline-offset-3 hover:text-muted-foreground">
            View all
          </Link>
        </div>
        {activity.error && !activity.data ? (
          <div className="px-5 pb-4">
            <ErrorState error={activity.error} onRetry={activity.reload} title="Couldn't load activity" className="max-w-none" />
          </div>
        ) : !activity.data ? (
          <div className="px-5 pb-4">
            <PageSkeleton rows={1} />
          </div>
        ) : activity.data.length === 0 ? (
          <p className="border-t px-5 py-6 text-sm text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead className="border-t px-5">Time</TableHead>
                <TableHead className="border-t px-5">Event</TableHead>
                <TableHead className="border-t px-5 text-right">Amount</TableHead>
                <TableHead className="border-t px-5">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.data.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="px-5 whitespace-nowrap text-muted-foreground">{formatShortWhen(entry.at)}</TableCell>
                  <TableCell className="px-5">{entry.summary ?? entry.event}</TableCell>
                  <TableCell className="px-5 text-right tabular-nums">
                    {entry.sats === null ? <span className="text-muted-foreground">–</span> : formatSats(entry.sats)}
                  </TableCell>
                  <TableCell className="px-5">
                    <ResultBadge result={entry.result} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <section aria-labelledby="box-heading" className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        <h2 id="box-heading" className="sr-only">
          This box
        </h2>
        <Card className="gap-2 px-5 py-4">
          <span className="text-sm leading-5 font-semibold">Lost your phone and its backup?</span>
          <Sub>A new phone can recover the wallet with your hardware wallet and this guardian's recovery code.</Sub>
          <Link to="/recover-phone" className="text-sm underline underline-offset-3 hover:text-muted-foreground">
            Show the recovery code
          </Link>
        </Card>
        <Card className="gap-2 px-5 py-4">
          <span className="text-sm leading-5 font-semibold">Reset this guardian</span>
          <Sub>Forget the wallet and create a new key 3, for example before pairing a different wallet.</Sub>
          <Link to="/reset" className="text-sm text-bad underline underline-offset-3 hover:text-muted-foreground">
            Reset guardian
          </Link>
        </Card>
      </section>
    </div>
  );
}
