/**
 * The session's secret, the half of a web session the browser never sends by itself (API.md, "Deployment and
 * sessions"; apps/guardian/src/http/sessions.ts).
 *
 * Why: cookies are bound to the host, not to the port. On Umbrel every app is `http://umbrel.local:<port>`, so the
 * browser sends the guardian's session cookie to every other app the owner opens, and that app's server could replay
 * it. So the guardian also answers each sign-in with a `sessionSecret` and wants it back in the `X-Trikey-Session`
 * header on every request. It is kept here, in `sessionStorage`: scoped to scheme, host and port (no other app reads
 * it), kept across reloads of this tab, gone when the tab closes.
 *
 * A new tab of the same guardian has an empty `sessionStorage`. It asks the guardian's other open tabs for the secret
 * over a `BroadcastChannel`, which also only joins pages of this exact origin (scheme, host and port); if none answers
 * within a moment, the page shows the sign-in screen. Deliberately not a server endpoint that hands the secret to
 * whoever has the cookie: another app on the same host has the cookie too, and its server can set any header
 * (`Sec-Fetch-Site`, `Origin`), so such an endpoint would give the secret to exactly the app it is meant to stop.
 */

export const SESSION_HEADER = 'X-Trikey-Session';
export const SESSION_STORAGE_KEY = 'trikey.sessionSecret';
export const SESSION_CHANNEL = 'trikey-session';
/** How long a new tab waits for another tab's answer before it shows the sign-in screen. */
export const SESSION_ASK_MS = 300;

/** What the guardian sends: 32 random bytes, base64url. Anything else from storage or a message is ignored. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

type Message = { type: 'ask' } | { type: 'secret'; secret: string };

/** The part of `Storage` used here (`sessionStorage`). */
export interface SecretStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `BroadcastChannel` used here. */
export interface SecretChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

export interface SessionSecretOptions {
  /** Default: none (an in-memory secret for this page only). */
  storage?: SecretStorage | null;
  /** Default: none (no hand-off between tabs). */
  channel?: SecretChannel | null;
  askMs?: number;
}

export class SessionSecret {
  private memory: string | undefined;
  private readonly storage: SecretStorage | null;
  private readonly channel: SecretChannel | null;
  private readonly askMs: number;
  private asking: Promise<void> | undefined;
  private answered: (() => void) | undefined;

  constructor(opts: SessionSecretOptions = {}) {
    this.storage = opts.storage ?? null;
    this.channel = opts.channel ?? null;
    this.askMs = opts.askMs ?? SESSION_ASK_MS;
    this.memory = this.read();
    if (this.channel) this.channel.onmessage = (e) => this.onMessage(e.data);
  }

  private read(): string | undefined {
    try {
      const v = this.storage?.getItem(SESSION_STORAGE_KEY);
      return v && SECRET_RE.test(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private store(secret: string | undefined): void {
    this.memory = secret;
    try {
      if (secret) this.storage?.setItem(SESSION_STORAGE_KEY, secret);
      else this.storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* storage refused (private mode, quota): this page keeps it in memory */
    }
  }

  private post(m: Message): void {
    try {
      this.channel?.postMessage(m);
    } catch {
      /* closed */
    }
  }

  private onMessage(data: unknown): void {
    const m = data as Partial<Message> | null;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ask') {
      if (this.memory) this.post({ type: 'secret', secret: this.memory });
      return;
    }
    // Another tab signed in (the browser's cookie is now its session's), or answered this tab's question.
    if (m.type === 'secret' && typeof m.secret === 'string' && SECRET_RE.test(m.secret)) {
      this.store(m.secret);
      this.answered?.();
    }
  }

  /** The secret, if this tab has one; without one, first asks the other tabs (once, until `forget`). */
  async current(): Promise<string | undefined> {
    if (this.memory || !this.channel) return this.memory;
    this.asking ??= new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.askMs);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.answered = undefined;
        resolve();
      }
      this.answered = done;
      this.post({ type: 'ask' });
    });
    await this.asking;
    return this.memory;
  }

  /** A sign-in answered with a new secret: keep it, and tell the other tabs (they share the browser's one cookie). */
  remember(secret: string): void {
    if (!SECRET_RE.test(secret)) return;
    this.store(secret);
    this.post({ type: 'secret', secret });
  }

  /** Signed out, or the guardian no longer knows the session: drop it. The next request asks the other tabs again. */
  forget(): void {
    this.store(undefined);
    this.asking = undefined;
  }

  close(): void {
    this.channel?.close?.();
  }
}

/** The page's own store: `sessionStorage` and a `BroadcastChannel` where the browser has them. */
export function browserSessionSecret(): SessionSecret {
  let storage: SecretStorage | null = null;
  let channel: SecretChannel | null = null;
  try {
    if (typeof document !== 'undefined' && typeof sessionStorage !== 'undefined') storage = sessionStorage;
  } catch {
    storage = null; // storage blocked by the browser's settings
  }
  try {
    if (typeof document !== 'undefined' && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(SESSION_CHANNEL) as unknown as SecretChannel;
  } catch {
    channel = null;
  }
  return new SessionSecret({ storage, channel });
}

let page: SessionSecret | undefined;

/** The one store of this page (made on first use). */
export function pageSessionSecret(): SessionSecret {
  return (page ??= browserSessionSecret());
}
