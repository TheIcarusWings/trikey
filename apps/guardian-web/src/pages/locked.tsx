import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { AuthCard, AuthHeader } from '@/components/layout/centered';
import { ManagerUsername } from '@/components/manager-username';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-api';

const WATCH_MS = 3000;

function clock(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function LockedPage() {
  usePageTitle('Locked');
  const navigate = useNavigate();
  const { status, refresh, setStatus } = useGuardian();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The phone can unlock the guardian too; notice when it does.
  useEffect(() => {
    const id = window.setInterval(refresh, WATCH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!passphrase) {
      setError('Enter your unlock passphrase.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // The passphrase lives only in this component's state and is cleared as soon as the request settles.
      const next = await api.unlock({ passphrase });
      setStatus(next);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_passphrase') setError("That passphrase isn't right. Try again.");
      else if (err instanceof ApiError && err.code === 'rate_limited') {
        setError(
          err.retryAfterSeconds
            ? `Too many tries. Wait ${err.retryAfterSeconds} seconds and try again.`
            : 'Too many tries. Wait a moment and try again.',
        );
      } else setError(err instanceof ApiError ? err.message : 'Could not unlock the guardian.');
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  };

  const cause =
    status?.lockedAt && status.lockReason === 'manual'
      ? `You locked this guardian at ${clock(status.lockedAt)}, so key 3 is encrypted until you unlock it.`
      : status?.lockedAt && status.lockReason === 'remote'
        ? `Your phone locked this guardian at ${clock(status.lockedAt)}. If you did not ask for this, check the box before unlocking it.`
        : status?.lockedAt
        ? `This box restarted at ${clock(status.lockedAt)}, so key 3 is encrypted until you unlock it.`
        : 'Key 3 is encrypted until you unlock it.';

  return (
    <AuthCard>
      <AuthHeader title="Guardian locked" />
      <p className="m-0 text-center text-sm leading-5 text-muted-foreground">{cause} Phone-only payments wait until then.</p>

      <div className="flex flex-col gap-1 rounded-[10px] border px-4 py-3.5">
        <span className="flex flex-wrap items-center gap-2 text-sm leading-5 font-medium">
          Unlock from the Trikey app <Badge variant="outline">Recommended</Badge>
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          Your phone shows a Guardian locked card. Approve it with your hardware wallet.
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px grow bg-border" />
        OR
        <span className="h-px grow bg-border" />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <ManagerUsername />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unlock-pass">Unlock passphrase</Label>
          <Input
            id="unlock-pass"
            name="passphrase"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'unlock-error' : undefined}
            disabled={busy}
            className="h-11"
          />
          <p id="unlock-error" role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {error}
          </p>
        </div>
        <Button type="submit" size="lg" disabled={busy} className="h-12 w-full">
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
      <p className="m-0 text-center text-[13px] leading-[18px] text-muted-foreground">
        Locking after every restart means a stolen box is useless.
      </p>
    </AuthCard>
  );
}
