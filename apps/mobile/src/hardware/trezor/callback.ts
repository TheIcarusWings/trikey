/**
 * The Trezor Suite Lite reply link. Suite Lite answers every request by opening `<scheme>://trezor-callback?id=…&response=…`
 * in this app. Any app on the phone, or a web page, can open that link too, so the link alone proves nothing.
 *
 * So every request gets a one-time token: 128 random bits added to the callback address in the request (`&t=…`), which
 * Suite Lite sends back with its answer as it does the `id`. Connect is only given a reply that comes back at exactly
 * the callback address, for a request still waiting, with that request's token. Anything else is dropped: a link opened
 * by another app, a second reply to the same request, or a reply at another path. The reply passed on is rebuilt from
 * the checked `id` and `response` alone, so Connect reads exactly what was checked.
 *
 * What it cannot stop: on Android, an app that also claims the `trikey` scheme can be picked by the owner when the phone
 * asks which app opens the link. That app sees the real reply and its token. What still holds then: every signature from
 * the Trezor is checked against keys the phone knows, the key's path is checked, and the wallet's address is shown on
 * the Trezor and compared before any vault address is used (DESIGN.md, "Trezor").
 */
import { hex } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';

/** How many requests may wait at once (Suite Lite handles one at a time; a cancelled call can leave its entry behind). */
const MAX_PENDING = 16;

/** The value of the first `name=` in a query string, decoded; undefined when absent or badly encoded. */
function param(query: string, name: string): string | undefined {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if ((eq < 0 ? part : part.slice(0, eq)) !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** How many times `name=` appears in a query string (an encoded name counts too). */
function count(query: string, name: string): number {
  let n = 0;
  for (const part of query.split('&')) {
    const key = part.split('=', 1)[0]!;
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* counted as written */
    }
    if (decoded === name) n++;
  }
  return n;
}

export class TrezorCallbackGuard {
  /** Request id (from connect-mobile) to its token. */
  private readonly pending = new Map<string, string>();

  /**
   * @param callback The callback address given to Connect (`trikey://trezor-callback`), without a query.
   * @param token Makes a token; 16 random bytes as hex by default.
   */
  constructor(
    readonly callback: string,
    private readonly token: () => string = () => hex.encode(secureRandomBytes(16)),
  ) {}

  /** Whether a URL is meant for Trezor Connect at all (the callback address, whatever follows it), so the router leaves it. */
  isCallback(url: string): boolean {
    return url === this.callback || url.startsWith(`${this.callback}?`) || url.startsWith(`${this.callback}/`) || url.startsWith(`${this.callback}#`);
  }

  /**
   * The deep link connect-mobile wants to open, with a fresh token added to the callback address in it. Undefined when the
   * link has no callback Trikey can read: then nothing must be opened.
   */
  outgoing(url: string): string | undefined {
    const m = /([?&]callback=)([^&#]*)/.exec(url);
    if (!m) return undefined;
    let callback: string;
    try {
      callback = decodeURIComponent(m[2]!);
    } catch {
      return undefined;
    }
    const q = callback.indexOf('?');
    if (q < 0 || callback.slice(0, q) !== this.callback) return undefined;
    const query = callback.slice(q + 1);
    const id = param(query, 'id');
    if (!id || count(query, 'id') !== 1 || count(query, 't') !== 0) return undefined;
    const token = this.token();
    this.pending.delete(id);
    this.pending.set(id, token);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const withToken = `${callback}&t=${encodeURIComponent(token)}`;
    return url.slice(0, m.index) + m[1] + encodeURIComponent(withToken) + url.slice(m.index + m[0].length);
  }

  /**
   * The reply to hand to Connect, or undefined to drop it. A reply is accepted once: its token is used up.
   * Only `id` and `response` are passed on.
   */
  incoming(url: string): string | undefined {
    if (!url.startsWith(`${this.callback}?`) || url.includes('#')) return undefined;
    const query = url.slice(this.callback.length + 1);
    if (count(query, 'id') !== 1 || count(query, 't') !== 1 || count(query, 'response') > 1) return undefined;
    const id = param(query, 'id');
    const token = param(query, 't');
    if (!id || !token) return undefined;
    const want = this.pending.get(id);
    if (want === undefined || want !== token) return undefined;
    this.pending.delete(id);
    const response = param(query, 'response');
    return `${this.callback}?id=${encodeURIComponent(id)}${response !== undefined ? `&response=${encodeURIComponent(response)}` : ''}`;
  }

  /** Requests still waiting for a reply (for tests). */
  get waiting(): number {
    return this.pending.size;
  }
}
