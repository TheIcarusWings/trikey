import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type PairingSession } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { QrCode } from '@/components/qr-code';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi, useNow, usePageTitle } from '@/hooks/use-api';
import { formatCountdown, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const POLL_MS = 2000;

function PairedPhones({ reloadKey }: { reloadKey: unknown }) {
  const { data, error, reload } = useApi(() => api.listPairedPhones(), [reloadKey]);
  return (
    <section aria-labelledby="paired-heading" className="flex max-w-[720px] flex-col gap-2">
      <h2 id="paired-heading" className="text-sm leading-5 font-semibold">
        Paired phones
      </h2>
      {error && !data ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load paired phones" className="max-w-none" />
      ) : !data ? (
        <Skeleton className="h-5 w-24" />
      ) : data.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col rounded-xl border p-0">
          {data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-[13px] text-muted-foreground">Paired {formatDate(p.pairedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PairPage() {
  usePageTitle('Pair a phone');
  const { refresh } = useGuardian();
  const [session, setSession] = useState<PairingSession>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [phonesKey, setPhonesKey] = useState(0);
  const now = useNow(1000);
  const started = useRef(false);

  const newCode = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setSession(await api.startPairing());
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('internal', 'Could not create a pairing code.'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void newCode();
  }, [newCode]);

  // Watch for the phone to scan the code.
  const sessionId = session?.id;
  const waiting = session?.status === 'waiting';
  useEffect(() => {
    if (!sessionId || !waiting) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      api.getPairingSession(sessionId).then(
        (next) => {
          if (stopped) return;
          setSession((cur) => (cur && cur.id === next.id ? next : cur));
          if (next.status === 'paired') {
            setPhonesKey((k) => k + 1);
            refresh();
          }
        },
        () => {
          /* a failed poll is retried on the next tick */
        },
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [sessionId, waiting, refresh]);

  const remainingMs = session ? Date.parse(session.expiresAt) - now : 0;
  const expired = session ? session.status === 'expired' || (session.status === 'waiting' && remainingMs <= 0) : false;
  const paired = session?.status === 'paired';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pair a phone"
        description="In the Trikey app, choose Pair your guardian and scan this code. It works once."
      />

      <Card className="max-w-[720px] flex-row flex-wrap items-center gap-8 p-6">
        <div className="size-[232px] max-w-full shrink-0 rounded-xl border bg-white p-4">
          {session && !error ? (
            <div className={cn('transition-opacity', (expired || paired) && 'opacity-20')}>
              <QrCode value={session.uri} size={198} label="Pairing QR code" />
            </div>
          ) : (
            <Skeleton className="size-[198px] max-w-full" />
          )}
        </div>
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <ol className="m-0 flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-5">
            <li>Open Trikey on your phone.</li>
            <li>Choose Create a wallet, then Pair your guardian.</li>
            <li>Scan this code. The phone and guardian connect over encrypted nostr relays.</li>
          </ol>

          <div role="status" className="flex items-center gap-2.5 text-sm leading-5 text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn('size-2 shrink-0 rounded-full', paired ? 'bg-good' : expired ? 'bg-bad' : 'bg-warn')}
            />
            {paired
              ? 'Phone paired'
              : expired
                ? 'This code expired. Make a new one.'
                : session
                  ? `Waiting for a phone · expires in ${formatCountdown(remainingMs)}`
                  : 'Making a code…'}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {paired ? (
              <Button asChild>
                <Link to="/">Done</Link>
              </Button>
            ) : (
              <>
                <Button variant={expired ? 'default' : 'outline'} onClick={newCode} disabled={busy}>
                  New code
                </Button>
                <Button asChild variant="link">
                  <Link to="/">Skip for now</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {error && <ErrorState error={error} onRetry={newCode} title="Couldn't make a pairing code" className="max-w-[720px]" />}

      <PairedPhones reloadKey={phonesKey} />
    </div>
  );
}
