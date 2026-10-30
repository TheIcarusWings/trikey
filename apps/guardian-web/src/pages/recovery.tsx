import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Clock, Lock } from 'lucide-react';
import { api, type RecoveryInProgress } from '@/api';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useApi, useNow, usePageTitle } from '@/hooks/use-api';
import { formatCountdownLong, formatDateAt, formatDateTime, formatDayList, formatSats } from '@/lib/format';
import { cn } from '@/lib/utils';

function Fact({ Icon, title, children }: { Icon: typeof Lock; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted">
        <Icon className="size-[18px]" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] leading-5 font-semibold">{title}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/** Who is told, from the recipients the guardian has alerted: the paired phone, then alert contacts. */
function alertsText(recovery: RecoveryInProgress): string {
  const recipients = recovery.alertsSent.map((a) => a.recipient);
  const phone = recipients.some((r) => /phone/i.test(r));
  const contacts = recipients.length - (phone ? 1 : 0);
  const contactText = `${contacts} alert ${contacts === 1 ? 'contact' : 'contacts'}`;
  if (phone && contacts > 0) return `To the phone and ${contactText}.`;
  if (phone) return 'To the phone.';
  return contacts > 0 ? `To ${contactText}.` : 'To everyone who gets alerts.';
}

function startedBy(recovery: RecoveryInProgress): string {
  // The key that survived is the one that asked for it.
  return recovery.lostKey === 'phone' ? 'By the hardware wallet, for a new phone.' : 'By the phone, for a new hardware wallet.';
}

function Row({ label, children, stacked }: { label: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn('flex gap-x-3 gap-y-1 border-t py-2.5 text-sm leading-5 first:border-t-0', stacked ? 'flex-col' : 'justify-between')}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 min-w-0', !stacked && 'text-right')}>{children}</dd>
    </div>
  );
}

function Details({ recovery }: { recovery: RecoveryInProgress }) {
  const overCap = recovery.feeSats > recovery.feeCapSats;
  return (
    <details className="group">
      <summary className="w-fit cursor-pointer rounded-sm text-sm leading-5 text-muted-foreground underline underline-offset-3 outline-none marker:content-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        Details: signed with, amount, fee, destination
      </summary>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-10 gap-y-6">
        <section aria-labelledby="request-heading">
          <h2 id="request-heading" className="m-0 pb-2 text-[15px] leading-[22px] font-semibold">
            Request
          </h2>
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
        </section>
        <section aria-labelledby="alerts-heading">
          <h2 id="alerts-heading" className="m-0 pb-2 text-[15px] leading-[22px] font-semibold">
            Alerts sent
          </h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {recovery.alertsSent.map((a) => (
              <li key={a.recipient} className="flex justify-between gap-3 border-t py-2.5 text-sm leading-5 first:border-t-0">
                <span>{a.recipient}</span>
                <span className="text-muted-foreground">{a.sentAt.length ? formatDayList(a.sentAt) : 'Not yet'}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </details>
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
      <div className="flex flex-col gap-5 md:gap-6">
        <PageHeader title="Recovery" pill />
        <p className="m-0 text-sm text-muted-foreground">No recovery is in progress.</p>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/">Back to Home</Link>
        </Button>
      </div>
    );
  }

  const remainingMs = Date.parse(recovery.endsAt) - now;
  const done = recovery.state === 'ready' || remainingMs <= 0;
  const waitDays = Math.max(1, Math.round((Date.parse(recovery.endsAt) - Date.parse(recovery.startedAt)) / 86_400_000));

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <PageHeader title="Recovery in progress" pill />

      <section aria-label="Countdown" className="flex flex-col gap-1">
        <p className="m-0 text-sm leading-5 text-muted-foreground">
          {done
            ? (recovery.waitingFor ?? 'The security waiting period is over. The guardian is about to co-sign the move and broadcast it.')
            : `Money moves to the new wallet on ${formatDateAt(recovery.endsAt)}, unless someone cancels`}
        </p>
        <p
          className={cn(
            'm-0 font-semibold tracking-[-0.03em] tabular-nums',
            // Size and line height together: tailwind-merge drops a separate leading-* when a text-[size] follows it.
            done ? 'text-[32px]/[1.1] sm:text-[40px]/[1.1]' : 'text-[44px]/[1.05] sm:text-[56px]/[1.05]',
          )}
        >
          {done ? 'Waiting period over' : <time dateTime={recovery.endsAt}>{formatCountdownLong(remainingMs)}</time>}
        </p>
        {!done && <p className="m-0 text-sm leading-5 text-muted-foreground">left in the {waitDays}-day security waiting period</p>}
      </section>

      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-6 gap-y-4 p-0">
        <Fact Icon={Lock} title="Phone-only payments paused">
          Until the recovery ends.
        </Fact>
        <Fact Icon={Bell} title="Alerts go out daily">
          {alertsText(recovery)}
        </Fact>
        <Fact Icon={Clock} title={`Started ${formatDateAt(recovery.startedAt)}`}>
          {startedBy(recovery)}
        </Fact>
      </ul>

      <section aria-labelledby="cancel-heading" className="flex flex-col gap-3 rounded-[14px] border border-foreground px-5 py-[18px]">
        <h2 id="cancel-heading" className="m-0 text-[17px] leading-6 font-semibold">
          Didn't start this? Cancel it from one of these
        </h2>
        <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[15px] leading-[22px]">
          <li>The Trikey app on your phone: Home shows the recovery with Cancel.</li>
          <li>
            An alert contact: reply to an alert with <span className="font-mono text-[13px] whitespace-nowrap">CANCEL {recovery.id}</span>.
          </li>
          <li>Your hardware wallet, from the Trikey app.</li>
        </ol>
        <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
          This page can't cancel: a web page on your home server isn't one of the keys.
        </p>
      </section>

      <Details recovery={recovery} />
    </div>
  );
}
