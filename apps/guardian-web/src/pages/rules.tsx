import type { ReactNode } from 'react';
import { api } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { LIMIT_OFF_TEXT, contactLockDetail, contactLockText, dailyLimitText, formatSats } from '@/lib/format';

function RuleRow({ title, value, children }: { title: string; value: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1 border-t py-3.5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[15px] leading-5 font-semibold">{title}</span>
        <span className="text-[15px] leading-5 tabular-nums">{value}</span>
      </div>
      <span className="text-[13px] leading-[18px] text-muted-foreground">{children}</span>
    </li>
  );
}

export function RulesPage() {
  usePageTitle('Rules');
  const { status } = useGuardian();
  const { data: rules, error, loading, reload } = useApi(() => api.getRules());

  const used = status?.dailySpend.usedSats;
  const contacts = rules?.contacts.filter((c) => c.kind === 'contact') ?? [];
  const phoneToo = rules?.contacts.some((c) => c.kind === 'paired-phone');

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <PageHeader title="Rules" />
      {loading ? (
        <PageSkeleton rows={2} />
      ) : !rules ? (
        error?.code === 'not_found' ? (
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            There are no rules yet: they belong to a wallet, and no phone is paired. Pair one under Phones.
          </p>
        ) : (
          <ErrorState error={error!} onRetry={reload} title="Couldn't load the rules" />
        )
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {rules.dailyLimitOff ? (
              <RuleRow title="Daily limit" value={<span className="font-semibold text-warn">{dailyLimitText(rules)}</span>}>
                {used !== undefined && <>{formatSats(used)} sats sent from the phone today. </>}
                {LIMIT_OFF_TEXT}
              </RuleRow>
            ) : (
              <RuleRow title="Daily limit" value={dailyLimitText(rules)}>
                {used !== undefined && <>{formatSats(used)} used. </>}
                Phone-only payments above it need the hardware wallet.
              </RuleRow>
            )}
            <RuleRow title="Security waiting period" value={`${rules.recoveryDelayDays} days`}>
              How long a recovery waits, sending alerts every day.
            </RuleRow>
            <RuleRow title="Alert contacts" value={contacts.length}>
              Who gets the daily recovery alerts
              {contacts.length > 0 && (
                <>
                  : {contacts.map((c) => c.name).join(', ')}
                  {phoneToo ? ', and the paired phone' : ''}
                </>
              )}
              .
            </RuleRow>
            <RuleRow title="Contacts can lock the guardian" value={contactLockText(rules)}>
              {contactLockDetail(rules)}
            </RuleRow>
            <RuleRow title="Sweep fee cap" value={`${formatSats(rules.sweepFeeCapSats)} sats`}>
              A recovery can't spend more than this on fees.
            </RuleRow>
          </ul>
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            Change these in the Trikey app. Loosening a rule needs your hardware wallet.
          </p>
        </>
      )}
    </div>
  );
}
