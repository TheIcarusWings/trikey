import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Plus, X } from 'lucide-react';
import { api, ApiError, type GuardianStatus, type RelaySettings } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { formatDateYear, shortenMiddle } from '@/lib/format';
import { addRelay, oldRelaysAfterChange, relayListError, sameRelayList } from '@/lib/relays';
import { cn } from '@/lib/utils';
import { NotificationsSection } from './settings-notifications';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-t py-2.5 text-[15px] leading-5 first:border-t-0">
      <dt>{label}</dt>
      <dd className="m-0 min-w-0 text-right text-muted-foreground">{children}</dd>
    </div>
  );
}

function chainValue(chain: GuardianStatus['chain']): string {
  if (chain.state === 'synced') return 'Connected';
  if (chain.state === 'syncing') return `Syncing ${Math.round((chain.progress ?? 0) * 100)}%`;
  return 'Unavailable';
}

/** What the guardian says about a relay. */
function RelayState({ connected }: { connected: boolean }) {
  return <span className={cn('shrink-0 text-[13px]', connected ? 'text-good' : 'text-muted-foreground')}>{connected ? 'Connected' : 'Not connected'}</span>;
}

/** Whether the paired phone switched to the latest list: when it is safe to say the phone no longer needs the old relays. */
function phoneNote(settings: RelaySettings, paired: boolean): string {
  if (!paired || !settings.lastChange) return '';
  const confirmed = settings.lastChange.phoneConfirmedAt;
  return confirmed
    ? `Your phone switched on ${formatDateYear(confirmed)}, so it no longer needs them. `
    : 'Your phone has not confirmed that it switched yet; it was told automatically and still needs them. ';
}

/** Asks before the guardian stops watching old relays: `url` for one, nothing for all of them. */
function StopWatchingDialog({
  target,
  settings,
  paired,
  stopping,
  error,
  onConfirm,
  onClose,
}: {
  target: { url?: string } | undefined;
  settings: RelaySettings;
  paired: boolean;
  stopping: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const url = target?.url;
  const one = url !== undefined;
  const confirmed = settings.lastChange?.phoneConfirmedAt;
  return (
    <AlertDialog open={target !== undefined} onOpenChange={(open) => !open && !stopping && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{one ? 'Stop watching this old relay?' : 'Stop watching all old relays?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {one ? (
              <>
                This guardian will stop listening and answering on <span className="font-mono break-all">{url}</span>.
              </>
            ) : (
              `This guardian will stop listening and answering on ${settings.retiring.length} old relays.`
            )}{' '}
            To watch {one ? 'it' : 'them'} again, add {one ? 'it' : 'them'} back as a relay. These will stop reaching this guardian:
          </AlertDialogDescription>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>"Recover on a new phone" sheets and phone backups made before the change that only know {one ? 'it' : 'them'}.</li>
            <li>
              Phones that have not switched to the new relays yet.
              {paired && (confirmed ? ' Your phone has switched.' : ' Your phone has not confirmed that it switched.')}
            </li>
          </ul>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={stopping}>Keep watching</AlertDialogCancel>
          <AlertDialogAction
            disabled={stopping}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {stopping ? 'Stopping…' : 'Stop watching'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The relays the phone reaches this guardian through: each with its connection, the old ones still watched after a
 * change, and an editor (add, remove, the setup's suggestions). The guardian checks the list again on save.
 */
function RelaysSection({ paired, onSaved }: { paired: boolean; onSaved: () => void }) {
  const settings = useApi(() => api.getRelays(), [], 15_000);
  const [draft, setDraft] = useState<string[]>();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [stopTarget, setStopTarget] = useState<{ url?: string }>();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();

  if (settings.loading && !settings.data) return <Skeleton className="h-24 w-full" />;
  if (!settings.data) return <ErrorState error={settings.error!} onRetry={settings.reload} title="Couldn't load the relays" className="max-w-none" />;
  const data = settings.data;
  const current = data.relays.map((r) => r.url);
  const editing = draft !== undefined;
  const suggestions = editing ? data.options.filter((o) => !draft.includes(o.url)) : [];

  const startEditing = () => {
    setDraft(current);
    setTyped('');
    setError(undefined);
  };
  const cancel = () => {
    setDraft(undefined);
    setError(undefined);
  };
  const add = (raw: string) => {
    if (!draft) return;
    const r = addRelay(draft, raw);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setDraft(r.relays);
    setTyped('');
    setError(undefined);
  };
  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    add(typed);
  };
  const remove = (url: string) => {
    if (!draft) return;
    setDraft(draft.filter((u) => u !== url));
    setError(undefined);
  };
  const save = async () => {
    if (!draft) return;
    const problem = relayListError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const old = oldRelaysAfterChange(data.retiring.map((r) => r.url), current, draft);
    if (old > data.maxRetiring) {
      setError(`This would leave ${old} old relays watched, and ${data.maxRetiring} is the most. Stop watching some old relays first.`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      settings.set(await api.setRelays({ relays: draft }));
      setDraft(undefined);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the relays.');
    } finally {
      setSaving(false);
    }
  };

  const askToStop = (url?: string) => {
    setStopTarget(url === undefined ? {} : { url });
    setStopError(undefined);
  };
  const stopWatching = async () => {
    if (!stopTarget) return;
    setStopping(true);
    setStopError(undefined);
    try {
      settings.set(await api.stopWatchingRelays(stopTarget.url));
      setStopTarget(undefined);
    } catch (e) {
      setStopError(e instanceof ApiError ? e.message : 'Could not stop watching the old relays.');
    } finally {
      setStopping(false);
    }
  };

  const label = (url: string) => data.options.find((o) => o.url === url)?.label;

  return (
    <section aria-labelledby="relays-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="relays-heading" className="m-0 text-base leading-[22px] font-semibold">
          Relays
        </h2>
        {!editing && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Change relays
          </Button>
        )}
      </div>
      <p className="m-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground">
        Your phone reaches this guardian through these nostr relays. They only pass on encrypted messages: a bad relay can delay or drop
        them, not read or change them.
      </p>

      {!editing ? (
        <>
          <ul className="m-0 list-none p-0">
            {data.relays.map((r) => (
              <li key={r.url} className="flex min-h-12 items-center justify-between gap-4 border-t py-2 first:border-t-0">
                <span className={cn('min-w-0 break-all text-[15px] leading-5', !r.label && 'font-mono text-[13px]')}>{r.label ?? r.url}</span>
                <RelayState connected={r.connected} />
              </li>
            ))}
          </ul>
          {data.retiring.length > 0 && (
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h3 id="old-relays-heading" className="m-0 text-sm leading-5 font-medium">
                  Old relays
                </h3>
                {data.retiring.length > 1 && (
                  <Button variant="outline-destructive" size="sm" onClick={() => askToStop()}>
                    Stop watching all
                  </Button>
                )}
              </div>
              <p role="status" className="m-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground">
                Still watched, so older recovery sheets and backups keep working. {phoneNote(data, paired)}
                Stop watching them once nothing made before the change is needed any more.
              </p>
              <ul className="m-0 list-none p-0" aria-labelledby="old-relays-heading">
                {data.retiring.map((r) => (
                  <li key={r.url} className="flex min-h-12 items-center justify-between gap-4 border-t py-2 first:border-t-0">
                    <div className="flex min-w-0 flex-col">
                      <span className={cn('break-all text-[15px] leading-5', !label(r.url) && 'font-mono text-[13px]')}>{label(r.url) ?? r.url}</span>
                      <span className="text-[13px] leading-[18px] text-muted-foreground">
                        Old since {formatDateYear(r.since)}
                        {r.connected ? '' : ', not connected'}
                      </span>
                    </div>
                    <Button variant="outline-destructive" size="sm" onClick={() => askToStop(r.url)} aria-label={`Stop watching ${r.url}`}>
                      Stop watching
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <StopWatchingDialog
            target={stopTarget}
            settings={data}
            paired={paired}
            stopping={stopping}
            error={stopError}
            onConfirm={stopWatching}
            onClose={() => setStopTarget(undefined)}
          />
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="m-0 list-none p-0" aria-label="Relays after the change">
            {draft.map((url) => (
              <li key={url} className="flex min-h-12 items-center justify-between gap-4 border-t py-1.5 first:border-t-0">
                <span className={cn('min-w-0 break-all text-[15px] leading-5', !label(url) && 'font-mono text-[13px]')}>{label(url) ?? url}</span>
                <Button variant="ghost" size="icon" onClick={() => remove(url)} disabled={saving} aria-label={`Remove ${url}`} className="size-11">
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
            {draft.length === 0 && <li className="border-t py-3 text-[13px] text-muted-foreground first:border-t-0">No relays. Add at least one.</li>}
          </ul>

          <form onSubmit={onAdd} noValidate className="flex flex-col gap-1.5">
            <Label htmlFor="relay-add">Add a relay</Label>
            <div className="flex gap-2">
              <Input
                id="relay-add"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="wss://relay.example.com"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'relays-error' : undefined}
                disabled={saving || draft.length >= data.max}
                className="font-mono text-[13px]"
              />
              <Button type="submit" variant="outline" disabled={saving || !typed.trim() || draft.length >= data.max}>
                Add
              </Button>
            </div>
          </form>

          {suggestions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 font-medium">Suggested</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((o) => (
                  <Button key={o.url} variant="outline" size="sm" onClick={() => add(o.url)} disabled={saving || draft.length >= data.max}>
                    <Plus aria-hidden="true" />
                    <span className={cn(!o.label && 'font-mono')}>{o.label ?? o.url}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <p id="relays-error" role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
              {error}
            </p>
          )}

          <p className="m-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground">
            {paired ? 'Your phone is told automatically and switches by itself. ' : ''}
            The guardian keeps watching the relays you remove, so a phone that was off, a phone restored from an older backup and an older
            "Recover on a new phone" sheet keep working until you stop watching them. Print a new sheet on the Phones page after you save.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={saving || sameRelayList(draft, current)}>
              {saving ? 'Saving…' : 'Save relays'}
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Lock now, the relays, the details of this box (collapsed), and the reset in its own danger zone. */
export function SettingsPage() {
  usePageTitle('Settings');
  const navigate = useNavigate();
  const { status, error, loading, refresh, setStatus } = useGuardian();
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string>();

  const lockNow = async () => {
    setLocking(true);
    setLockError(undefined);
    try {
      setStatus(await api.lock());
      navigate('/locked');
    } catch (e) {
      setLockError(e instanceof ApiError ? e.message : 'Could not lock the guardian.');
      setLocking(false);
    }
  };

  if (loading) return <PageSkeleton rows={3} />;
  if (!status) return <ErrorState error={error!} onRetry={refresh} />;

  const connected = status.relays.filter((r) => r.connected).length;
  const relays = connected === status.relays.length ? `${connected} connected` : `${connected} of ${status.relays.length} connected`;

  return (
    <div className="flex flex-col gap-6 md:gap-7">
      <PageHeader title="Settings" />

      <section aria-labelledby="guardian-heading" className="flex flex-col gap-3">
        <h2 id="guardian-heading" className="m-0 text-base leading-[22px] font-semibold">
          Guardian
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button variant="outline" onClick={lockNow} disabled={locking}>
            {locking ? 'Locking…' : 'Lock now'}
          </Button>
          <p className="m-0 min-w-0 max-w-[60ch] flex-1 basis-60 text-[13px] leading-[18px] text-muted-foreground">
            Use this if you think someone has been at the box. It takes the passphrase to unlock.
          </p>
        </div>
        {lockError && <ErrorState error={new Error(lockError)} title="Couldn't lock the guardian" className="max-w-none" />}
      </section>

      <RelaysSection paired={status.wallets.some((w) => w.phonesPaired > 0)} onSaved={refresh} />

      <NotificationsSection />

      <details className="group/advanced">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-base leading-[22px] font-semibold outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-4 text-muted-foreground transition-transform group-open/advanced:rotate-90"
            aria-hidden="true"
          />
          Advanced
        </summary>
        <dl className="m-0 mt-2 flex flex-col">
          <InfoRow label="Guardian ID">
            {status.npub ? (
              <span className="font-mono text-[13px]" title={status.npub}>
                {shortenMiddle(status.npub, 9, 4)}
              </span>
            ) : (
              '–'
            )}
          </InfoRow>
          <InfoRow label="Relays">{relays}</InfoRow>
          <InfoRow label={status.chain.source.replace(/\s*\+\s*/g, ' and ')}>{chainValue(status.chain)}</InfoRow>
          <InfoRow label="Version">{status.version ? `${status.version} · pre-alpha` : 'pre-alpha'}</InfoRow>
        </dl>
      </details>

      <section
        aria-labelledby="danger-heading"
        className="flex flex-col gap-3 rounded-xl border border-bad/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="danger-heading" className="m-0 text-[15px] leading-5 font-semibold">
            Reset guardian
          </h2>
          <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
            Forgets every wallet and makes a new key 3. Not possible while a recovery runs.
          </p>
        </div>
        <Button asChild variant="outline-destructive" className="w-fit shrink-0 border-bad/60">
          <Link to="/reset">Reset…</Link>
        </Button>
      </section>
    </div>
  );
}
