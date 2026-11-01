/**
 * Where the guardian may POST an alert (ntfy servers, webhooks), and the one small HTTP client that does it.
 *
 * The owner sets these URLs in the web UI. Webhooks to devices on the owner's own network are a real use case (Home
 * Assistant, an SMS gateway on the LAN, the ntfy app on the same Umbrel), so internal addresses are allowed, with
 * these rules (docs/design/notifications.md, "Addresses"):
 *
 * - `http:` and `https:` only; no user name or password in the URL, no fragment, at most 512 characters.
 * - Plain `http:` only to the owner's own network: a private IPv4 range (10/8, 172.16/12, 192.168/16, 100.64/10 as
 *   Tailscale uses), an IPv6 unique local address (fc00::/7), or a name that is local by its form (`.local`, `.lan`,
 *   `.home.arpa`, `.internal`, `.home`, or a single label such as a Docker service name). Anything else must be
 *   `https:`, so alert text never crosses the internet in clear.
 * - Never the guardian's own box or the cloud metadata service: loopback (127/8, ::1, `localhost`), "this host"
 *   (0.0.0.0, ::), link-local (169.254/16, fe80::/10, where cloud metadata services live), multicast and reserved
 *   ranges are refused, also when a name RESOLVES to them. `.onion` is refused (the guardian has no Tor).
 * - The name is resolved once per send and the connection goes to the checked address (no second lookup a DNS
 *   rebinding could change); `http:` to a name whose address turns out public is refused.
 * - Redirects are not followed, the answer is read only up to 4 KiB, and a send gives up after 15 seconds.
 *
 * Who could misuse a webhook URL: only someone signed in to the web UI with the unlock passphrase. The most it gives
 * them is a POST of an alert to a host of their choice, which they could make from the box's network anyway.
 */
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const MAX_URL_LENGTH = 512;
export const HTTP_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 4096;

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

/** Test seams: tests talk to servers on 127.0.0.1, which a real guardian refuses. */
export interface NetPolicy {
  allowLoopback?: boolean;
  /** Name resolution (default: the system's). */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

const refusedV4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  refusedV4.addSubnet(net, bits, 'ipv4');
const loopV4 = new BlockList();
loopV4.addSubnet('127.0.0.0', 8, 'ipv4');
const refusedV6 = new BlockList();
for (const [net, bits] of [
  ['::', 128],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const)
  refusedV6.addSubnet(net, bits, 'ipv6');
const loopV6 = new BlockList();
loopV6.addAddress('::1', 'ipv6');
const privateNets = new BlockList();
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const)
  privateNets.addSubnet(net, bits, 'ipv4');
privateNets.addSubnet('fc00::', 7, 'ipv6');

export type AddressClass = 'loopback' | 'refused' | 'private' | 'public';

/** What kind of address `ip` is (IPv4-mapped IPv6 counts as its IPv4 address). */
export function classifyIp(ip: string): AddressClass {
  let addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) addr = mapped[1]!;
  const family = isIP(addr);
  if (family === 4) {
    if (loopV4.check(addr, 'ipv4')) return 'loopback';
    if (refusedV4.check(addr, 'ipv4')) return 'refused';
    return privateNets.check(addr, 'ipv4') ? 'private' : 'public';
  }
  if (family === 6) {
    if (loopV6.check(addr, 'ipv6')) return 'loopback';
    if (refusedV6.check(addr, 'ipv6')) return 'refused';
    return privateNets.check(addr, 'ipv6') ? 'private' : 'public';
  }
  return 'refused';
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.home'];

/** A host name that is on the owner's own network by its form (not resolved). */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return !h.includes('.') || LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

export interface CheckedUrl {
  /** The URL as the guardian stores and uses it. */
  url: string;
  /** `scheme://host[:port]`: what the web UI and the phone may show. */
  origin: string;
  host: string;
  /** On the owner's network by its form (an `http:` URL must be). */
  local: boolean;
}

/** Checks a URL the owner typed for ntfy or a webhook (rules in the file comment). Throws `AddressError` in plain words. */
export function checkHttpUrl(raw: unknown, policy: NetPolicy = {}): CheckedUrl {
  if (typeof raw !== 'string' || !raw.trim()) throw new AddressError('Enter an address that starts with https://.');
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) throw new AddressError(`Use an address of at most ${MAX_URL_LENGTH} characters.`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new AddressError('That is not a web address (it should start with https://).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AddressError('Only https:// (or http:// on your own network) addresses work.');
  if (u.username || u.password) throw new AddressError('Leave the user name and password out of the address (use the token or secret field).');
  if (u.hash) throw new AddressError('Leave out the part after #.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new AddressError('The address needs a host name.');
  if (host.endsWith('.onion')) throw new AddressError('.onion addresses do not work: the guardian does not use Tor.');
  let local: boolean;
  if (isIP(host)) {
    const cls = classifyIp(host);
    if (cls === 'loopback' && !policy.allowLoopback) throw new AddressError('That address is the guardian itself. Use the address of the device on your network.');
    if (cls === 'refused') throw new AddressError('That address cannot receive alerts (it is reserved, link-local or multicast).');
    local = cls === 'private' || cls === 'loopback';
  } else {
    if ((host === 'localhost' || host.endsWith('.localhost')) && !policy.allowLoopback) throw new AddressError('That address is the guardian itself. Use the address of the device on your network.');
    local = isLocalName(host);
  }
  if (u.protocol === 'http:' && !local) throw new AddressError('Use https:// for an address on the internet (http:// works only on your own network).');
  return { url: u.toString(), origin: u.origin, host, local };
}

/** Resolves `host` and checks every address (the second half of the rules: what a name points to). */
async function resolveChecked(u: URL, policy: NetPolicy): Promise<LookupAddress> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs: LookupAddress[] = isIP(host) ? [{ address: host, family: isIP(host) }] : await (policy.resolve ?? ((h) => dnsLookup(h, { all: true, verbatim: true })))(host);
  if (!addrs.length) throw new AddressError(`${host} has no address.`);
  for (const a of addrs) {
    const cls = classifyIp(a.address);
    if (cls === 'loopback' && !policy.allowLoopback) throw new AddressError(`${host} points to the guardian itself.`);
    if (cls === 'refused') throw new AddressError(`${host} points to an address that cannot receive alerts.`);
    if (cls === 'public' && u.protocol === 'http:') throw new AddressError(`${host} is on the internet: use https://.`);
  }
  return addrs[0]!;
}

export interface PostResult {
  status: number;
}

/**
 * POSTs `body` to `url` (already checked with `checkHttpUrl`), resolving and checking the host first, and resolves
 * with the status once the answer's head is in. Throws on a network failure, a timeout, a refused address or a
 * status outside 2xx (a redirect is not followed). Errors carry no URL path or query (they may hold a secret).
 */
export async function postChecked(
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string>,
  opts: NetPolicy & { timeoutMs?: number; ca?: string | Buffer } = {},
): Promise<PostResult> {
  const u = new URL(url);
  const target = await resolveChecked(u, opts);
  const lookup: LookupFunction = (_host, options, cb) => {
    if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [target]);
    else cb(null, target.address, target.family);
  };
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
    method: 'POST',
    headers: { ...headers, 'Content-Length': String(payload.length) },
    lookup,
    timeout: opts.timeoutMs ?? HTTP_TIMEOUT_MS,
    ...(u.protocol === 'https:' ? { minVersion: 'TLSv1.2' as const, ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
  });
  return new Promise<PostResult>((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error('timed out')), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
    const fail = (e: Error) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      reject(new Error(code ? `${code} (${u.host})` : `${e.message} (${u.host})`));
    };
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', fail);
    req.on('response', (res: IncomingMessage) => {
      let seen = 0;
      res.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > MAX_ANSWER_BYTES) res.destroy();
      });
      const done = () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve({ status });
        else if (status >= 300 && status < 400) reject(new Error(`HTTP ${status}: redirects are not followed (${u.host})`));
        else reject(new Error(`HTTP ${status} (${u.host})`));
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.end(payload);
  });
}
