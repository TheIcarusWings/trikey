import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { api, ApiError } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { ManagerUsername } from '@/components/manager-username';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-api';
import {
  CHANGE_PASSPHRASE_INTRO,
  MIN_PASSPHRASE,
  PASSPHRASE_CHANGED_NOTES,
  PASSPHRASE_HINT,
  changePassphraseError,
  newPassphraseErrors,
  type NewPassphraseErrors,
} from '@/lib/passphrase';
import { passwordRules } from '@/lib/password-manager';

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
      {children}
    </p>
  );
}

/**
 * Settings > Passphrase > Change: the current passphrase, the new one twice (the setup's rule). The guardian encrypts the
 * same key 3 again under the new passphrase, signs every other browser out and tells the phone and the alert channels.
 * Afterwards the page says plainly what the old passphrase no longer does and what the change does not touch
 * (lib/passphrase.ts). The passphrases live only in this component's state and are cleared as soon as the request settles.
 */
export function PassphrasePage() {
  usePageTitle('Change passphrase');
  const { setStatus } = useGuardian();
  const [current, setCurrent] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<NewPassphraseErrors & { form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next = newPassphraseErrors({ current, passphrase, confirm });
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const status = await api.changePassphrase({ passphrase: current, newPassphrase: passphrase });
      setStatus(status);
      setDone(true);
    } catch (err) {
      const message = changePassphraseError(err instanceof ApiError ? err : undefined);
      setErrors(err instanceof ApiError && err.code === 'bad_passphrase' ? { current: message } : { form: message });
    } finally {
      // Never keep a passphrase around once it has been sent.
      setCurrent('');
      setPassphrase('');
      setConfirm('');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="flex max-w-[600px] flex-col gap-5 md:gap-6">
        <PageHeader title="Passphrase changed" />
        <div role="status" className="flex items-start gap-3 rounded-xl border border-good/40 bg-good-soft px-4 py-3.5 text-sm leading-5">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-good" aria-hidden="true" />
          <p className="m-0">
            <span className="font-semibold">The guardian now unlocks with the new passphrase only.</span> Other browsers were signed out; your
            phone and your alert channels were told.
          </p>
        </div>
        <ul className="m-0 flex list-disc flex-col gap-2.5 pl-5 text-sm leading-5">
          {PASSPHRASE_CHANGED_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/settings">Back to Settings</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-5 md:gap-6">
      <PageHeader title="Change passphrase" description={CHANGE_PASSPHRASE_INTRO} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <ManagerUsername />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pp-current">Current passphrase</Label>
          <Input
            id="pp-current"
            name="current-passphrase"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-invalid={errors.current ? true : undefined}
            aria-describedby={errors.current ? 'pp-current-error' : undefined}
            disabled={busy}
            className="h-11"
          />
          <FieldError id="pp-current-error">{errors.current}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pp-new">New passphrase</Label>
          <Input
            id="pp-new"
            name="new-passphrase"
            type="password"
            autoComplete="new-password"
            {...{ passwordrules: passwordRules(MIN_PASSPHRASE) }}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={errors.passphrase ? true : undefined}
            aria-describedby={errors.passphrase ? 'pp-new-error' : 'pp-new-hint'}
            disabled={busy}
            className="h-11"
          />
          {errors.passphrase ? (
            <FieldError id="pp-new-error">{errors.passphrase}</FieldError>
          ) : (
            <p id="pp-new-hint" className="m-0 text-[13px] leading-[18px] text-muted-foreground">
              {PASSPHRASE_HINT}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pp-new2">Type the new one again</Label>
          <Input
            id="pp-new2"
            name="confirm-passphrase"
            type="password"
            autoComplete="new-password"
            {...{ passwordrules: passwordRules(MIN_PASSPHRASE) }}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? 'pp-new2-error' : undefined}
            disabled={busy}
            className="h-11"
          />
          <FieldError id="pp-new2-error">{errors.confirm}</FieldError>
        </div>
        {errors.form && (
          <p role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {errors.form}
          </p>
        )}
        <div className="flex flex-col gap-2 pt-2">
          <Button type="submit" size="lg" disabled={busy} className="h-12 w-full">
            {busy ? 'Changing… (a few seconds)' : 'Change passphrase'}
          </Button>
          <Button asChild variant="link" className="self-center">
            <Link to="/settings">Cancel</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
