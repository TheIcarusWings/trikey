import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api, ApiError, type FamilyInvite, type HostedWallet } from '@/api';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { QrCode } from '@/components/qr-code';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi, useNow, usePageTitle } from '@/hooks/use-api';
import { formatDate, formatShortRemaining } from '@/lib/format';

function WalletRow({ wallet, onCancel, cancelling }: { wallet: HostedWallet; onCancel: () => void; cancelling: boolean }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm leading-5 font-medium">{wallet.name}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          {wallet.state === 'invited'
            ? 'Invite sent · not accepted yet'
            : `Since ${wallet.since ? formatDate(wallet.since) : 'recently'}${wallet.recoveryDelayDays ? ` · ${wallet.recoveryDelayDays}-day recovery wait` : ''}`}
        </span>
      </div>
      {wallet.state === 'invited' ? (
        <Button variant="outline-destructive" size="sm" onClick={onCancel} disabled={cancelling} aria-label={`Cancel invite for ${wallet.name}`}>
          Cancel invite
        </Button>
      ) : (
        <span className="flex items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
          <span aria-hidden="true" className="size-2 rounded-full bg-good" />
          Signed {wallet.paymentsThisWeek ?? 0} {wallet.paymentsThisWeek === 1 ? 'payment' : 'payments'} this week
        </span>
      )}
    </li>
  );
}

export function HostPage() {
  usePageTitle('Host for someone');
  const hosting = useApi(() => api.getHosting(), [], 30_000);
  const now = useNow(30_000);

  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<FamilyInvite | null>(null);
  const [newMode, setNewMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const [error, setError] = useState<string>();

  const candidate = newMode ? null : (fresh ?? hosting.data?.pendingInvite ?? null);
  const current = candidate && candidate.status === 'pending' && Date.parse(candidate.expiresAt) > now ? candidate : null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Add a name so you can tell invites apart.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const invite = await api.createFamilyInvite({ name: name.trim() });
      setFresh(invite);
      setNewMode(false);
      hosting.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invite.');
    } finally {
      setBusy(false);
    }
  };

  const cancelInvite = async (inviteId: string) => {
    setCancelling(inviteId);
    setError(undefined);
    try {
      await api.cancelFamilyInvite(inviteId);
      if (fresh?.id === inviteId) setFresh(null);
      hosting.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the invite.');
    } finally {
      setCancelling(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Host a guardian for someone"
        description="Help someone you know who doesn't have a home server. Their wallet gets its own key here, separate from yours."
      />

      <Alert variant="warning" className="max-w-[720px] border-transparent">
        <TriangleAlert aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <AlertTitle className="text-sm leading-5">You'll hold one of their three keys</AlertTitle>
          <AlertDescription>
            You can't spend their money or see their balance. But they're counting on you to keep this box online, let the
            recovery wait run its full length, and never help anyone get around it.
          </AlertDescription>
        </div>
      </Alert>

      <Card className="max-w-[720px] flex-row flex-wrap items-start gap-8 p-6">
        <form onSubmit={create} noValidate className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fam-name">Who is it for?</Label>
            <Input
              id="fam-name"
              type="text"
              autoComplete="off"
              value={current ? current.name : name}
              onChange={(e) => setName(e.target.value)}
              readOnly={current !== null}
              aria-describedby="fam-name-hint"
              aria-invalid={error && !current ? true : undefined}
              disabled={busy}
            />
            <span id="fam-name-hint" className="text-[13px] leading-[18px] text-muted-foreground">
              Only you see this name.
            </span>
          </div>

          {current ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fam-link">Invite link</Label>
                <div className="flex gap-2">
                  <Input
                    id="fam-link"
                    readOnly
                    value={current.link}
                    onFocus={(e) => e.currentTarget.select()}
                    className="font-mono text-[13px]"
                  />
                  <CopyButton value={current.link} />
                </div>
              </div>
              <div className="flex items-center gap-2.5 text-sm leading-5 text-muted-foreground">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warn" />
                Works once · expires in {formatShortRemaining(Date.parse(current.expiresAt) - now)}
              </div>
              <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
                Send it in person or over a chat you trust. They'll see your name and this box before they accept.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  setNewMode(true);
                  setName('');
                  setError(undefined);
                }}
              >
                Invite someone else
              </Button>
            </>
          ) : (
            <>
              <Button type="submit" className="w-fit" disabled={busy}>
                {busy ? 'Creating…' : 'Create invite link'}
              </Button>
              <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
                The link works once and expires after 24 hours. You'll get a link and a QR code to share.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
              {error}
            </p>
          )}
        </form>

        {current && (
          <div className="size-[184px] max-w-full shrink-0 rounded-xl border bg-white p-3">
            <QrCode value={current.link} size={158} label="Invite QR code" />
          </div>
        )}
      </Card>

      <section aria-labelledby="hosted-heading" className="flex max-w-[720px] flex-col gap-2">
        <h2 id="hosted-heading" className="text-sm leading-5 font-semibold">
          Wallets you host
        </h2>
        {hosting.loading ? (
          <PageSkeleton rows={1} />
        ) : !hosting.data ? (
          <ErrorState error={hosting.error!} onRetry={hosting.reload} title="Couldn't load hosted wallets" className="max-w-none" />
        ) : hosting.data.wallets.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">You don't host any wallets yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col rounded-xl border p-0">
            {hosting.data.wallets.map((w) => (
              <WalletRow
                key={w.id}
                wallet={w}
                cancelling={cancelling === w.inviteId}
                onCancel={() => w.inviteId && void cancelInvite(w.inviteId)}
              />
            ))}
          </ul>
        )}
        <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
          To stop hosting, ask them to choose Replace guardian in their app first, so their money never depends on a key you've
          deleted.
        </p>
      </section>
    </div>
  );
}
