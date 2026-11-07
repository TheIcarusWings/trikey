/**
 * Who counts as the platform's login proxy (http/trusted-proxy.ts; security review 2026-11, finding 3), and the
 * TRIKEY_TRUSTED_PROXY and TRIKEY_SETUP_CODE settings that feed it and the setup code.
 */
import { readFileSync } from 'node:fs';
import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseSetupCodeEnv, parseTrustedProxies } from '../../src/config.js';
import { TrustedProxy, defaultGateway, isLoopback, normalizeAddress } from '../../src/http/trusted-proxy.js';

/** Docker's DNS, as a table: a name nobody holds is ENOTFOUND. */
const resolver =
  (names: Record<string, string[]>) =>
  async (h: string): Promise<LookupAddress[]> => {
    if (!names[h]?.length) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return names[h]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

// /proc/net/route of a container on umbrel_main_network (10.21.0.0/16, gateway 10.21.0.1).
const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0100150A\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t0000150A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
].join('\n');

describe('the platform proxy', () => {
  it("reads the container's default gateway (umbrelOS's in-process app gateway connects from it)", () => {
    expect(defaultGateway(ROUTES)).toBe('10.21.0.1');
    expect(defaultGateway(ROUTES.split('\n').filter((l) => !l.includes('0003')).join('\n'))).toBeUndefined();
    expect(defaultGateway('')).toBeUndefined();
  });

  it('trusts the gateway, a name that resolves to one address, and IP addresses; only by the socket address', async () => {
    const names: Record<string, string[]> = { 'trikey-guardian_app_proxy_1': ['10.21.0.9'] };
    const p = new TrustedProxy(['gateway', 'trikey-guardian_app_proxy_1', 'app_proxy_trikey-guardian', '192.0.2.7'], {
      routes: async () => ROUTES,
      resolve: async (h) => {
        if (!names[h]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return names[h]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
    });
    expect(await p.trusts('10.21.0.1')).toBe(true);
    expect(await p.trusts('::ffff:10.21.0.1')).toBe(true);
    expect(await p.trusts('10.21.0.9')).toBe(true);
    expect(await p.trusts('192.0.2.7')).toBe(true);
    // Any other container on the network, and nothing at all.
    expect(await p.trusts('10.21.0.23')).toBe(false);
    expect(await p.trusts(undefined)).toBe(false);
    // Resolved at every check: the proxy restarted with another address.
    names['trikey-guardian_app_proxy_1'] = ['10.21.0.10'];
    expect(await p.trusts('10.21.0.9')).toBe(false);
    expect(await p.trusts('10.21.0.10')).toBe(true);
    // Another container claiming the same name (a network alias) makes it ambiguous: nothing is trusted by it.
    names['trikey-guardian_app_proxy_1'] = ['10.21.0.10', '10.21.0.66'];
    expect(await p.trusts('10.21.0.66')).toBe(false);
    expect(await p.trusts('10.21.0.10')).toBe(false);
    // The gateway entry does not depend on names.
    expect(await p.trusts('10.21.0.1')).toBe(true);
  });

  /**
   * PoC: on umbrelOS 2 nothing holds the old sidecar names (`trikey-guardian_app_proxy_1`, `app_proxy_trikey-guardian`).
   * Another app's container takes one as its `container_name` or network alias, Docker's DNS answers with exactly its
   * address, and the guardian used to trust it: no setup code, so that app ran first-run setup with its own passphrase
   * and owned key 3. A name that named nothing when the guardian started is never trusted while it runs.
   */
  it('PoC: a name nothing held at startup, claimed later by another container, is never trusted', async () => {
    const names: Record<string, string[]> = {};
    const p = new TrustedProxy(['gateway', 'trikey-guardian_app_proxy_1', 'app_proxy_trikey-guardian'], { routes: async () => ROUTES, resolve: resolver(names) });
    // The guardian starts: umbrelOS 2's gateway is trusted; neither name exists.
    expect(await p.trusts('10.21.0.1')).toBe(true);
    // Another app's container claims both names.
    names['trikey-guardian_app_proxy_1'] = ['10.21.0.66'];
    names['app_proxy_trikey-guardian'] = ['10.21.0.66'];
    expect(await p.trusts('10.21.0.66')).toBe(false);
    expect([...(await p.addresses())]).toEqual(['10.21.0.1']);
  });

  it('PoC: the same with start() before the first request (as the guardian does), and the name claimed at startup next to nothing else', async () => {
    const names: Record<string, string[]> = { 'claimed-early': ['10.21.0.66', '10.21.0.67'] };
    const p = new TrustedProxy(['unclaimed', 'claimed-early'], { resolve: resolver(names) });
    await p.start();
    names['unclaimed'] = ['10.21.0.66'];
    names['claimed-early'] = ['10.21.0.67'];
    expect(await p.trusts('10.21.0.66')).toBe(false);
    expect(await p.trusts('10.21.0.67')).toBe(false);
  });

  it('PoC: one IPv4 and one IPv6 address are two holders: nothing is trusted by that name', async () => {
    const names: Record<string, string[]> = { proxy: ['10.21.0.9'] };
    const p = new TrustedProxy(['proxy'], { resolve: resolver(names) });
    expect(await p.trusts('10.21.0.9')).toBe(true);
    // The real holder's IPv4 address, and another container's IPv6 alias on the same name.
    names['proxy'] = ['10.21.0.9', 'fd00:21::66'];
    expect(await p.trusts('fd00:21::66')).toBe(false);
    expect(await p.trusts('10.21.0.9')).toBe(false);
    // The same address twice (IPv4-mapped) is still one holder.
    names['proxy'] = ['10.21.0.9', '::ffff:10.21.0.9'];
    expect(await p.trusts('10.21.0.9')).toBe(true);
    // A name that resolved at startup and is gone for a while trusts nothing meanwhile, and its holder again after.
    names['proxy'] = [];
    expect(await p.trusts('10.21.0.9')).toBe(false);
    names['proxy'] = ['10.21.0.10'];
    expect(await p.trusts('10.21.0.10')).toBe(true);
  });

  it('the Umbrel package trusts the gateway only', () => {
    const compose = readFileSync(new URL('../../../../packaging/umbrel/trikey-guardian/docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/^\s*TRIKEY_TRUSTED_PROXY: gateway$/m);
  });

  it('without a route table, the gateway entry trusts nothing', async () => {
    const p = new TrustedProxy(['gateway'], { routes: async () => Promise.reject(new Error('ENOENT')) });
    expect(await p.trusts('10.21.0.1')).toBe(false);
  });

  it('loopback is the guardian’s own container', () => {
    for (const a of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true);
    for (const a of ['10.21.0.1', '::ffff:10.0.3.1', 'fe80::1', undefined]) expect(isLoopback(a), String(a)).toBe(false);
    expect(normalizeAddress('[::FFFF:10.21.0.1]')).toBe('10.21.0.1');
  });
});

describe('settings', () => {
  it('TRIKEY_TRUSTED_PROXY: gateway, host names and IP addresses', () => {
    expect(parseTrustedProxies(undefined)).toBeUndefined();
    expect(parseTrustedProxies(' gateway, trikey-guardian_app_proxy_1 ,10.21.0.2,[fd00::1]')).toEqual(['gateway', 'trikey-guardian_app_proxy_1', '10.21.0.2', 'fd00::1']);
    for (const bad of ['http://proxy', 'a b', 'proxy:80']) expect(() => parseTrustedProxies(bad), bad).toThrow(/TRIKEY_TRUSTED_PROXY/);
    expect(loadConfig({ TRIKEY_PLATFORM: 'umbrel', TRIKEY_TRUSTED_PROXY: 'gateway' }).trustedProxies).toEqual(['gateway']);
    expect(loadConfig({}).trustedProxies).toBeUndefined();
  });

  it('TRIKEY_SETUP_CODE: 16 Crockford base32 characters, as typed', () => {
    expect(parseSetupCodeEnv('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(parseSetupCodeEnv(undefined)).toBeUndefined();
    for (const bad of ['short', 'ABCD-EFGH-JKMN-PQRU', 'ABCD-EFGH-JKMN-PQRS-T']) expect(() => parseSetupCodeEnv(bad), bad).toThrow(/TRIKEY_SETUP_CODE/);
    expect(loadConfig({ TRIKEY_PLATFORM: 'start9', TRIKEY_SETUP_CODE: 'ABCD EFGH JKMN PQRS' }).setupCode).toBe('ABCDEFGHJKMNPQRS');
  });
});
