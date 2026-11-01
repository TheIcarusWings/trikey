import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type NotificationSettings, type NotifyChannelKind, type NotifyDestination, type NotifyDestinationInput } from '@/api';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { formatDateTime, shortenMiddle } from '@/lib/format';
import {
  SMTP_PRESETS,
  audienceLabel,
  channelLabel,
  emailError,
  guardianNameError,
  healthLabel,
  settingsInput,
  smtpError,
  topicError,
  topicWarning,
  urlError,
  webhookSecretError,
  type SmtpDraft,
} from '@/lib/notifications';
import { cn } from '@/lib/utils';

const selectClass =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50';
const hint = 'm-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground';
const shortNpub = (npub: string) => shortenMiddle(npub, 12, 6);

function Field({ id, label, children, note }: { id: string; label: string; children: ReactNode; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {note && <p className={hint}>{note}</p>}
    </div>
  );
}

function Problem({ id, text }: { id?: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="m-0 text-[13px] leading-[18px] text-bad">
      {text}
    </p>
  );
}

/** The owner's email account: the guardian sends every email through it (SMTP, TLS always). */
function EmailAccount({ data, busy, save, test }: { data: NotificationSettings; busy: boolean; save: (draft: SmtpDraft | null) => Promise<string | undefined>; test: () => Promise<string | undefined> }) {
  const s = data.smtp;
  const [editing, setEditing] = useState(!s);
  const [draft, setDraft] = useState<SmtpDraft>(() => ({ host: s?.host ?? '', port: String(s?.port ?? 465), security: s?.security ?? 'tls', username: s?.username ?? '', from: s?.from ?? '', password: '' }));
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const set = (patch: Partial<SmtpDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const problem = smtpError(draft, !!s);
    if (problem) return setError(problem);
    setError(undefined);
    const failed = await save(draft);
    if (failed) setError(failed);
    else {
      setDraft((d) => ({ ...d, password: '' }));
      setEditing(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-sm leading-5 font-medium">Email account</h3>
      {s && !editing ? (
        <>
          <p className="m-0 text-[15px] leading-5">
            {s.username} via <span className="font-mono text-[13px]">{s.host}:{s.port}</span> ({s.security === 'tls' ? 'TLS' : 'STARTTLS'}), from {s.from}
          </p>
          <p className={cn(hint, s.health.state === 'failing' && 'text-bad')}>{healthLabel(s.health, formatDateTime)}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void test().then(setNote)}>
              Send a test message
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
          {note && <p className={hint}>{note}</p>}
        </>
      ) : (
        <form onSubmit={onSave} noValidate className="flex flex-col gap-3">
          <p className={hint}>
            The guardian sends email through your own account, with an <strong>app password</strong> made for it (never your account password). It keeps
            the app password on this box, sealed, so alerts still go out while the guardian is locked. Revoke it in your account if the box is lost.
          </p>
          <div className="flex flex-wrap gap-2">
            {SMTP_PRESETS.map((p) => (
              <Button key={p.label} type="button" variant="outline" size="sm" onClick={() => (set({ host: p.host, port: String(p.port), security: p.security }), setNote(p.note))}>
                {p.label}
              </Button>
            ))}
          </div>
          {note && <p className={hint}>{note}</p>}
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem_9rem]">
            <Field id="smtp-host" label="Email server">
              <Input id="smtp-host" autoComplete="off" spellCheck={false} placeholder="smtp.example.com" value={draft.host} onChange={(e) => set({ host: e.target.value })} />
            </Field>
            <Field id="smtp-port" label="Port">
              <Input id="smtp-port" inputMode="numeric" value={draft.port} onChange={(e) => set({ port: e.target.value })} />
            </Field>
            <Field id="smtp-security" label="Encryption">
              <select id="smtp-security" className={selectClass} value={draft.security} onChange={(e) => set({ security: e.target.value as SmtpDraft['security'] })}>
                <option value="tls">TLS (465)</option>
                <option value="starttls">STARTTLS (587)</option>
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="smtp-user" label="User name">
              <Input id="smtp-user" autoComplete="off" spellCheck={false} placeholder="you@example.com" value={draft.username} onChange={(e) => set({ username: e.target.value })} />
            </Field>
            <Field id="smtp-from" label="From address">
              <Input id="smtp-from" type="email" autoComplete="off" spellCheck={false} placeholder="you@example.com" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
            </Field>
          </div>
          <Field id="smtp-password" label="App password" note={s ? 'Leave empty to keep the one saved.' : undefined}>
            <Input id="smtp-password" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set({ password: e.target.value })} />
          </Field>
          <Problem text={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save email account'}
            </Button>
            {s && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            {s && !data.destinations.some((d) => d.kind === 'email') && (
              <Button type="button" variant="outline-destructive" disabled={busy} onClick={() => void save(null).then(setError)}>
                Remove email account
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

type Who = 'owner' | 'contact-only' | string;

/** Adds one channel: who it is for, which kind, and its address (secrets typed here are never shown again). */
function AddChannel({ data, busy, add }: { data: NotificationSettings; busy: boolean; add: (d: NotifyDestinationInput) => Promise<string | undefined> }) {
  const [who, setWho] = useState<Who>('owner');
  const [kind, setKind] = useState<NotifyChannelKind>('email');
  const [email, setEmail] = useState('');
  const [server, setServer] = useState(data.defaultNtfyServer);
  const [topic, setTopic] = useState('');
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string>();
  const kinds: NotifyChannelKind[] = who === 'owner' ? ['email', 'ntfy', 'webhook'] : ['email', 'ntfy'];
  const k = kinds.includes(kind) ? kind : 'email';
  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    const problem =
      k === 'email' ? (emailError(email) ?? (!data.smtp ? 'Set up the email account first.' : undefined)) : k === 'ntfy' ? (urlError(server) ?? topicError(topic)) : (urlError(url) ?? webhookSecretError(secret));
    if (problem) return setError(problem);
    const input: NotifyDestinationInput = {
      audience: who === 'owner' ? 'owner' : 'contact',
      kind: k,
      ...(who !== 'owner' && who !== 'contact-only' ? { contact: who } : {}),
      ...(k === 'email' ? { email: email.trim() } : {}),
      ...(k === 'ntfy' ? { ntfy: { server: server.trim(), topic: topic.trim(), ...(token.trim() ? { token: token.trim() } : {}) } } : {}),
      ...(k === 'webhook' ? { webhook: { url: url.trim(), ...(secret ? { secret } : {}) } } : {}),
    };
    setError(undefined);
    const failed = await add(input);
    if (failed) return setError(failed);
    setEmail('');
    setTopic('');
    setToken('');
    setUrl('');
    setSecret('');
  };
  const warn = k === 'ntfy' && topic ? topicWarning(topic, server) : undefined;
  return (
    <form onSubmit={onAdd} noValidate className="flex flex-col gap-3 rounded-lg border px-4 py-3">
      <h3 className="m-0 text-sm leading-5 font-medium">Add a channel</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="add-who" label="For">
          <select id="add-who" className={selectClass} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="owner">You</option>
            {data.contacts.map((c) => (
              <option key={c.pubkey} value={c.pubkey}>
                Alert contact {shortNpub(c.npub)}
              </option>
            ))}
            <option value="contact-only">Someone without a nostr app</option>
          </select>
        </Field>
        <Field id="add-kind" label="Channel">
          <select id="add-kind" className={selectClass} value={k} onChange={(e) => setKind(e.target.value as NotifyChannelKind)}>
            <option value="email">Email</option>
            <option value="ntfy">ntfy push</option>
            {who === 'owner' && <option value="webhook">Webhook (Home Assistant, Apprise, an SMS gateway…)</option>}
          </select>
        </Field>
      </div>
      {who === 'contact-only' && <p className={hint}>They get warnings only: cancelling a recovery and locking the guardian need a nostr app. They are told to contact you.</p>}
      {k === 'email' && (
        <Field id="add-email" label="Email address">
          <Input id="add-email" type="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}
      {k === 'ntfy' && (
        <>
          <Field id="add-ntfy-server" label="ntfy server" note="Best: your own, like the ntfy app on your Umbrel (use the box's address, e.g. http://192.168.1.20:8080).">
            <Input id="add-ntfy-server" inputMode="url" autoComplete="off" spellCheck={false} value={server} onChange={(e) => setServer(e.target.value)} className="font-mono text-[13px]" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="add-ntfy-topic" label="Topic">
              <Input id="add-ntfy-topic" autoComplete="off" spellCheck={false} value={topic} onChange={(e) => setTopic(e.target.value)} className="font-mono text-[13px]" />
            </Field>
            <Field id="add-ntfy-token" label="Access token (optional)">
              <Input id="add-ntfy-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          </div>
          {warn && <p className={cn(hint, 'text-warn')}>{warn}</p>}
        </>
      )}
      {k === 'webhook' && (
        <>
          <Field id="add-webhook-url" label="Address to post to" note="https://, or http:// on your own network (Home Assistant: http://homeassistant.local:8123/api/webhook/…).">
            <Input id="add-webhook-url" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[13px]" />
          </Field>
          <Field id="add-webhook-secret" label="Signing secret (optional)" note="With a secret, every post carries an HMAC-SHA256 signature the receiver can check.">
            <Input id="add-webhook-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </>
      )}
      <Problem text={error} />
      <div>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? 'Adding…' : 'Add channel'}
        </Button>
      </div>
    </form>
  );
}

function ChannelRow({ d, busy, test, remove, locked }: { d: NotifyDestination; busy: boolean; test: () => Promise<string | undefined>; remove: () => Promise<string | undefined>; locked: boolean }) {
  const [note, setNote] = useState<string>();
  return (
    <li className="flex flex-col gap-1.5 border-t py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col">
          <span className="break-all text-[15px] leading-5">{channelLabel(d)}</span>
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {audienceLabel(d, shortNpub)}
            {d.contactInRules === false ? ' (no longer an alert contact: gets nothing)' : ''}
          </span>
          <span className={cn('text-[13px] leading-[18px]', d.health.state === 'failing' ? 'text-bad' : 'text-muted-foreground')}>{healthLabel(d.health, formatDateTime)}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void test().then(setNote)}>
            Send a test message
          </Button>
          <Button variant="outline-destructive" size="sm" disabled={busy || locked} onClick={() => void remove().then(setNote)} aria-label={`Remove ${channelLabel(d)}`}>
            Remove
          </Button>
        </div>
      </div>
      {note && <p className={hint}>{note}</p>}
    </li>
  );
}

/**
 * Settings > Notifications: email (through the owner's own account), ntfy and webhook, for the owner and the alert
 * contacts. Notify-only: they carry warnings, never controls. Every change is announced on every channel and to the
 * phone; while a recovery runs, channels can be added but not removed.
 */
export function NotificationsSection() {
  const settings = useApi(() => api.getNotifications(), [], 30_000);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string>();
  const [nameError, setNameError] = useState<string>();

  if (settings.loading && !settings.data) return <Skeleton className="h-24 w-full" />;
  if (!settings.data) return <ErrorState error={settings.error!} onRetry={settings.reload} title="Couldn't load the notification settings" className="max-w-none" />;
  const data = settings.data;

  const put = async (change: Parameters<typeof settingsInput>[1]): Promise<string | undefined> => {
    setBusy(true);
    try {
      settings.set(await api.setNotifications(settingsInput(data, change)));
      return undefined;
    } catch (e) {
      return e instanceof ApiError ? e.message : 'Could not save the notification settings.';
    } finally {
      setBusy(false);
    }
  };
  const test = async (input: { destination?: string; smtp?: true }): Promise<string> => {
    setBusy(true);
    try {
      const r = await api.testNotification(input);
      settings.reload();
      return r.ok ? 'Sent. Check that it arrived.' : `Not sent: ${r.error ?? 'unknown error'}`;
    } catch (e) {
      return e instanceof ApiError ? e.message : 'Could not send a test message.';
    } finally {
      setBusy(false);
    }
  };
  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    const n = name ?? data.guardianName;
    const problem = guardianNameError(n);
    if (problem) return setNameError(problem);
    const failed = await put({ guardianName: n });
    setNameError(failed);
    if (!failed) setName(undefined);
  };

  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-4">
      <h2 id="notifications-heading" className="m-0 text-base leading-[22px] font-semibold">
        Notifications
      </h2>
      <p className={hint}>
        Besides nostr, the guardian can send its alerts by email, ntfy push or a webhook: to you (your phone may be the one that was stolen) and to your
        alert contacts. These carry warnings only, never a link or a button; cancelling a recovery and locking the guardian stay with nostr. Every
        change here is announced on every channel, before and after, and to your phone.
        {data.pending > 0 ? ` ${data.pending} message${data.pending === 1 ? '' : 's'} waiting to go out (retried for 7 days).` : ''}
      </p>
      {data.recoveryRunning && <p className={cn(hint, 'text-warn')}>A recovery is running: you can add channels, but not remove or change them until it ends.</p>}

      <form onSubmit={saveName} noValidate className="flex flex-col gap-1.5">
        <Label htmlFor="guardian-name">Name in messages</Label>
        <div className="flex gap-2">
          <Input id="guardian-name" maxLength={32} value={name ?? data.guardianName} onChange={(e) => setName(e.target.value)} aria-invalid={nameError ? true : undefined} />
          <Button type="submit" variant="outline" disabled={busy || name === undefined || name === data.guardianName}>
            Save
          </Button>
        </div>
        <Problem text={nameError} />
      </form>

      <EmailAccount data={data} busy={busy} save={(draft) => put({ smtp: draft })} test={() => test({ smtp: true })} />

      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm leading-5 font-medium">Channels</h3>
        {data.destinations.length === 0 ? (
          <p className={hint}>No channels yet: alerts go over nostr only.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {data.destinations.map((d) => (
              <ChannelRow key={d.id} d={d} busy={busy} locked={data.recoveryRunning} test={() => test({ destination: d.id })} remove={() => put({ remove: d.id })} />
            ))}
          </ul>
        )}
      </div>

      <AddChannel data={data} busy={busy} add={(d) => put({ add: d })} />
    </section>
  );
}
