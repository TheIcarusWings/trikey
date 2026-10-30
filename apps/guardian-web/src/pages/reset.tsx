import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { api, ApiError, RESET_CONFIRMATION } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-api';

function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not reset the guardian.';
  switch (err.code) {
    case 'bad_passphrase':
      return "That passphrase isn't right.";
    case 'rate_limited':
      return err.retryAfterSeconds ? `Too many tries. Wait ${err.retryAfterSeconds} seconds and try again.` : 'Too many tries. Wait a moment and try again.';
    default:
      // recovery_pending, sweep_pending, invalid: the guardian's message says what to do.
      return err.message;
  }
}

/**
 * Reset the guardian: forget the wallet and create a new key 3. The old key 3 is destroyed, so
 * the old wallet can never be co-signed here again (its phone and hardware wallet still move its
 * funds together). The guardian refuses while a recovery runs. The reset needs the passphrase and
 * the words `RESET GUARDIAN` typed out.
 */
export function ResetPage() {
  usePageTitle('Reset guardian');
  const navigate = useNavigate();
  const { status, setStatus } = useGuardian();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = confirm === RESET_CONFIRMATION && passphrase.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      // The passphrase lives only in this component's state and is cleared as soon as the request settles.
      const next = await api.resetGuardian({ passphrase, confirm });
      setStatus(next, '/phones');
      navigate('/phones');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-[560px] flex-col gap-5 md:gap-6">
      <PageHeader title="Reset guardian" />

      {status?.recoveryInProgress && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3.5 text-sm leading-5">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          <p className="m-0">
            <span className="font-semibold">A recovery is in progress.</span> The guardian can't be reset until it is cancelled or
            completed.
          </p>
        </div>
      )}

      <dl className="m-0 flex flex-col gap-2 rounded-xl bg-warn-soft px-4 py-3.5 text-sm leading-5">
        <dt className="font-semibold">Forgotten</dt>
        <dd className="m-0">
          Every wallet it guards, its rules and history. Key 3 is replaced, so it can never co-sign those wallets again.
        </dd>
        <dt className="mt-1 font-semibold">Kept</dt>
        <dd className="m-0">Its identity, relays and passphrase.</dd>
      </dl>

      <p className="m-0 text-sm leading-5 text-muted-foreground">
        Your money stays safe: your phone and hardware wallet can still move it. There is no backup of key 3.
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-pass">Passphrase</Label>
          <Input
            id="reset-pass"
            name="passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-confirm">
            Type <span className="font-mono">{RESET_CONFIRMATION}</span> to confirm
          </Label>
          <Input
            id="reset-confirm"
            name="confirm"
            placeholder={RESET_CONFIRMATION}
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'reset-error' : undefined}
            disabled={busy}
            className="h-11"
          />
          <p id="reset-error" role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {error}
          </p>
        </div>
        <div className="flex flex-col gap-2 pt-2">
          <Button type="submit" variant="destructive" size="lg" disabled={busy || !ready} className="h-12 w-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100">
            {busy ? 'Resetting…' : 'Reset guardian'}
          </Button>
          <Button asChild variant="link" className="self-center">
            <Link to="/settings">Cancel</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
