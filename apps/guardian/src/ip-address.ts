/**
 * The one place the guardian decides what kind of network address a host is: the notification URLs
 * (`notify/net.ts`), Electrum and Bitcoin Core (`chain/`), the trusted proxy (`http/trusted-proxy.ts`) and the
 * contacts' DM inbox relays (`nostr/dm.ts`) all ask here.
 *
 * Every check first writes the address one way (`canonicalIp`), so another spelling of the same address cannot get
 * past a list: brackets and an IPv6 zone (`%eth0`) are dropped; an IPv4-mapped IPv6 address, also in its hex form
 * (`::ffff:7f00:1`, which is how `new URL` writes `[::ffff:127.0.0.1]`), is its IPv4 address; an IPv4 shorthand
 * (`127.1`, `2130706433`, `0x7f.1`), which the system resolver also accepts, is written out. Up to 0.1.22 only the
 * dotted `::ffff:a.b.c.d` was unwrapped, so `https://[::ffff:7f00:1]/` counted as a public address (security sweep 2).
 */
import { BlockList, isIP } from 'node:net';

export type AddressClass = 'loopback' | 'refused' | 'private' | 'public';

/**
 * `raw` as one canonical IP address (see the file comment), or undefined when it is not an IP address. IPv6 comes out
 * as `new URL` writes it (lower case, longest run of zeros compressed).
 */
export function canonicalIp(raw: string): string | undefined {
  const a = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(a);
  if (family === 4) return a;
  if (family === 6) {
    let v6: string;
    try {
      v6 = new URL(`http://[${a.replace(/%.*$/, '')}]`).hostname.slice(1, -1);
    } catch {
      return undefined;
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (!mapped) return v6;
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // IPv4 shorthand: only digits, dots and hex, and only when the URL parser reads it as an IPv4 address.
  if (!/^[0-9a-fx.]+$/.test(a)) return undefined;
  try {
    const host = new URL(`http://${a}/`).hostname;
    return isIP(host) === 4 ? host : undefined;
  } catch {
    return undefined;
  }
}

function list(entries: readonly (readonly [string, number])[]): BlockList {
  const b = new BlockList();
  for (const [net, bits] of entries) b.addSubnet(net, bits, isIP(net) === 4 ? 'ipv4' : 'ipv6');
  return b;
}

const loopback = list([
  ['127.0.0.0', 8],
  ['::1', 128],
]);
const refused = list([
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  // "This host" (::), and the deprecated IPv4-compatible ::a.b.c.d (::1 is loopback, checked first).
  ['::', 96],
  // IPv4-translated (SIIT): an IPv4 address behind a translator.
  ['::ffff:0:0:0', 96],
  ['100::', 64],
  // NAT64: well-known and local-use prefixes, an IPv4 address of the translator's choosing.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]);
const privateNets = list([
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['fc00::', 7],
]);
const linkLocal = list([
  ['169.254.0.0', 16],
  ['fe80::', 10],
]);

const check = (b: BlockList, ip: string) => b.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');

/**
 * What kind of address `ip` is, in any spelling (`canonicalIp`): `loopback` (127/8, ::1), `refused` ("this host",
 * link-local, multicast, reserved, NAT64, or not an IP address at all), `private` (10/8, 172.16/12, 192.168/16,
 * 100.64/10, fc00::/7) or `public`.
 */
export function classifyIp(ip: string): AddressClass {
  const a = canonicalIp(ip);
  if (!a) return 'refused';
  if (check(loopback, a)) return 'loopback';
  if (check(refused, a)) return 'refused';
  return check(privateNets, a) ? 'private' : 'public';
}

/** 169.254/16 or fe80::/10, in any spelling. */
export function isLinkLocalIp(ip: string): boolean {
  const a = canonicalIp(ip);
  return !!a && check(linkLocal, a);
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.home'];

/** A host name that is on the owner's own network by its form (not resolved). */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return !h.includes('.') || LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}
