/**
 * The guardian's extra alert channels (email, ntfy push, webhook) as Settings > Alert contacts shows them
 * (docs/design/notifications.md). They are set up in the guardian's web page, never on the phone: read-only here.
 */
import type { AlertChannel, AlertChannels } from './types';

/** What the guardian lists (`TrikeyWallet.notificationChannels`), grouped: yours, per contact, and people without nostr. */
export function groupAlertChannels(channels: readonly { kind: AlertChannel['kind']; audience: 'owner' | 'contact'; contact?: string; hint: string; failing?: boolean }[]): AlertChannels {
  const out: AlertChannels = { you: [], byContact: {}, withoutNostr: [] };
  for (const c of channels) {
    const ch: AlertChannel = { kind: c.kind, hint: c.hint, ...(c.failing ? { failing: true } : {}) };
    if (c.audience === 'owner') out.you.push(ch);
    else if (c.contact) (out.byContact[c.contact] ??= []).push(ch);
    else out.withoutNostr.push(ch);
  }
  return out;
}

const KIND: Record<AlertChannel['kind'], string> = { email: 'Email', ntfy: 'ntfy', webhook: 'Webhook' };

/** One channel in words: "Email m…@example.com", "ntfy (ntfy.example.com)", with "not reaching them" when failing. */
export function alertChannelText(c: AlertChannel): string {
  const what = c.kind === 'email' ? `${KIND.email} ${c.hint}` : `${KIND[c.kind]} (${c.hint})`;
  return c.failing ? `${what}, not getting through` : what;
}

/** A list of channels in one line ("Also by email m…@example.com and ntfy (ntfy.example.com)"). */
export function alertChannelsLine(list: readonly AlertChannel[], lead = 'Also by'): string {
  const parts = list.map((c) => (c.kind === 'email' ? `email ${c.hint}` : `${KIND[c.kind]} (${c.hint})`) + (c.failing ? ', not getting through' : ''));
  if (!parts.length) return '';
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${lead} ${joined}`;
}

export const ALERT_CHANNELS = {
  title: 'Email and push alerts',
  where: "Set up in your guardian's web page, under Settings, Notifications.",
  limits: 'Email, ntfy and webhooks carry warnings only, never links. Cancelling a recovery and locking the guardian stay with nostr.',
  safety: "This phone can't change them, so a stolen phone can't silence them. Every change is announced on every channel.",
  withoutNostr: 'Without a nostr app: warnings only, told to contact you.',
} as const;
