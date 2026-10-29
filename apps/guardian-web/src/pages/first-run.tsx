import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, TriangleAlert } from 'lucide-react';
import { api, ApiError, type SetupPreflight } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { cn } from '@/lib/utils';

const MIN_PASSPHRASE = 12;

function ChainCheck({ preflight }: { preflight: SetupPreflight }) {
  const missing = preflight.node === 'missing' || preflight.electrs === 'missing';
  const syncing = !missing && !preflight.synced;
  const ok = !missing && !syncing;
  const title = missing
    ? `${preflight.node === 'missing' ? 'Bitcoin Node' : 'Electrs'} not found`
    : 'Bitcoin Node and Electrs found';
  const body = missing
    ? 'Install and start both apps on this box, then reload this page. The guardian only reads chain data from them.'
    : syncing
      ? `Still syncing${preflight.syncProgress !== undefined ? ` (${Math.round(preflight.syncProgress * 100)}%)` : ''}. You can set up now; payments wait until it finishes.`
      : 'Fully synced. Chain data stays on this box.';
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn',
        )}
      >
        {ok ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : <TriangleAlert className="size-3.5" strokeWidth={2.5} aria-hidden="true" />}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">{body}</span>
      </div>
    </div>
  );
}

export function FirstRunPage() {
  usePageTitle('Set up your guardian');
  const navigate = useNavigate();
  const { setStatus } = useGuardian();
  const { data: preflight, error: loadError, loading, reload } = useApi(() => api.getSetupPreflight());

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [relays, setRelays] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<{ passphrase?: string; confirm?: string; relays?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (preflight) setRelays(Object.fromEntries(preflight.relayOptions.map((r) => [r.url, r.defaultSelected])));
  }, [preflight]);

  if (loading) return <PageSkeleton rows={2} />;
  if (!preflight) return <ErrorState error={loadError!} onRetry={reload} title="Couldn't check this box" />;

  const chainReady = preflight.node === 'found' && preflight.electrs === 'found';

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (passphrase.length < MIN_PASSPHRASE) next.passphrase = `Use at least ${MIN_PASSPHRASE} characters. A few random words work well.`;
    if (confirm !== passphrase) next.confirm = "The two passphrases don't match.";
    const chosen = preflight.relayOptions.filter((r) => relays[r.url]).map((r) => r.url);
    if (chosen.length === 0) next.relays = 'Choose at least one relay so your phone can reach this guardian.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const status = await api.completeSetup({ passphrase, relays: chosen });
      setStatus(status, '/pair');
      navigate('/pair');
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : 'Could not create the guardian.' });
    } finally {
      // Never keep the passphrase around once it has been sent.
      setPassphrase('');
      setConfirm('');
      setBusy(false);
    }
  };

  return (
    <Card className="gap-6 p-6">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">Set up your guardian</h1>
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            This box will hold key 3 of your Trikey wallet and co-sign everyday payments within your rules.
          </p>
        </div>

        <ChainCheck preflight={preflight} />

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm leading-5 font-medium">Unlock passphrase</span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">
              After a restart the guardian locks itself. You can unlock it with your hardware wallet from the app, or with this
              passphrase.
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-pass">Passphrase</Label>
            <Input
              id="g-pass"
              name="new-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              aria-invalid={errors.passphrase ? true : undefined}
              aria-describedby={errors.passphrase ? 'g-pass-error' : undefined}
              disabled={busy}
            />
            {errors.passphrase && (
              <p id="g-pass-error" className="m-0 text-[13px] leading-[18px] text-bad">
                {errors.passphrase}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-pass2">Confirm passphrase</Label>
            <Input
              id="g-pass2"
              name="confirm-passphrase"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={errors.confirm ? true : undefined}
              aria-describedby={errors.confirm ? 'g-pass2-error' : undefined}
              disabled={busy}
            />
            {errors.confirm && (
              <p id="g-pass2-error" className="m-0 text-[13px] leading-[18px] text-bad">
                {errors.confirm}
              </p>
            )}
          </div>
        </div>

        <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0" aria-describedby={errors.relays ? 'relays-error' : undefined}>
          <legend className="pb-1.5 text-sm leading-5 font-medium">Relays</legend>
          {preflight.relayOptions.map((relay, i) => {
            const id = `relay-${i}`;
            return (
              <div key={relay.url} className="flex items-center gap-2.5">
                <Checkbox
                  id={id}
                  checked={relays[relay.url] ?? false}
                  onCheckedChange={(v) => setRelays((cur) => ({ ...cur, [relay.url]: v === true }))}
                  disabled={busy}
                />
                <label htmlFor={id} className={cn('min-w-0 text-sm', !relay.label && 'font-mono text-[13px]')}>
                  {relay.label ?? relay.url}
                </label>
              </div>
            );
          })}
          {errors.relays && (
            <p id="relays-error" className="m-0 text-[13px] leading-[18px] text-bad">
              {errors.relays}
            </p>
          )}
        </fieldset>

        {errors.form && (
          <p role="alert" className="m-0 text-sm text-bad">
            {errors.form}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" disabled={busy || !chainReady} className="px-4">
            {busy ? 'Creating…' : 'Create guardian'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
