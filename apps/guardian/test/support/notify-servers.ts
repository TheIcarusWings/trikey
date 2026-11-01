/**
 * Local servers for the notification tests: an in-process SMTP server (smtp-server, with implicit TLS or STARTTLS and
 * its built-in self-signed test certificate) and a plain HTTP server standing in for ntfy and webhook receivers. They
 * listen on 127.0.0.1 only; nothing leaves the machine. Throwaway credentials only.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

export interface ReceivedMail {
  from: string;
  to: string[];
  headers: Record<string, string>;
  subject: string;
  text: string;
  secure: boolean;
  user?: string;
}

/** Content-Transfer-Encoding as nodemailer writes it (7bit, quoted-printable, base64), decoded to UTF-8 text. */
function decodeBody(body: string, encoding: string): string {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const soft = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] === '=' && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
        bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return body;
}

/** Splits a single-part message into headers (unfolded, lowercase names) and its decoded text. */
export function parseMail(raw: string): { headers: Record<string, string>; text: string } {
  const sep = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, sep).replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const text = decodeBody(raw.slice(sep + 4), headers['content-transfer-encoding'] ?? '7bit').replace(/\r\n/g, '\n').replace(/\n$/, '');
  return { headers, text };
}

export interface TestSmtp {
  port: number;
  mails: ReceivedMail[];
  /** Refuse every login from now on (as after the owner revoked the app password). */
  failAuth: boolean;
  stop(): Promise<void>;
}

/** An SMTP server on 127.0.0.1: `secure` for implicit TLS, else STARTTLS (unless `noStartTls`). Accepts `user` / `pass`. */
export async function startSmtp(opts: { secure?: boolean; noStartTls?: boolean; user?: string; pass?: string } = {}): Promise<TestSmtp> {
  const user = opts.user ?? 'owner@example.com';
  const pass = opts.pass ?? 'test app password';
  const state: TestSmtp = {
    port: 0,
    mails: [],
    failAuth: false,
    stop: async () => {},
  };
  const server = new SMTPServer({
    secure: !!opts.secure,
    ...(opts.noStartTls ? { hideSTARTTLS: true, disabledCommands: ['STARTTLS'] } : {}),
    logger: false,
    onAuth(auth, _session, cb) {
      if (!state.failAuth && auth.username === user && auth.password === pass) cb(null, { user });
      else cb(new Error('Invalid username or password'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const { headers, text } = parseMail(Buffer.concat(chunks).toString('utf8'));
        state.mails.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          headers,
          subject: headers.subject ?? '',
          text,
          secure: session.secure,
          user,
        });
        cb();
      });
    },
  });
  // A client that gives up mid-handshake (a refused certificate) is an error on the server's side: expected here.
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.server.address() as AddressInfo).port;
  state.stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface TestHttp {
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
  requests: ReceivedRequest[];
  /** The status every request gets from now on (default 200). */
  status: number;
  /** A `Location` header to send with a 3xx status. */
  location?: string;
  stop(): Promise<void>;
}

/** An HTTP server on 127.0.0.1 that records every request (an ntfy server, a webhook receiver). */
export async function startHttp(): Promise<TestHttp> {
  let server: Server;
  const state: TestHttp = { port: 0, url: '', requests: [], status: 200, stop: async () => {} };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(state.status, { 'Content-Type': 'application/json', ...(state.location ? { Location: state.location } : {}) });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return state;
}
