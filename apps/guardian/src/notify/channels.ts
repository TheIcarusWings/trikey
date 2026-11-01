/**
 * The three senders: email through the owner's own account (SMTP), ntfy, and a generic webhook. Each takes a finished
 * `Message` (render.ts) and either resolves (the server took it) or throws an error in short plain words, never with
 * a secret in it. Retries, rate limits and bookkeeping are the notifier's (notifier.ts).
 *
 * Email: nodemailer (pinned, see docs/design/notifications.md "Dependencies"), plain text only, TLS always: implicit
 * TLS (`tls`, usually port 465) or STARTTLS that must succeed (`starttls`, usually 587); certificates are verified, at
 * least TLS 1.2; no file or URL access in messages. ntfy: JSON publishing (`POST <server>/` with the topic in the
 * body), so the title and text may hold any character, with the access token as a bearer token. Webhook: the JSON
 * payload below, signed with HMAC-SHA256 when a secret is set.
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { createTransport } from 'nodemailer';
import { postChecked, type NetPolicy } from './net.js';
import type { Message, Priority } from './render.js';

export const SMTP_TIMEOUT_MS = 15_000;

export interface SmtpAccount {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  password: string;
  from: string;
}

/** Test seam: the in-process test SMTP server has a self-signed certificate. Never set in production. */
export interface SmtpTestOptions {
  tls?: ConnectionOptions;
}

/** Short words for an SMTP failure: nodemailer's code and the server's reply line, without credentials. */
function smtpError(e: unknown): Error {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const reply = (err.response ?? err.message ?? 'failed').replace(/[\r\n]+/g, ' ').slice(0, 160);
  const code = err.code === 'EAUTH' ? 'The email server refused the user name or app password' : err.code === 'ETLS' ? 'TLS failed' : err.code;
  return new Error(code ? `${code}: ${reply}` : reply);
}

export async function sendEmail(account: SmtpAccount, to: string, msg: Message, meta: { guardianName: string; type: string }, test: SmtpTestOptions = {}): Promise<void> {
  const transport = createTransport({
    host: account.host,
    port: account.port,
    secure: account.security === 'tls',
    requireTLS: account.security === 'starttls',
    ignoreTLS: false,
    auth: { user: account.username, pass: account.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: 2 * SMTP_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { minVersion: 'TLSv1.2', ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true, ...test.tls },
  });
  try {
    await transport.sendMail({
      from: { name: meta.guardianName, address: account.from },
      to,
      subject: msg.title,
      text: msg.body,
      priority: msg.priority === 'urgent' || msg.priority === 'high' ? 'high' : 'normal',
      headers: { 'X-Trikey-Alert': meta.type },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch (e) {
    throw smtpError(e);
  } finally {
    transport.close();
  }
}

export const NTFY_PRIORITY: Record<Priority, number> = { urgent: 5, high: 4, default: 3, low: 2 };

export interface NtfyTarget {
  server: string;
  topic: string;
  token?: string;
}

export async function sendNtfy(target: NtfyTarget, msg: Message, meta: { type: string }, policy: NetPolicy = {}): Promise<void> {
  const url = target.server.endsWith('/') ? target.server : `${target.server}/`;
  const body = JSON.stringify({ topic: target.topic, title: msg.title, message: msg.body, priority: NTFY_PRIORITY[msg.priority], tags: ['trikey', meta.type], markdown: false });
  await postChecked(url, body, { 'Content-Type': 'application/json', 'User-Agent': 'TrikeyGuardian', ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) }, policy);
}

/**
 * The webhook's JSON body (version 1). Documented in docs/design/notifications.md ("Webhook payload") for Home
 * Assistant, Apprise, SMS gateways and the like. `id` is the same on every retry of one delivery, so a receiver can
 * drop repeats.
 */
export interface WebhookPayload {
  version: 1;
  id: string;
  /** The alert type (`recovery_started`, `limit_off`, ..., `notifications_changed`, `test`). */
  type: string;
  /** The guardian's name, as the owner set it. */
  guardian: string;
  /** The first 8 characters of the wallet id, when the alert is about a wallet. */
  wallet?: string;
  /** When it happened, ISO 8601 UTC. */
  time: string;
  title: string;
  /** Plain text, no links. */
  message: string;
  priority: Priority;
}

export const SIGNATURE_HEADER = 'X-Trikey-Signature';
export const TIMESTAMP_HEADER = 'X-Trikey-Timestamp';

/** `sha256=<hex>` of HMAC-SHA256(secret, `<timestamp>.<body>`): what `X-Trikey-Signature` carries. */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

export interface WebhookTarget {
  url: string;
  secret?: string;
}

export async function sendWebhook(target: WebhookTarget, payload: WebhookPayload, now: number, policy: NetPolicy = {}): Promise<void> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(now / 1000);
  await postChecked(
    target.url,
    body,
    {
      'Content-Type': 'application/json',
      'User-Agent': 'TrikeyGuardian',
      'X-Trikey-Event': payload.type,
      'X-Trikey-Delivery': payload.id,
      [TIMESTAMP_HEADER]: String(ts),
      ...(target.secret ? { [SIGNATURE_HEADER]: webhookSignature(target.secret, ts, body) } : {}),
    },
    policy,
  );
}
