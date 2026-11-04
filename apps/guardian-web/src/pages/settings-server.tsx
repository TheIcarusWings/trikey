import { useState, type FormEvent, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api, ApiError, type ChainSettings } from '@/api';
import { ErrorState } from '@/components/states';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { formatDateYear } from '@/lib/format';
import {
  CORE_NOTE,
  FINGERPRINT_COMMAND,
  KIND_LABELS,
  PUBLIC_WARNING,
  draftError,
  draftFrom,
  inputFrom,
  presetLabel,
  recoveryBlock,
  sourceLabel,
  type ServerDraft,
  type ServerKind,
} from '@/lib/server';
import { cn } from '@/lib/utils';

const hint = 'm-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground';

function Field({ id, label, children, note }: { id: string; label: string; children: ReactNode; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {note && <p className={hint}>{note}</p>}
    </div>
  );
}

function PublicWarning() {
  return (
    <Alert variant="warning">
      <TriangleAlert aria-hidden="true" />
      <p className="m-0 text-[13px] leading-[18px]">{PUBLIC_WARNING}</p>
    </Alert>
  );
}

function Status({ data }: { data: ChainSettings }) {
  const st = data.status;
  return (
    <dl className="m-0 flex flex-col gap-1 text-[15px] leading-5">
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">In use:</dt>
        <dd className="m-0 font-medium">{sourceLabel(data.source)}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">State:</dt>
        <dd className={cn('m-0', st.connected ? 'text-good' : 'text-bad')}>
          {st.connected ? `Connected${st.server ? ` to ${st.server}` : ''}${st.height !== undefined ? `, block ${st.height.toLocaleString('en-US')}` : ''}` : `Not connected${st.error ? `: ${st.error}` : ''}`}
        </dd>
      </div>
      {st.rescans.map((r) => (
        <p key={r.since} className={hint}>
          Bitcoin Core is scanning the chain for a wallet, from {formatDateYear(r.from)}. Its coins show once it is done.
        </p>
      ))}
      {data.origin === 'environment' && <p className={hint}>From the guardian's start-up settings (Umbrel, Start9 or the .env file). A change here overrides them.</p>}
    </dl>
  );
}

/** Settings > Server: where the guardian reads the blockchain, like Sparrow Wallet's Server preferences. */
export function ServerSection() {
  const settings = useApi(() => api.getChain(), [], 15_000);
  const [draft, setDraft] = useState<ServerDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  if (settings.loading && !settings.data) return <Skeleton className="h-24 w-full" />;
  if (!settings.data) return <ErrorState error={settings.error!} onRetry={settings.reload} title="Couldn't load the server settings" className="max-w-none" />;
  const data = settings.data;
  const d = draft ?? draftFrom(data);
  const set = (patch: Partial<ServerDraft>) => setDraft({ ...d, ...patch });
  const passStored = data.source?.kind === 'core' && data.source.rpc.host === d.host.trim() && data.source.rpc.user === d.user.trim();

  const check = (): string | undefined => draftError(d, passStored) ?? recoveryBlock(d, data);

  const onTest = async () => {
    const problem = draftError(d, passStored);
    if (problem) return setError(problem);
    setError(undefined);
    setBusy(true);
    try {
      const r = await api.testChain(inputFrom(d));
      setNote(r.ok ? `Connected${r.server ? ` to ${r.server}` : ''}${r.height !== undefined ? `, block ${r.height.toLocaleString('en-US')}` : ''}.` : `Could not connect: ${r.error ?? 'unknown error'}`);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not test the connection.');
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const problem = check();
    if (problem) return setError(problem);
    setError(undefined);
    setBusy(true);
    try {
      settings.set(await api.setChain(inputFrom(d)));
      setDraft(undefined);
      setNote('Saved. Your phone and every alert channel are told about the change.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="server-heading" className="flex flex-col gap-3">
      <h2 id="server-heading" className="m-0 text-base leading-[22px] font-semibold">
        Server
      </h2>
      <p className={hint}>Where the guardian reads the blockchain: your wallet's coins, new blocks, fees. Your own node is best.</p>
      <Status data={data} />
      {data.summary?.kind === 'public' && <PublicWarning />}

      <form onSubmit={onSave} noValidate className="flex flex-col gap-4">
        <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
          <legend className="pb-1.5 text-sm leading-5 font-medium">Kind of server</legend>
          {(['electrum', 'core', 'public'] as ServerKind[]).map((k) => (
            <label key={k} className="flex items-start gap-2.5 text-sm">
              <input
                type="radio"
                name="server-kind"
                value={k}
                checked={d.kind === k}
                onChange={() => {
                  setNote(undefined);
                  setError(undefined);
                  set({ kind: k, ...(k === 'public' ? { tls: true, preset: data.publicServers[0]?.id ?? '' } : {}), ...(k !== d.kind ? { host: '', port: '', certSha256: '', pass: '' } : {}) });
                }}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="font-medium">{KIND_LABELS[k].title}</span>
                <span className="text-[13px] leading-[18px] text-muted-foreground">{KIND_LABELS[k].note}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {d.kind === 'public' && (
          <>
            <PublicWarning />
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="pb-1.5 text-sm leading-5 font-medium">Public server</legend>
              {data.publicServers.map((p) => (
                <label key={p.id} className="flex items-center gap-2.5 text-sm">
                  <input type="radio" name="server-preset" value={p.id} checked={d.preset === p.id} onChange={() => set({ preset: p.id })} />
                  <span className="font-mono text-[13px]">{presetLabel(p)}</span>
                </label>
              ))}
              <label className="flex items-center gap-2.5 text-sm">
                <input type="radio" name="server-preset" value="" checked={d.preset === ''} onChange={() => set({ preset: '' })} />
                Another public server
              </label>
            </fieldset>
          </>
        )}

        {(d.kind !== 'public' || d.preset === '') && (
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field id="server-host" label={d.kind === 'core' ? 'Bitcoin Core address' : 'Server address'}>
              <Input id="server-host" autoComplete="off" spellCheck={false} placeholder={d.kind === 'core' ? '192.168.1.20' : 'electrs.local'} value={d.host} onChange={(e) => set({ host: e.target.value })} />
            </Field>
            <Field id="server-port" label={d.kind === 'core' ? 'RPC port' : 'Port'}>
              <Input id="server-port" inputMode="numeric" placeholder={d.kind === 'core' ? '8332' : d.tls || d.kind === 'public' ? '50002' : '50001'} value={d.port} onChange={(e) => set({ port: e.target.value })} />
            </Field>
          </div>
        )}

        {d.kind === 'electrum' && (
          <div className="flex items-center gap-2.5">
            <Checkbox id="server-tls" checked={d.tls} onCheckedChange={(v) => set({ tls: v === true })} />
            <label htmlFor="server-tls" className="text-sm">
              TLS (for a server on another machine; plain TCP goes only to this box or your own network)
            </label>
          </div>
        )}

        {((d.kind === 'electrum' && d.tls) || (d.kind === 'public' && d.preset === '')) && (
          <Field id="server-cert" label="Pinned certificate (optional)" note={`For a self-signed certificate (Fulcrum): its SHA-256 fingerprint, read on the server or with: ${FINGERPRINT_COMMAND}`}>
            <Input id="server-cert" autoComplete="off" spellCheck={false} className="font-mono" placeholder="AB:CD:…" value={d.certSha256} onChange={(e) => set({ certSha256: e.target.value })} />
          </Field>
        )}

        {d.kind === 'core' && (
          <>
            <p className={hint}>{CORE_NOTE}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="core-user" label="RPC user">
                <Input id="core-user" autoComplete="off" spellCheck={false} value={d.user} onChange={(e) => set({ user: e.target.value })} />
              </Field>
              <Field id="core-pass" label="RPC password" note={passStored ? 'Leave empty to keep the stored one.' : undefined}>
                <Input id="core-pass" type="password" autoComplete="new-password" value={d.pass} onChange={(e) => set({ pass: e.target.value })} />
              </Field>
            </div>
            <Field id="core-wallet" label="Wallet name in Bitcoin Core (optional)" note="Default trikey-guardian.">
              <Input id="core-wallet" autoComplete="off" spellCheck={false} value={d.wallet} onChange={(e) => set({ wallet: e.target.value })} />
            </Field>
          </>
        )}

        {data.recoveryRunning && d.kind === 'public' && <p className={cn(hint, 'text-warn')}>{recoveryBlock(d, data)}</p>}
        {error && (
          <p role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
            {error}
          </p>
        )}
        {note && <p className={hint}>{note}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void onTest()}>
            Test connection
          </Button>
          <Button type="submit" disabled={busy || (data.recoveryRunning && d.kind === 'public')}>
            {busy ? 'Working…' : 'Save'}
          </Button>
          {draft && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          )}
        </div>
        <p className={hint}>A change is announced to your phone, on every alert channel and in Activity.</p>
      </form>
    </section>
  );
}
