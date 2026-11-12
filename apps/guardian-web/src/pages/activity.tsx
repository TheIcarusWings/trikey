import { api, type ActivityEntry } from '@/api';
import { ActivityRow } from '@/components/activity-row';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { WalletPicker, useSelectedWallet } from '@/components/wallet-picker';
import { useGuardian } from '@/components/guardian-provider';
import { walletChoices } from '@/lib/wallets';

const WEEK_MS = 7 * 24 * 3_600_000;

function Group({ label, entries }: { label: string; entries: ActivityEntry[] }) {
  if (entries.length === 0) return null;
  const id = `group-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="m-0 text-[13px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </h2>
      <ul className="m-0 list-none p-0">
        {entries.map((e) => (
          <ActivityRow key={e.id} entry={e} />
        ))}
      </ul>
    </section>
  );
}

export function ActivityPage() {
  usePageTitle('Activity');
  // Own wallets: every wallet's entries (each names its wallet), or the chosen wallet's and the box's own.
  const { status } = useGuardian();
  const { requested } = useSelectedWallet();
  const only = requested && walletChoices(status).some((w) => w.id === requested) ? requested : undefined;
  const { data, error, loading, reload } = useApi(() => api.listActivity({ limit: 100, ...(only ? { wallet: only } : {}) }), [only], 30_000);
  const cutoff = Date.now() - WEEK_MS;

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <PageHeader title="Activity" />
      <WalletPicker label="Show the activity of" all />
      {loading ? (
        <PageSkeleton rows={2} />
      ) : !data ? (
        <ErrorState error={error!} onRetry={reload} title="Couldn't load activity" />
      ) : data.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">Nothing has happened yet.</p>
      ) : (
        <>
          <Group label="This week" entries={data.filter((e) => Date.parse(e.at) >= cutoff)} />
          <Group label="Earlier" entries={data.filter((e) => Date.parse(e.at) < cutoff)} />
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            Didn't do one of these? Lock the guardian from the Trikey app or here, under Settings. Kept on this guardian only.
          </p>
        </>
      )}
    </div>
  );
}
