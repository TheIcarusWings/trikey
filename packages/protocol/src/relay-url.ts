/**
 * Relay URLs as Trikey accepts them: in the pairing and recovery codes, at the guardian's setup and relay
 * change, and in the `relays_changed` alert. No imports, so the schemas can use it without a cycle.
 */

/** The most relays a guardian uses (and a pairing or recovery code carries). */
export const MAX_RELAYS = 8;

function isLocalOrOnion(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.onion') || host.endsWith('.lan')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Checks and normalises a relay URL: `wss://` anywhere, `ws://` only for local network or `.onion` hosts, no
 * credentials or fragment. Returns the normalised URL, or why it is refused.
 */
export function checkRelayUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: `invalid relay URL: ${raw}` };
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return { error: `relay must be ws(s): ${raw}` };
  if (u.protocol === 'ws:' && !isLocalOrOnion(u.hostname)) return { error: `insecure ws:// relay only allowed for local hosts: ${raw}` };
  if (u.username || u.password || u.hash) return { error: `relay URL must not carry credentials or fragment: ${raw}` };
  // `URL` adds a trailing slash to bare origins; drop it so URLs stay as the user wrote them.
  return { url: u.pathname === '/' && !u.search ? `${u.protocol}//${u.host}` : u.toString() };
}

/** True when `s` is a relay URL exactly as `checkRelayUrl` writes it. */
export function isNormalizedRelayUrl(s: string): boolean {
  const r = checkRelayUrl(s);
  return 'url' in r && r.url === s;
}

/**
 * A relay list as the guardian keeps it: 1 to `MAX_RELAYS` entries, each normalised, duplicates dropped (the
 * first spelling wins). The same rules for setup, a relay change and the phone taking a list from its guardian.
 * Returns why it is refused otherwise.
 */
export function checkRelayList(input: unknown): { relays: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RELAYS) return { error: `Choose between 1 and ${MAX_RELAYS} relays.` };
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.length > 512) return { error: 'Each relay must be a URL.' };
    const r = checkRelayUrl(raw.trim());
    if ('error' in r) return r;
    if (!out.includes(r.url)) out.push(r.url);
  }
  return { relays: out };
}

/** The same relays, in any order. */
export function sameRelays(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((r) => sb.has(r));
}
