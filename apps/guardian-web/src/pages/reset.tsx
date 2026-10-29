import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError, RESET_CONFIRMATION } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
 * funds together). The guardian refuses while a recovery runs.
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
  const paired = (status?.wallets.length ?? 0) > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      // The passphrase lives only in this component's state and is cleared as soon as the request settles.
      const next = await api.resetGuardian({ passphrase, confirm });
      setStatus(next, '/pair');
      navigate('/pair');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reset guardian"
        description="Start over on this box: forget the wallet, its rules and history, and create a new key 3. The guardian keeps its nostr address, relays and unlock passphrase."
      />

      {status?.recoveryInProgress && (
        <Alert variant="warning" className="max-w-[720px]">
          <AlertTriangle aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>A recovery is in progress</AlertTitle>
            <AlertDescription>The guardian can't be reset until it is cancelled or completed.</AlertDescription>
          </div>
        </Alert>
      )}

      <Alert variant="destructive" className="max-w-[720px]">
        <AlertTriangle aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <AlertTitle>This destroys key 3</AlertTitle>
          <AlertDescription>
            {paired
              ? 'Move your funds first. After a reset this guardian can never co-sign for the current wallet again: only your phone and hardware wallet together can move its coins. There is no backup of key 3.'
              : 'There is no backup of key 3. A wallet that still uses it could then only be spent with its phone and hardware wallet together.'}
          </AlertDescription>
        </div>
      </Alert>

      <Card className="max-w-[720px] p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-pass">Unlock passphrase</Label>
            <Input
              id="reset-pass"
              name="passphrase"
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-confirm">
              Type <span className="font-mono">{RESET_CONFIRMATION}</span> to confirm
            </Label>
            <Input
              id="reset-confirm"
              name="confirm"
              autoComplete="off"
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'reset-error' : undefined}
              disabled={busy}
            />
            <p id="reset-error" role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
              {error}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="destructive" disabled={busy || !ready}>
              {busy ? 'Resetting…' : 'Reset guardian'}
            </Button>
            <Button type="button" variant="link" onClick={() => navigate('/')}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
