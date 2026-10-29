import { useState } from 'react';
import { api, type ActivityEntry, type ActivityKind } from '@/api';
import { PageHeader } from '@/components/page-header';
import { ResultBadge } from '@/components/result-badge';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { formatSats, formatWhen } from '@/lib/format';

type Filter = 'all' | 'payments' | 'recoveries' | 'system';

const FILTERS: { value: Filter; label: string; kinds: ActivityKind[] | null; empty: string }[] = [
  { value: 'all', label: 'All', kinds: null, empty: 'Nothing has happened yet.' },
  { value: 'payments', label: 'Payments', kinds: ['payment'], empty: 'No payments yet.' },
  { value: 'recoveries', label: 'Recoveries', kinds: ['recovery'], empty: 'No recoveries, which is how it should be.' },
  { value: 'system', label: 'Rules and system', kinds: ['rules', 'system'], empty: 'No rule changes or system events yet.' },
];

function ActivityTable({ entries, empty }: { entries: ActivityEntry[]; empty: string }) {
  if (entries.length === 0) {
    return <p className="rounded-xl border px-4 py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table className="min-w-[640px]">
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Signed by</TableHead>
            <TableHead className="text-right">Sats</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatWhen(e.at)}</TableCell>
              <TableCell>{e.event}</TableCell>
              <TableCell>{e.signedBy ?? <span className="text-muted-foreground">–</span>}</TableCell>
              <TableCell className="text-right tabular-nums">
                {e.sats === null ? <span className="text-muted-foreground">–</span> : formatSats(e.sats)}
              </TableCell>
              <TableCell>
                <ResultBadge result={e.result} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ActivityPage() {
  usePageTitle('Activity');
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error, loading, reload } = useApi(() => api.listActivity({ limit: 100 }), [], 30_000);

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <PageHeader title="Activity" description="Everything the guardian signed, refused or changed. Kept on this box only." />
      {loading ? (
        <PageSkeleton rows={2} />
      ) : !data ? (
        <ErrorState error={error!} onRetry={reload} title="Couldn't load activity" />
      ) : (
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="gap-5">
          <TabsList aria-label="Filter activity">
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {FILTERS.map((f) => (
            <TabsContent key={f.value} value={f.value}>
              <ActivityTable entries={f.kinds ? data.filter((e) => f.kinds!.includes(e.kind)) : data} empty={f.empty} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
