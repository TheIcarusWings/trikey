import type { ReactNode } from 'react';
import { Smartphone } from 'lucide-react';
import { api } from '@/api';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Card } from '@/components/ui/card';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { formatSats } from '@/lib/format';

function RuleRow({ title, hint, value }: { title: string; hint: string; value: ReactNode }) {
  return (
    <li className="flex flex-wrap justify-between gap-x-6 gap-y-2 border-b px-5 py-4 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">{hint}</span>
      </div>
      <div className="text-sm font-semibold">{value}</div>
    </li>
  );
}

export function RulesPage() {
  usePageTitle('Rules');
  const { data: rules, error, loading, reload } = useApi(() => api.getRules());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Rules" description={`What this guardian will and won't co-sign for the ${rules?.walletName ?? 'Main'} wallet.`} />
      {loading ? (
        <PageSkeleton rows={2} />
      ) : !rules ? (
        <ErrorState error={error!} onRetry={reload} title="Couldn't load the rules" />
      ) : (
        <>
          <Card className="max-w-[720px]">
            <ul className="m-0 flex list-none flex-col p-0">
              <RuleRow
                title="Daily limit"
                hint="Phone-only payments in any 24 hours, fees included"
                value={<span className="tabular-nums">{formatSats(rules.dailyLimitSats)} sats</span>}
              />
              <RuleRow
                title="Recovery waiting period"
                hint="How long a lost-device recovery waits, with daily alerts"
                value={`${rules.recoveryDelayDays} days`}
              />
              <RuleRow
                title="Who gets alerts and can cancel"
                hint={rules.contacts.map((c) => c.name).join(', ')}
                value={rules.contacts.length}
              />
              <RuleRow
                title="Recovery fee cap"
                hint="A recovery can't spend more than this on fees"
                value={`${rules.recoveryFeeCapPercent}% of the wallet`}
              />
              <RuleRow
                title="Hardware wallet payments"
                hint="Phone + hardware don't need this guardian"
                value="Any amount"
              />
            </ul>
          </Card>
          <div className="flex max-w-[720px] items-start gap-3 rounded-xl border px-4 py-3.5">
            <Smartphone className="mt-px size-[18px] shrink-0" aria-hidden="true" />
            <p className="m-0 text-sm leading-5">
              Change rules from the Trikey app. The guardian only accepts changes that loosen a rule when they're signed by your
              hardware wallet, so nothing on this page can be edited here.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
