import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { api, ApiError, type GuardianStatus } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePageTitle } from '@/hooks/use-api';
import { shortenMiddle } from '@/lib/format';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-t py-2.5 text-[15px] leading-5 first:border-t-0">
      <dt>{label}</dt>
      <dd className="m-0 min-w-0 text-right text-muted-foreground">{children}</dd>
    </div>
  );
}

function chainValue(chain: GuardianStatus['chain']): string {
  if (chain.state === 'synced') return 'Connected';
  if (chain.state === 'syncing') return `Syncing ${Math.round((chain.progress ?? 0) * 100)}%`;
  return 'Unavailable';
}

/** Lock now, the details of this box (collapsed), and the reset in its own danger zone. */
export function SettingsPage() {
  usePageTitle('Settings');
  const navigate = useNavigate();
  const { status, error, loading, refresh, setStatus } = useGuardian();
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

  const connected = status.relays.filter((r) => r.connected).length;
  const relays = connected === status.relays.length ? `${connected} connected` : `${connected} of ${status.relays.length} connected`;

  return (
    <div className="flex flex-col gap-6 md:gap-7">
      <PageHeader title="Settings" />

      <section aria-labelledby="guardian-heading" className="flex flex-col gap-3">
        <h2 id="guardian-heading" className="m-0 text-base leading-[22px] font-semibold">
          Guardian
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button variant="outline" onClick={lockNow} disabled={locking}>
            {locking ? 'Locking…' : 'Lock now'}
          </Button>
          <p className="m-0 min-w-0 max-w-[60ch] flex-1 basis-60 text-[13px] leading-[18px] text-muted-foreground">
            Use this if you think someone has been at the box. It takes the passphrase to unlock.
          </p>
        </div>
        {lockError && <ErrorState error={new Error(lockError)} title="Couldn't lock the guardian" className="max-w-none" />}
      </section>

      <details className="group/advanced">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-base leading-[22px] font-semibold outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-4 text-muted-foreground transition-transform group-open/advanced:rotate-90"
            aria-hidden="true"
          />
          Advanced
        </summary>
        <dl className="m-0 mt-2 flex flex-col">
          <InfoRow label="Guardian ID">
            {status.npub ? (
              <span className="font-mono text-[13px]" title={status.npub}>
                {shortenMiddle(status.npub, 9, 4)}
              </span>
            ) : (
              '–'
            )}
          </InfoRow>
          <InfoRow label="Relays">{relays}</InfoRow>
          <InfoRow label={status.chain.source.replace(/\s*\+\s*/g, ' and ')}>{chainValue(status.chain)}</InfoRow>
          <InfoRow label="Version">{status.version ? `${status.version} · pre-alpha` : 'pre-alpha'}</InfoRow>
        </dl>
      </details>

      <section
        aria-labelledby="danger-heading"
        className="flex flex-col gap-3 rounded-xl border border-bad/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="danger-heading" className="m-0 text-[15px] leading-5 font-semibold">
            Reset guardian
          </h2>
          <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
            Forgets every wallet and makes a new key 3. Not possible while a recovery runs.
          </p>
        </div>
        <Button asChild variant="outline-destructive" className="w-fit shrink-0 border-bad/60">
          <Link to="/reset">Reset…</Link>
        </Button>
      </section>
    </div>
  );
}
