import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { AuthCard, AuthHeader } from '@/components/layout/centered';
import { ManagerUsername } from '@/components/manager-username';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-api';

/**
 * Sign in to this guardian's web UI with the unlock passphrase (`POST /api/session`). The web UI needs
 * a session since the 2026-10 security review: other apps on the box must not be able to drive it. A
 * locked guardian is unlocked by the same passphrase entry.
 */
export function SignInPage() {
  usePageTitle('Sign in');
  const navigate = useNavigate();
  const { signedOut, setStatus } = useGuardian();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = signedOut?.state === 'locked';

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
      const next = await api.signIn({ passphrase, unlock: locked });
      setStatus(next);
      navigate(next.state === 'locked' ? '/locked' : '/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_passphrase') setError("That passphrase isn't right. Try again.");
      else if (err instanceof ApiError && err.code === 'rate_limited') {
        setError(
          err.retryAfterSeconds
            ? `Too many tries. Wait ${err.retryAfterSeconds} seconds and try again.`
            : 'Too many tries. Wait a moment and try again.',
        );
      } else setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <AuthHeader title="Trikey Guardian" />
      {locked && (
        <p className="m-0 text-center text-sm leading-5 text-muted-foreground">
          The guardian is locked. Your unlock passphrase signs you in and unlocks it.
        </p>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <ManagerUsername />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signin-pass">Unlock passphrase</Label>
          <Input
            id="signin-pass"
            name="passphrase"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'signin-error' : undefined}
            disabled={busy}
            className="h-11"
          />
          <p id="signin-error" role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {error}
          </p>
        </div>
        <Button type="submit" size="lg" disabled={busy} className="h-12 w-full">
          {busy ? 'Signing in…' : locked ? 'Sign in and unlock' : 'Sign in'}
        </Button>
      </form>
      <p className="m-0 text-center text-[13px] leading-[18px] text-muted-foreground">
        You stay signed in on this browser until it has been idle for 30 minutes. Signing out doesn't lock the guardian.
      </p>
    </AuthCard>
  );
}
