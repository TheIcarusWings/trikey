/**
 * The relay editor's checks, the same rules the guardian applies (`checkRelayUrl` / `checkRelayList` in
 * `packages/protocol/src/relay-url.ts`; a guardian test holds the two to the same answers): `wss://` anywhere,
 * `ws://` only on a local or `.onion` host, no credentials or fragment, 1 to 8 relays without duplicates. The
 * guardian checks again; these only give the person a clear message before anything is sent.
 */

/** The most relays the guardian takes. */
export const MAX_RELAYS = 8;

function isLocalOrOnion(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.onion') || host.endsWith('.lan')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A typed relay address, normalised as the guardian stores it, or what is wrong with it in plain words. */
export function normalizeRelayInput(raw: string): { url: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Type a relay address, like wss://relay.example.com.' };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { error: 'That is not a relay address. It starts with wss://.' };
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return { error: 'A relay address starts with wss://.' };
  if (u.protocol === 'ws:' && !isLocalOrOnion(u.hostname))
    return { error: 'ws:// only works for a relay on your own network (or .onion). Use wss:// for anything else.' };
  if (u.username || u.password || u.hash) return { error: 'A relay address cannot hold a user name, a password or a #.' };
  return { url: u.pathname === '/' && !u.search ? `${u.protocol}//${u.host}` : u.toString() };
}

/** Adds `raw` to `list`, or says why it cannot. */
export function addRelay(list: readonly string[], raw: string): { relays: string[] } | { error: string } {
  const r = normalizeRelayInput(raw);
  if ('error' in r) return r;
  if (list.includes(r.url)) return { error: 'That relay is already in the list.' };
  if (list.length >= MAX_RELAYS) return { error: `Use at most ${MAX_RELAYS} relays.` };
  return { relays: [...list, r.url] };
}

/** Why `list` cannot be saved, or undefined when it can. */
export function relayListError(list: readonly string[]): string | undefined {
  if (list.length === 0) return 'Keep at least one relay, or your phone cannot reach this guardian.';
  if (list.length > MAX_RELAYS) return `Use at most ${MAX_RELAYS} relays.`;
  if (new Set(list).size !== list.length) return 'A relay is in the list twice.';
  for (const url of list) {
    const r = normalizeRelayInput(url);
    if ('error' in r) return r.error;
  }
  return undefined;
}

/** True when `a` and `b` hold the same relays, in any order. */
export function sameRelayList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url) => b.includes(url));
}
