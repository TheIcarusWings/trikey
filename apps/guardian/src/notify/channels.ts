/**
 * The three senders: email through the owner's own account (SMTP), ntfy, and a generic webhook. Each takes a finished
 * `Message` (render.ts) and either resolves (the server took it) or throws an error in short plain words, never with
 * a secret in it. Retries, rate limits and bookkeeping are the notifier's (notifier.ts).
 *
 * Email: nodemailer (pinned, see docs/design/notifications.md "Dependencies"), plain text only, TLS always: implicit
 * TLS (`tls`, usually port 465) or STARTTLS that must succeed (`starttls`, usually 587); certificates are verified, at
 * least TLS 1.2; no file or URL access in messages. With a pinned certificate (`SmtpAccount.pin`, for Proton Mail
 * Bridge and other servers with a self-signed one) exactly that certificate is accepted instead of the public CAs.
 * ntfy: JSON publishing (`POST <server>/` with the topic in the body), so the title and text may hold any character,
 * with the access token as a bearer token. Webhook: the JSON payload below, signed with HMAC-SHA256 when a secret is
 * set.
 */
import { createHash, createHmac } from 'node:crypto';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate } from 'node:tls';
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
  /** A pinned certificate: the only one accepted (instead of the public CAs). Absent: public CA verification. */
  pin?: SmtpPin;
}

/**
 * A pinned server certificate (settings.ts `checkPin` makes it from what the owner pastes): its SHA-256 fingerprint in
 * Node's form (`AB:CD:...`, 32 bytes) and, when the owner pasted the certificate itself, the certificate (PEM).
 */
export interface SmtpPin {
  sha256: string;
  pem?: string;
}

/** Test seam: the in-process test SMTP server has a self-signed certificate. Never set in production. */
export interface SmtpTestOptions {
  tls?: ConnectionOptions;
}

const CERT_ERROR = /cert|self.signed|issuer|unable to verify/i;

/** Short words for an SMTP failure: nodemailer's code and the server's reply line, without credentials. */
function smtpError(e: unknown, pinned: boolean): Error {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const reply = (err.response ?? err.message ?? 'failed').replace(/[\r\n]+/g, ' ').slice(0, 160);
  if (err instanceof PinError) return err;
  if (pinned && !err.response && (CERT_ERROR.test(err.message ?? '') || CERT_ERROR.test(err.code ?? '')))
    return new Error(/expired/i.test(reply) ? `The pinned certificate has expired: pin the server's new one (${reply})` : `The email server's certificate is not the pinned one (${reply})`);
  const code = err.code === 'EAUTH' ? 'The email server refused the user name or app password' : err.code === 'ETLS' ? 'TLS failed' : err.code;
  return new Error(code ? `${code}: ${reply}` : reply);
}

/** The server showed a certificate other than the pinned one. Says which, so the owner can compare. */
class PinError extends Error {
  constructor(seen: string) {
    super(`The email server's certificate is not the pinned one: it shows SHA-256 ${seen}`);
    this.name = 'PinError';
  }
}

/** SHA-256 of a DER certificate in Node's fingerprint form: uppercase hex pairs joined by colons. */
const fingerprint256 = (der: Buffer): string =>
  createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?!$)/g, '$1:');

const derToPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

/** Certificates fetched for a fingerprint-only pin and found to match it, by fingerprint (a match is that certificate). */
const fetchedPins = new Map<string, string>();

/**
 * The certificate the server shows, for a pin given only as a fingerprint (TLS can trust a certificate, not a hash).
 * A separate connection that only looks: it reads the certificate and closes, before any login (no user name or
 * password goes over it), so it accepts whatever the server shows; the caller compares the fingerprint, and the real
 * connection then trusts exactly that certificate. For STARTTLS it speaks just enough SMTP (greeting, EHLO, STARTTLS).
 */
async function fetchServerCertificate(account: SmtpAccount): Promise<Buffer> {
  const servername = isIP(account.host) ? undefined : account.host;
  return new Promise<Buffer>((resolve, reject) => {
    let open: Socket | undefined;
    let settled = false;
    const done = (err: Error | undefined, der?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      open?.destroy();
      if (err) reject(err);
      else resolve(der!);
    };
    const timer = setTimeout(() => done(new Error('The email server did not answer in time')), SMTP_TIMEOUT_MS);
    const handshake = (socket?: Socket) => {
      // rejectUnauthorized false: this connection only reads the certificate (see above); nothing is sent over it.
      const t = tlsConnect({ ...(socket ? { socket } : { host: account.host, port: account.port }), ...(servername ? { servername } : {}), minVersion: 'TLSv1.2', rejectUnauthorized: false }, () => {
        const cert: PeerCertificate = t.getPeerCertificate();
        if (!cert?.raw) done(new Error('The email server showed no certificate'));
        else done(undefined, cert.raw);
      });
      open = t; // from now on the TLS socket owns the plain one (destroying that under it would crash Node)
      t.on('error', (e) => done(new Error(`TLS failed: ${e.message}`)));
    };
    if (account.security === 'tls') return handshake();
    // STARTTLS: wait for each complete reply (its last line is "NNN text"), check its code, send the next command.
    const steps: { expect: string; send?: string }[] = [{ expect: '220', send: 'EHLO [127.0.0.1]\r\n' }, { expect: '250', send: 'STARTTLS\r\n' }, { expect: '220' }];
    let buf = '';
    const sock = netConnect({ host: account.host, port: account.port });
    open = sock;
    sock.setEncoding('latin1');
    sock.on('error', (e) => done(new Error(`Could not reach the email server: ${e.message}`)));
    const onData = (chunk: string) => {
      buf += chunk;
      if (buf.length > 65_536) return done(new Error('The email server sent too much before STARTTLS'));
      for (;;) {
        const m = /(?:^|\r?\n)(\d{3}) [^\r\n]*\r?\n/.exec(buf);
        if (!m) return;
        buf = buf.slice(m.index + m[0].length);
        const step = steps.shift()!;
        if (m[1] !== step.expect) return done(new Error(`The email server refused STARTTLS (${m[1]})`));
        if (step.send) sock.write(step.send);
        else {
          sock.removeListener('data', onData);
          return handshake(sock);
        }
      }
    };
    sock.on('data', onData);
  });
}

/**
 * TLS options for a pinned certificate: it is the only CA (no public one), and the certificate shown must be exactly it
 * (same SHA-256). The host name is not checked against it: the exact certificate is a stronger match, and a Bridge's
 * certificate names 127.0.0.1 while the guardian reaches it by another address.
 */
async function pinnedTls(account: SmtpAccount, pin: SmtpPin): Promise<ConnectionOptions> {
  let pem = pin.pem ?? fetchedPins.get(pin.sha256);
  if (!pem) {
    const der = await fetchServerCertificate(account);
    const seen = fingerprint256(der);
    if (seen !== pin.sha256) throw new PinError(seen);
    pem = derToPem(der);
    if (fetchedPins.size > 16) fetchedPins.clear();
    fetchedPins.set(pin.sha256, pem);
  }
  return {
    ca: [pem],
    checkServerIdentity: (_host: string, cert: PeerCertificate) => (cert.fingerprint256 === pin.sha256 ? undefined : new PinError(cert.fingerprint256)),
  };
}

export async function sendEmail(account: SmtpAccount, to: string, msg: Message, meta: { guardianName: string; type: string }, test: SmtpTestOptions = {}): Promise<void> {
  let pinned: ConnectionOptions = {};
  if (account.pin) {
    try {
      pinned = await pinnedTls(account, account.pin);
    } catch (e) {
      throw smtpError(e, true);
    }
  }
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
    tls: { minVersion: 'TLSv1.2', ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true, ...pinned, ...test.tls },
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
    throw smtpError(e, !!account.pin);
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
