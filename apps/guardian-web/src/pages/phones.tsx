import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api, ApiError, type PairingSession, type RecoveryCode } from '@/api';
import { CopyButton } from '@/components/copy-button';
import { useGuardian } from '@/components/guardian-provider';
import { networkName } from '@/components/network-pill';
import { PageHeader } from '@/components/page-header';
import { QrCode } from '@/components/qr-code';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi, useNow, usePageTitle, type ApiState } from '@/hooks/use-api';
import { formatCountdown, formatDate, formatDateYear } from '@/lib/format';
import { cn } from '@/lib/utils';

const POLL_MS = 2000;

/** The one-time pairing code: a QR code that expires after 5 minutes and works once. */
function PairCode({ onPaired }: { onPaired: () => void }) {
  const [session, setSession] = useState<PairingSession>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
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
          if (next.status === 'paired') onPaired();
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
  }, [sessionId, waiting, onPaired]);

  const remainingMs = session ? Date.parse(session.expiresAt) - now : 0;
  const expired = session ? session.status === 'expired' || (session.status === 'waiting' && remainingMs <= 0) : false;
  const paired = session?.status === 'paired';

  if (error && !session) {
    return <ErrorState error={error} onRetry={newCode} title="Couldn't make a pairing code" className="max-w-none" />;
  }

  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
      <div className="flex shrink-0 flex-col items-center gap-2.5 sm:w-[232px]">
        <div className="size-[232px] max-w-full rounded-2xl bg-white p-4">
          {session ? (
            <div className={cn('transition-opacity', (expired || paired) && 'opacity-20')}>
              <QrCode value={session.uri} size={200} label="Pairing QR code" />
            </div>
          ) : (
            <Skeleton className="size-[200px] max-w-full bg-zinc-200" />
          )}
        </div>
        {paired ? (
          <p className="m-0 text-sm leading-5 font-semibold text-good">Phone paired</p>
        ) : expired ? (
          <p className="m-0 text-sm leading-5 text-muted-foreground">This code expired.</p>
        ) : (
          <p className="m-0 text-sm leading-5 text-muted-foreground tabular-nums">
            {session ? `Code expires in ${formatCountdown(remainingMs)}` : 'Making a code…'}
          </p>
        )}
        {paired ? (
          <Button asChild size="sm">
            <Link to="/">Done</Link>
          </Button>
        ) : (
          <Button
            variant={expired ? 'default' : 'ghost'}
            size="sm"
            onClick={newCode}
            disabled={busy}
            className={cn(!expired && 'font-semibold underline underline-offset-4')}
          >
            New code
          </Button>
        )}
        {/* Announces the changes only, not every tick of the countdown. */}
        <span role="status" className="sr-only">
          {paired ? 'Phone paired' : expired ? 'This code expired. Make a new one.' : ''}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[18px]">
        <ol className="m-0 flex list-decimal flex-col gap-2.5 pl-5 text-[15px] leading-[21px]">
          <li>Open the Trikey app and start setting up a wallet.</li>
          <li>At "Pair your guardian", point the phone at this code.</li>
          <li>Approve on your hardware wallet when the app asks.</li>
        </ol>
        <p className="m-0 text-sm leading-5 text-muted-foreground">
          The phone talks to this guardian over encrypted messages. It doesn't need to be on your Wi-Fi, and nothing on your network is
          opened.
        </p>
        {error && <ErrorState error={error} onRetry={newCode} title="Couldn't make a new code" className="max-w-none" />}
      </div>
    </div>
  );
}

function PairedPhones({ reloadKey }: { reloadKey: unknown }) {
  const { data, error, reload } = useApi(() => api.listPairedPhones(), [reloadKey]);
  if (error && !data) return <ErrorState error={error} onRetry={reload} title="Couldn't load paired phones" className="max-w-none" />;
  if (!data || data.length === 0) return null;
  return (
    <section aria-labelledby="paired-heading" className="flex flex-col gap-1">
      <h2 id="paired-heading" className="m-0 text-base leading-[22px] font-semibold">
        Paired phone{data.length === 1 ? '' : 's'}
      </h2>
      <ul className="m-0 list-none p-0">
        {data.map((p) => (
          <li key={p.id} className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t py-2 first:border-t-0">
            <span className="text-[15px] leading-5">{p.name}</span>
            <span className="text-[13px] text-muted-foreground">Paired {formatDate(p.pairedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The "Recover on a new phone" sheet. Hidden on screen, it is the only thing `window.print()` shows:
 * the code holds no secret (where to find this guardian, nothing else), so it is safe to print and
 * keep with the hardware wallet. The colors are fixed so a dark theme still prints black on white.
 */
function PrintSheet({ code }: { code: RecoveryCode }) {
  const rules = useApi(() => api.getRules());
  const printed = useMemo(() => formatDateYear(new Date()), []);
  const wait = rules.data ? `${rules.data.recoveryDelayDays} days` : 'the security waiting period';
  return (
    <section className="print-sheet" aria-label="Recover on a new phone, printable sheet">
      <div className="print-sheet-top">
        <span className="print-sheet-brand">Trikey Guardian</span>
        <span className="print-sheet-meta">
          Printed {printed} · {networkName(code.network)}
        </span>
      </div>
      <h2 className="print-sheet-title">Recover on a new phone</h2>
      <div className="print-sheet-qr">
        <QrCode value={code.uri} size={340} label="Recover on a new phone QR code" />
      </div>
      <ul className="print-sheet-notes">
        <li>If you lose your phone and its backup, the Trikey app on a new phone scans this to find your guardian.</li>
        <li>
          This sheet holds no secret. Your hardware wallet is what lets a new phone in, and a recovery still waits {wait}.
        </li>
        <li>Keep it with your hardware wallet.</li>
      </ul>
    </section>
  );
}

function RecoverOnNewPhone({ code }: { code: ApiState<RecoveryCode> }) {
  if (code.loading && !code.data) return <Skeleton className="h-24 w-full" />;
  if (code.error && !code.data) {
    if (code.error.code === 'not_found') {
      return (
        <section aria-labelledby="recover-heading" className="flex flex-col gap-1.5">
          <h2 id="recover-heading" className="m-0 text-base leading-[22px] font-semibold">
            Recover on a new phone
          </h2>
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            Once a phone is paired, you can print a sheet here that lets a new phone find this guardian if the old phone and its backup
            are lost.
          </p>
        </section>
      );
    }
    return <ErrorState error={code.error} onRetry={code.reload} title="Couldn't load the recovery code" className="max-w-none" />;
  }
  const c = code.data!;
  return (
    <section aria-labelledby="recover-heading" className="flex flex-col gap-3 border-t pt-6">
      <div className="flex flex-col gap-1.5">
        <h2 id="recover-heading" className="m-0 text-base leading-[22px] font-semibold">
          Recover on a new phone
        </h2>
        <p className="m-0 max-w-[60ch] text-sm leading-5 text-muted-foreground">
          Lost your phone and its backup? Print this sheet and keep it with your hardware wallet. The Trikey app on a new phone scans it to
          find this guardian, and your hardware wallet approves. It holds no secret.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          Print the sheet
        </Button>
        <CopyButton value={c.uri} label="Copy code" />
      </div>
      <details>
        <summary className="w-fit cursor-pointer rounded-sm text-sm leading-5 text-muted-foreground underline underline-offset-3 outline-none marker:content-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          What the code contains
        </summary>
        <dl className="mt-3 mb-0 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
            <dt>Guardian</dt>
            <dd className="m-0 min-w-0 font-mono text-[13px] break-all text-muted-foreground">{c.npub}</dd>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-t py-2.5 text-sm">
            <dt>Relays</dt>
            <dd className="m-0 flex min-w-0 flex-col gap-0.5 font-mono text-[13px] break-all text-muted-foreground sm:items-end">
              {c.relays.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t py-2.5 text-sm">
            <dt>Network</dt>
            <dd className="m-0 text-[13px] text-muted-foreground">{networkName(c.network)}</dd>
          </div>
        </dl>
        <p className="m-0 mt-1 text-[13px] leading-[18px] text-muted-foreground">
          Not the pairing code: that one is secret, works once and expires after 5 minutes. Anyone with this code still needs your hardware
          wallet, and every recovery is announced to your phone and your alert contacts.
        </p>
      </details>
    </section>
  );
}

/** Phones: pair one with an expiring code, see which are paired, print the "Recover on a new phone" sheet. */
export function PhonesPage() {
  usePageTitle('Phones');
  const { status, refresh } = useGuardian();
  // Decided once: a phone that pairs while this page is open keeps the code on screen to say so.
  const [alreadyPaired] = useState(() => (status?.wallets ?? []).some((w) => w.phonesPaired > 0));
  const [phonesKey, setPhonesKey] = useState(0);
  const code = useApi(() => api.getRecoveryCode(), [phonesKey]);

  const onPaired = useCallback(() => {
    setPhonesKey((k) => k + 1);
    refresh();
  }, [refresh]);

  return (
    <>
      <div className="flex flex-col gap-6 md:gap-7 print:hidden">
        <PageHeader title={alreadyPaired ? 'Phones' : 'Pair a phone'} />
        {alreadyPaired ? (
          <p className="m-0 max-w-[60ch] text-sm leading-5 text-muted-foreground">
            This guardian guards one wallet for one phone. Pairing opens again after you retire the wallet in the Trikey app or reset this
            guardian.
          </p>
        ) : (
          <PairCode onPaired={onPaired} />
        )}
        <PairedPhones reloadKey={phonesKey} />
        <RecoverOnNewPhone code={code} />
      </div>
      {code.data && <PrintSheet code={code.data} />}
    </>
  );
}
