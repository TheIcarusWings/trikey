import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Smartphone, TriangleAlert } from 'lucide-react';
import { api, type RecoveryInProgress } from '@/api';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useApi, useNow, usePageTitle } from '@/hooks/use-api';
import { cn } from '@/lib/utils';
import { formatDateAt, formatDateTime, formatDayList, formatRemaining, formatSats } from '@/lib/format';

function Row({ label, children, stacked }: { label: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn('flex gap-x-3 gap-y-1 border-t px-5 py-2.5 text-sm leading-5', stacked ? 'flex-col' : 'justify-between')}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 min-w-0', !stacked && 'text-right')}>{children}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="px-5 pt-4 pb-2 text-[15px] leading-[22px] font-semibold">{children}</h2>;
}

function Details({ recovery }: { recovery: RecoveryInProgress }) {
  const overCap = recovery.feeSats > recovery.feeCapSats;
  return (
    <div className="grid max-w-[760px] grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
      <Card className="pb-2">
        <SectionTitle>Request</SectionTitle>
        <dl className="m-0 flex flex-col">
          <Row label="Started">{formatDateTime(recovery.startedAt)}</Row>
          <Row label="Key said to be lost">{recovery.lostKey === 'phone' ? 'Phone' : 'Hardware wallet'}</Row>
          <Row label="Signed with">
            {recovery.survivingKey.device} · {recovery.survivingKey.signatureValid ? 'valid' : <span className="text-bad">not valid</span>}
          </Row>
          <Row label="Moves">
            <span className="tabular-nums">{formatSats(recovery.sweepSats)} sats</span>
          </Row>
          <Row label="Fee">
            <span className="tabular-nums">{formatSats(recovery.feeSats)} sats</span> ·{' '}
            {overCap ? <span className="text-bad">over the cap</span> : 'under the cap'}
          </Row>
          <Row label="Destination" stacked>
            <span className="font-mono text-[13px] break-all">{recovery.destination}</span>
          </Row>
        </dl>
      </Card>
      <Card className="pb-2">
        <SectionTitle>Alerts sent</SectionTitle>
        <ul className="m-0 flex list-none flex-col p-0">
          {recovery.alertsSent.map((a) => (
            <li key={a.recipient} className="flex justify-between gap-3 border-t px-5 py-2.5 text-sm leading-5">
              <span>{a.recipient}</span>
              <span className="text-muted-foreground">{a.sentAt.length ? formatDayList(a.sentAt) : 'Not yet'}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function RecoveryPage() {
  usePageTitle('Recovery');
  const { data: recovery, error, loading, reload } = useApi(() => api.getRecovery(), [], 30_000);
  const now = useNow(30_000);

  if (loading) return <PageSkeleton rows={2} />;
  if (error && recovery === undefined) return <ErrorState error={error} onRetry={reload} title="Couldn't load the recovery" />;

  if (!recovery) {
    return (
      <div className="flex max-w-[760px] flex-col gap-4">
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">Recovery</h1>
        <Card className="items-start gap-3 px-5 py-6">
          <p className="m-0 text-sm text-muted-foreground">No recovery is in progress.</p>
          <Button asChild variant="outline">
            <Link to="/">Back to the dashboard</Link>
          </Button>
        </Card>
      </div>
    );
  }

  const remainingMs = Date.parse(recovery.endsAt) - now;
  const done = recovery.state === 'ready' || remainingMs <= 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Recovery</h1>
      <Alert variant="warning" className="max-w-[760px] border-border">
        <TriangleAlert aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <AlertTitle>
            {done ? 'Recovery waiting period is over' : `Recovery in progress · ${formatRemaining(remainingMs)} left`}
          </AlertTitle>
          <AlertDescription>
            {done
              ? (recovery.waitingFor ?? 'The guardian is about to co-sign the move and broadcast it.')
              : `Phone-only payments are paused. If nobody cancels, this guardian co-signs the move on ${formatDateAt(recovery.endsAt)}.`}
          </AlertDescription>
        </div>
      </Alert>

      <Details recovery={recovery} />

      <div className="flex max-w-[760px] items-start gap-3 rounded-xl border px-4 py-3.5">
        <Smartphone className="mt-px size-[18px] shrink-0" aria-hidden="true" />
        <p className="m-0 text-sm leading-5">
          Didn't start this? Cancel it in the Trikey app, or reply{' '}
          <span className="font-mono text-[13px]">CANCEL {recovery.id}</span> to the alert message in your nostr app. Your
          alert contacts can do the same. The guardian records who cancelled, so cancels come from your phone, your contacts
          or your hardware wallet, not from this page.
        </p>
      </div>
    </div>
  );
}
