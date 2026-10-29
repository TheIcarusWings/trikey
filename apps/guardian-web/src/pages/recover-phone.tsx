import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { api } from '@/api';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { QrCode } from '@/components/qr-code';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useApi, usePageTitle } from '@/hooks/use-api';

/**
 * "Recover on a new phone": a permanent QR code with only where to find this guardian (its npub,
 * relays and network). Unlike the pairing code it holds no secret and never expires: the hardware
 * wallet is what lets a new phone in, so it is safe to print and keep with the hardware wallet.
 */
export function RecoverPhonePage() {
  usePageTitle('Recover on a new phone');
  const code = useApi(() => api.getRecoveryCode(), []);

  if (code.loading && !code.data) return <PageSkeleton rows={2} />;

  if (code.error && !code.data) {
    if (code.error.code === 'not_found') {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title="Recover on a new phone" />
          <Alert className="max-w-[720px]">
            <Info aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <AlertTitle>No wallet is paired yet</AlertTitle>
              <AlertDescription>
                This code helps a new phone recover the wallet this guardian protects.{' '}
                <Link to="/pair" className="font-medium underline underline-offset-3">
                  Pair a phone
                </Link>{' '}
                first.
              </AlertDescription>
            </div>
          </Alert>
        </div>
      );
    }
    return <ErrorState error={code.error} onRetry={code.reload} title="Couldn't load the recovery code" />;
  }

  const c = code.data!;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recover on a new phone"
        description="Lost your phone and its backup? Scan this with Trikey on a new phone, then approve on your hardware wallet. The code holds no secret, so you can print it and keep it with the hardware wallet."
      />

      <Card className="max-w-[720px] flex-row flex-wrap items-center gap-8 p-6">
        <div className="size-[232px] max-w-full shrink-0 rounded-xl border bg-white p-4">
          <QrCode value={c.uri} size={198} label="Recover on a new phone QR code" />
        </div>
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <ol className="m-0 flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-5">
            <li>Install Trikey on the new phone and choose Recover with my hardware wallet.</li>
            <li>Scan this code, connect the hardware wallet and approve the request it shows.</li>
            <li>
              The phone starts a recovery. Your alert contacts are told, and the funds move to your new wallet after the waiting
              period. This guardian then protects the new wallet.
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={c.uri} label="Copy code" />
            <Button variant="outline" onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </div>
      </Card>

      <section aria-labelledby="where-heading" className="flex max-w-[720px] flex-col gap-2">
        <h2 id="where-heading" className="text-sm leading-5 font-semibold">
          What the code contains
        </h2>
        <dl className="m-0 flex flex-col rounded-xl border">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
            <dt className="text-sm font-medium">Guardian</dt>
            <dd className="m-0 min-w-0 font-mono text-[13px] break-all text-muted-foreground">{c.npub}</dd>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
            <dt className="text-sm font-medium">Relays</dt>
            <dd className="m-0 flex min-w-0 flex-col items-end gap-0.5 font-mono text-[13px] break-all text-muted-foreground">
              {c.relays.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <dt className="text-sm font-medium">Network</dt>
            <dd className="m-0 text-[13px] text-muted-foreground">{c.network}</dd>
          </div>
        </dl>
        <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
          Not the pairing code: that one is secret, works once and expires after 5 minutes. Anyone with this code still needs your
          hardware wallet, and every recovery is announced to your phone and your alert contacts.
        </p>
      </section>
    </div>
  );
}
