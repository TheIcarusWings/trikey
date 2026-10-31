import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock, TriangleAlert } from 'lucide-react';
import { api, type GuardianStatus } from '@/api';
import { ActivityRow } from '@/components/activity-row';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { LIMIT_OFF_TEXT, dailySpendSummary } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Issue {
  id: string;
  /** `action`: something the person has to do. `wait`: nothing to do, but it is not working yet. */
  kind: 'action' | 'wait';
  text: ReactNode;
  link?: { to: string; label: string };
}

/** What keeps this guardian from being "all set", from the status alone. */
function issuesOf(status: GuardianStatus): Issue[] {
  const issues: Issue[] = [];
  if (status.wallets.length === 0) {
    issues.push({
      id: 'unpaired',
      kind: 'action',
      text: 'No phone is paired yet. Pair one to start guarding a wallet.',
      link: { to: '/phones', label: 'Pair a phone' },
    });
  }
  if (status.recoveryInProgress) {
    issues.push({
      id: 'recovery',
      kind: 'action',
      text: 'A recovery is in progress, and phone-only payments are paused until it ends.',
      link: { to: '/recovery', label: 'See the recovery' },
    });
  }
  if (status.hardwareConfirmRequired) {
    issues.push({
      id: 'hardware',
      kind: 'action',
      text: 'Confirm your hardware wallet in the Trikey app. This guardian now protects your recovered wallet; raising the limit and other changes that need the hardware wallet wait until it signs for the new wallet.',
    });
  }
  if (status.phoneSpending === 'paused_contested') {
    issues.push({
      id: 'contested',
      kind: 'action',
      text: 'Phone-only payments are paused because someone else cancelled a recovery. Resume them with your hardware wallet in the Trikey app.',
    });
  } else if (status.phoneSpending === 'retired') {
    issues.push({
      id: 'swept',
      kind: 'action',
      text: 'A recovery moved this wallet, so phone-only payments for it stay off.',
    });
  }
  if (status.warnings?.includes('no_alert_contacts')) {
    issues.push({
      id: 'contacts',
      kind: 'action',
      text: 'No alert contact is set. A recovery would be announced only to the paired phone, which a thief may hold. Add one in the Trikey app; it can be your own nostr app on another device.',
    });
  }
  if (status.chain.state === 'syncing') {
    const pct = status.chain.progress !== undefined ? ` (${Math.round(status.chain.progress * 100)}%)` : '';
    issues.push({ id: 'syncing', kind: 'wait', text: `The Bitcoin Node is still syncing${pct}. Payments wait until it finishes.` });
  } else if (status.chain.state === 'unavailable') {
    issues.push({
      id: 'chain',
      kind: 'wait',
      text: "The guardian can't reach the Bitcoin Node and Electrs. Payments and recoveries wait until they are back.",
    });
  }
  if (status.relays.length > 0 && status.relays.every((r) => !r.connected)) {
    issues.push({ id: 'relays', kind: 'wait', text: 'No relay is connected, so the phone cannot reach this guardian.' });
  }
  return issues;
}

function StatusCard({ status }: { status: GuardianStatus }) {
  const issues = issuesOf(status);
  const actions = issues.filter((i) => i.kind === 'action');

  if (issues.length === 0) {
    const wallet = status.wallets[0]?.name ?? 'Main';
    const { text, pct } = dailySpendSummary(status.dailySpend, wallet);
    return (
      <section aria-label="Status" className="flex flex-col gap-3.5 rounded-[14px] bg-good-soft px-5 py-5 sm:px-6 sm:py-[22px]">
        <div className="flex items-center gap-3.5">
          <Check className="size-7 shrink-0 text-good" strokeWidth={2.2} aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="m-0 text-xl leading-[26px] font-semibold">You're all set</h2>
            <p className="m-0 text-sm leading-5">{text}</p>
          </div>
        </div>
        {pct === null ? (
          // No daily limit: no bar to fill, and the owner should see what that means.
          <p className="m-0 flex items-start gap-2 rounded-[10px] bg-warn-soft px-3 py-2.5 text-sm leading-5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} aria-hidden="true" />
            <span>{LIMIT_OFF_TEXT}</span>
          </p>
        ) : (
          <div
            role="progressbar"
            aria-label="Share of the daily limit used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 overflow-hidden rounded-[3px] bg-border"
          >
            <div className="h-1.5 bg-good" style={{ width: `${pct}%` }} />
          </div>
        )}
      </section>
    );
  }

  const title =
    actions.length > 0
      ? `${actions.length} ${actions.length === 1 ? 'thing needs' : 'things need'} you`
      : 'Not ready yet';
  const Icon = actions.length > 0 ? TriangleAlert : Clock;
  return (
    <section aria-label="Status" className="flex flex-col gap-3.5 rounded-[14px] bg-warn-soft px-5 py-5 sm:px-6 sm:py-[22px]">
      <div className="flex items-start gap-3.5">
        <Icon className="mt-0.5 size-7 shrink-0 text-warn" strokeWidth={2} aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="m-0 text-xl leading-[26px] font-semibold">{title}</h2>
          {issues.length === 1 && <p className="m-0 text-sm leading-5">{issues[0]!.text}</p>}
        </div>
      </div>
      {issues.length > 1 && (
        <ul className="m-0 flex list-disc flex-col gap-2 pl-[42px] text-sm leading-5 marker:text-warn">
          {issues.map((i) => (
            <li key={i.id}>
              {i.text}
              {i.link && (
                <>
                  {' '}
                  <Link to={i.link.to} className="font-medium underline underline-offset-3">
                    {i.link.label}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {issues.length === 1 && issues[0]!.link && (
        <Button asChild className={cn('w-fit')}>
          <Link to={issues[0]!.link.to}>{issues[0]!.link.label}</Link>
        </Button>
      )}
    </section>
  );
}

export function HomePage() {
  usePageTitle('Home');
  const { status, error, loading, refresh } = useGuardian();
  const activity = useApi(() => api.listActivity({ limit: 5 }), [status?.state, status?.dailySpend.usedSats], 15_000);

  if (loading) return <PageSkeleton rows={2} />;
  if (!status) return <ErrorState error={error!} onRetry={refresh} />;

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <PageHeader title="Home" pill />

      <StatusCard status={status} />

      <section aria-labelledby="recent-heading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 id="recent-heading" className="m-0 text-base leading-[22px] font-semibold">
            Recent activity
          </h2>
          <Link to="/activity" className="flex min-h-8 items-center text-sm text-muted-foreground no-underline hover:text-foreground">
            See all
          </Link>
        </div>
        {activity.error && !activity.data ? (
          <ErrorState error={activity.error} onRetry={activity.reload} title="Couldn't load activity" className="max-w-none" />
        ) : !activity.data ? (
          <PageSkeleton rows={1} />
        ) : activity.data.length === 0 ? (
          <p className="m-0 py-2 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {activity.data.map((entry, i) => (
              // A phone has room for three; the desktop shows all five.
              <ActivityRow key={entry.id} entry={entry} className={i >= 3 ? 'max-sm:hidden' : undefined} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
