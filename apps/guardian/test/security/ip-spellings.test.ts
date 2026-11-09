/**
 * Security sweep 2, finding 31 (LOW): every address check in the guardian unwrapped only the dotted IPv4-mapped form
 * (`::ffff:127.0.0.1`). `new URL` writes it in hex (`[::ffff:7f00:1]`), so `https://[::ffff:7f00:1]/` was a "public"
 * address for a webhook or ntfy URL, `::ffff:a9fe:a9fe` (169.254.169.254) was not link-local for Bitcoin Core, and
 * local-use NAT64 or IPv4-compatible addresses passed as public. Now `ip-address.ts` writes every address one way
 * first and is the one list the notification URLs, the chain clients, the trusted proxy and the DM relays use.
 */
import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { canonicalIp, classifyIp, isLinkLocalIp } from '../../src/ip-address.js';
import { AddressError, checkHttpUrl, postChecked } from '../../src/notify/net.js';
import { isLocalAddress } from '../../src/chain/electrum.js';
import { isLinkLocal } from '../../src/chain/bitcoind.js';
import { TrustedProxy, isLoopback, normalizeAddress } from '../../src/http/trusted-proxy.js';
import { isPublicDmRelay } from '../../src/nostr/dm.js';

describe('security: one spelling per address (sweep 2 #31)', () => {
  it('writes the spellings of one address the same way', () => {
    for (const s of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1', '127.1', '2130706433', '0x7f.1'])
      expect(canonicalIp(s), s).toBe('127.0.0.1');
    expect(canonicalIp('0:0::1')).toBe('::1');
    expect(canonicalIp('FE80::1%eth0')).toBe('fe80::1');
    for (const s of ['relay.example', 'cafe', 'dead.beef', '', '1.2.3.4.5']) expect(canonicalIp(s), s).toBeUndefined();
  });

  it('classifies every spelling of loopback, link-local, private and reserved addresses', () => {
    const want: Record<string, string> = {
      '::ffff:7f00:1': 'loopback',
      '0:0:0:0:0:0:0:1': 'loopback',
      '[::1]': 'loopback',
      '127.1': 'loopback',
      '::ffff:a9fe:a9fe': 'refused',
      'fe80::1%eth0': 'refused',
      '::ffff:a00:1': 'private',
      '::ffff:c0a8:101': 'private',
      'fd12::1': 'private',
      '64:ff9b::7f00:1': 'refused',
      '64:ff9b:1::a00:1': 'refused',
      '::7f00:1': 'refused',
      '::ffff:0:7f00:1': 'refused',
      '::': 'refused',
      '8.8.8.8': 'public',
      '::ffff:808:808': 'public',
      '2606:4700::1111': 'public',
    };
    for (const [ip, cls] of Object.entries(want)) expect(classifyIp(ip), ip).toBe(cls);
    expect(isLinkLocalIp('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('a webhook or ntfy URL cannot reach loopback or link-local through the hex mapped form', async () => {
    expect(() => checkHttpUrl('https://[::ffff:127.0.0.1]:8443/')).toThrow(AddressError);
    expect(() => checkHttpUrl('https://[::ffff:7f00:1]/')).toThrow(AddressError);
    expect(() => checkHttpUrl('https://[::ffff:a9fe:a9fe]/')).toThrow(AddressError);
    expect(() => checkHttpUrl('https://[64:ff9b:1::a9fe:a9fe]/')).toThrow(AddressError);
    // http:// to a mapped private address is on the owner's network, as its IPv4 spelling is.
    expect(checkHttpUrl('http://[::ffff:c0a8:101]/').local).toBe(true);
    // A name that resolves to the hex mapped form is refused before any connection.
    const resolve = async (): Promise<LookupAddress[]> => [{ address: '::ffff:7f00:1', family: 6 }];
    await expect(postChecked('https://hooks.example/x', '{}', {}, { resolve })).rejects.toThrow(/guardian itself/);
  });

  it('the chain clients see mapped link-local addresses as link-local', () => {
    expect(isLinkLocal('::ffff:a9fe:a9fe')).toBe(true);
    expect(isLinkLocal('[fe80::1]')).toBe(true);
    expect(isLinkLocal('::ffff:808:808')).toBe(false);
    expect(isLocalAddress('::ffff:7f00:1')).toBe(true);
    expect(isLocalAddress('::ffff:808:808')).toBe(false);
  });

  it('the trusted proxy and the loopback check match every spelling of an address', async () => {
    expect(normalizeAddress('::ffff:a15:1')).toBe('10.21.0.1');
    expect(isLoopback('::ffff:7f00:1')).toBe(true);
    expect(isLoopback('0:0::1')).toBe(true);
    expect(isLoopback('::ffff:808:808')).toBe(false);
    const p = new TrustedProxy(['::ffff:10.21.0.1']);
    expect(await p.trusts('10.21.0.1')).toBe(true);
    expect(await p.trusts('::ffff:a15:1')).toBe(true);
  });

  it("a contact's DM relay in any spelling of a local address is dropped", () => {
    for (const u of ['wss://[::ffff:7f00:1]', 'wss://[::ffff:a00:1]', 'wss://[fd00::1]', 'wss://[fe80::1]', 'wss://[64:ff9b:1::a00:1]', 'wss://127.1', 'wss://2130706433'])
      expect(isPublicDmRelay(u), u).toBe(false);
    expect(isPublicDmRelay('wss://[2606:4700::1111]')).toBe(true);
  });
});
