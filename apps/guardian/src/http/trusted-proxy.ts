/**
 * Who reaches the guardian only through the platform's login (TRIKEY_TRUSTED_PROXY; security review 2026-11, finding 3).
 *
 * On Umbrel every app's containers share one Docker network (`umbrel_main_network`), and the platform's login stands in
 * front of an app only on the platform's own path: since umbrelOS's in-process app gateway (umbreld, `app-gateway.ts`),
 * umbreld on the host proxies `APP_HOST:APP_PORT` and so connects from the host's address on that network, which is the
 * container's default gateway (`10.21.0.1`); before it, a sidecar container `<app-id>_app_proxy_1` did. Any other
 * container on the network connects from its own address. So a request whose socket comes from one of those addresses
 * passed the platform's login, and one from anywhere else did not, whatever its headers say.
 *
 * Entries:
 * - `gateway`: the container's IPv4 default gateway, read from `/proc/net/route` at every check;
 * - a host name (a container name): only for a platform that creates a fixed, legitimate holder of that name before
 *   the guardian starts. A name is checked once at startup (`start`): if it then names no address, or more than one,
 *   it is never trusted while this process runs. On Docker's network any container can take a free name as its
 *   `container_name` or a network alias, and Docker's DNS then answers with exactly its address: a name nothing
 *   legitimate holds is a name another app can claim, and with it skip the setup code and own key 3. Afterwards it is
 *   resolved at every check and trusted only while it names exactly one address in total, IPv4 and IPv6 together:
 *   a second container that claims the same name makes it ambiguous, and then nothing is trusted by that name (fail
 *   closed: the setup code is asked for). The Umbrel package lists `gateway` only;
 * - an IP address.
 *
 * Only the socket's own remote address counts: `X-Forwarded-For` and the like are set by whoever sends the request.
 *
 * What it cannot stop: anything that already acts as the host on that network (a process on the host, or another app
 * on the host's network namespace, `network_mode: host`), or a container that impersonates the gateway's address by
 * spoofing on the bridge. Each of those can also read the plain HTTP between the platform's proxy and the guardian
 * (setup and every unlock), so no check at this layer would stop them; they are outside what this guards.
 */
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { canonicalIp, classifyIp } from '../ip-address.js';
import type { LogFields, Logger } from '../log.js';

export interface TrustedProxyOptions {
  /** Name resolution (default: the system's, which inside a container asks Docker's embedded DNS). Test seam. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  /** `/proc/net/route`'s text (default: read it). Test seam. */
  routes?: () => Promise<string>;
  log?: Logger;
}

/** `::ffff:10.21.0.1` (or `::ffff:a15:1`) → `10.21.0.1`: one spelling per address (`canonicalIp`); anything else lower case, no brackets. */
export function normalizeAddress(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  return canonicalIp(addr) ?? addr.replace(/^\[|\]$/g, '').toLowerCase();
}

/** The IPv4 default gateway in `/proc/net/route` (little-endian hex), or undefined. */
export function defaultGateway(routeTable: string): string | undefined {
  for (const line of routeTable.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    // Iface Destination Gateway Flags ...: the default route has destination 0 and the gateway flag (0x2).
    if (f.length < 4 || f[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2]!) || f[2] === '00000000') continue;
    if ((parseInt(f[3]!, 16) & 0x2) === 0) continue;
    const n = parseInt(f[2]!, 16);
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
  }
  return undefined;
}

/** Whether `addr` is loopback (a process in the guardian's own container). */
export function isLoopback(addr: string | undefined): boolean {
  return !!addr && classifyIp(addr) === 'loopback';
}

export class TrustedProxy {
  private readonly resolve: (host: string) => Promise<LookupAddress[]>;
  private readonly routes: () => Promise<string>;
  private warned = new Set<string>();
  private started?: Promise<void>;
  /** Host names that did not name exactly one address at startup: never trusted while this process runs. */
  private readonly refused = new Set<string>();

  constructor(
    readonly entries: readonly string[],
    private readonly opts: TrustedProxyOptions = {},
  ) {
    this.resolve = opts.resolve ?? ((h) => dnsLookup(h, { all: true, verbatim: true }));
    this.routes = opts.routes ?? (() => readFile('/proc/net/route', 'utf8'));
  }

  private warnOnce(key: string, event: string, fields: LogFields): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.opts.log?.warn(event, fields);
  }

  /** The distinct addresses `name` resolves to now (none when it does not resolve). */
  private async lookup(name: string): Promise<string[]> {
    let found: LookupAddress[];
    try {
      found = await this.resolve(name);
    } catch {
      return [];
    }
    return [...new Set(found.map((a) => normalizeAddress(a.address)).filter((a): a is string => !!a && isIP(a) !== 0))];
  }

  /**
   * Checks every host name once, before the guardian listens (also run by the first check if nobody called it): a
   * name that names no address or more than one now is never trusted while this process runs. Nothing legitimate
   * holds it (anyone could claim it later), or someone already claims it next to its holder.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      for (const e of this.entries) {
        if (e === 'gateway' || isIP(e)) continue;
        const found = await this.lookup(e);
        if (found.length === 1) continue;
        this.refused.add(e);
        this.opts.log?.warn('http.trusted_proxy_name_refused', { name: e, addresses: found.length });
      }
    })();
    return this.started;
  }

  /** The addresses trusted right now (resolved afresh). */
  async addresses(): Promise<Set<string>> {
    await this.start();
    const out = new Set<string>();
    for (const e of this.entries) {
      if (e === 'gateway') {
        const gw = await this.routes().then(defaultGateway, () => undefined);
        if (gw) out.add(gw);
        else this.warnOnce('gateway', 'http.trusted_proxy_no_gateway', {});
        continue;
      }
      if (isIP(e)) {
        out.add(normalizeAddress(e)!);
        continue;
      }
      if (this.refused.has(e)) continue;
      const found = await this.lookup(e);
      // One address in total: an IPv4 and an IPv6 address are two holders as much as two IPv4 addresses are.
      if (found.length > 1) {
        this.warnOnce(`ambiguous:${e}`, 'http.trusted_proxy_ambiguous', { name: e, addresses: found.length });
        continue;
      }
      for (const a of found) out.add(a);
    }
    return out;
  }

  /** Whether a request whose socket comes from `remote` came through the platform's login. */
  async trusts(remote: string | undefined): Promise<boolean> {
    const a = normalizeAddress(remote);
    if (!a) return false;
    return (await this.addresses()).has(a);
  }
}
