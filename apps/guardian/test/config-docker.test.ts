/**
 * The environment of a guardian on plain Docker (packaging/compose/.env.example): Electrum over TLS with an optional
 * pinned certificate, the plain-TCP rule for literal addresses, TRIKEY_PLATFORM and TRIKEY_RELAYS. And that the
 * Umbrel and Start9 environments read as before.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_OPTIONS, loadConfig, parsePlatform } from '../src/config.js';

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('ELECTRUM_* on plain Docker', () => {
  it('reads TLS, defaults its port to 50002, and normalises a pinned fingerprint', () => {
    expect(loadConfig({ ELECTRUM_HOST: 'fulcrum.lan', ELECTRUM_TLS: '1' }).electrum).toEqual({ host: 'fulcrum.lan', port: 50002, tls: true });
    expect(loadConfig({ ELECTRUM_HOST: 'fulcrum.lan', ELECTRUM_TLS: 'true', ELECTRUM_PORT: '50012', ELECTRUM_TLS_CERT_SHA256: FP.replace(/:/g, '').toLowerCase() }).electrum).toEqual({
      host: 'fulcrum.lan',
      port: 50012,
      tls: true,
      certSha256: FP,
    });
    expect(loadConfig({ ELECTRUM_HOST: 'electrs', ELECTRUM_TLS: '0' }).electrum).toEqual({ host: 'electrs', port: 50001 });
  });

  it('refuses a pin without TLS, a SHA-1 pin, a malformed pin and a flag that is not 1 or 0', () => {
    expect(() => loadConfig({ ELECTRUM_HOST: 'x.lan', ELECTRUM_TLS_CERT_SHA256: FP })).toThrow(/set ELECTRUM_TLS=1/);
    expect(() => loadConfig({ ELECTRUM_HOST: 'x.lan', ELECTRUM_TLS: '1', ELECTRUM_TLS_CERT_SHA256: 'ab'.repeat(20) })).toThrow(/SHA-1/);
    expect(() => loadConfig({ ELECTRUM_HOST: 'x.lan', ELECTRUM_TLS: '1', ELECTRUM_TLS_CERT_SHA256: 'nope' })).toThrow(/64 hex digits/);
    expect(() => loadConfig({ ELECTRUM_HOST: 'x.lan', ELECTRUM_TLS: 'maybe' })).toThrow(/ELECTRUM_TLS must be 1 or 0/);
    expect(() => loadConfig({ ELECTRUM_HOST: 'tcp://x.lan:50001' })).toThrow(/host name or an IP address only/);
  });

  it('refuses plain TCP to a literal internet address unless allowed, and allows the owner network', () => {
    expect(() => loadConfig({ ELECTRUM_HOST: '203.0.113.9' })).toThrow(/on the internet: set ELECTRUM_TLS=1/);
    expect(loadConfig({ ELECTRUM_HOST: '203.0.113.9', ELECTRUM_TLS: '1' }).electrum?.tls).toBe(true);
    expect(loadConfig({ ELECTRUM_HOST: '203.0.113.9', ELECTRUM_ALLOW_PUBLIC_PLAINTEXT: '1' }).electrum).toEqual({ host: '203.0.113.9', port: 50001, allowPublicPlaintext: true });
    for (const host of ['192.168.1.20', '10.21.21.10', '100.64.1.1', '127.0.0.1', 'fd00::5']) expect(loadConfig({ ELECTRUM_HOST: host }).electrum?.host).toBe(host);
  });
});

describe('TRIKEY_PLATFORM', () => {
  it('defaults to docker (the setup code), and takes umbrel and start9', () => {
    expect(loadConfig({}).platform).toBe('docker');
    expect(loadConfig({ TRIKEY_PLATFORM: 'umbrel' }).platform).toBe('umbrel');
    expect(loadConfig({ TRIKEY_PLATFORM: 'Start9' }).platform).toBe('start9');
    expect(() => parsePlatform('umbrel-ish')).toThrow(/TRIKEY_PLATFORM must be/);
  });
});

describe('TRIKEY_RELAYS', () => {
  it('replaces the relays the first-run screen offers, all selected', () => {
    expect(loadConfig({}).relayOptions).toEqual(DEFAULT_RELAY_OPTIONS);
    expect(loadConfig({ TRIKEY_RELAYS: 'wss://relay.one.example, wss://relay.two.example' }).relayOptions).toEqual([
      { url: 'wss://relay.one.example', defaultSelected: true },
      { url: 'wss://relay.two.example', defaultSelected: true },
    ]);
    expect(() => loadConfig({ TRIKEY_RELAYS: 'https://not-a-relay.example' })).toThrow(/TRIKEY_RELAYS/);
  });
});

describe('golden: the Umbrel and Start9 environments read as before', () => {
  it('Umbrel (packaging/umbrel docker-compose.yml): Electrs on the internal network, plain TCP, the login proxy trusted', () => {
    const c = loadConfig({
      PORT: '3000',
      TRIKEY_DATA_DIR: '/data',
      TRIKEY_PLATFORM: 'umbrel',
      ELECTRUM_HOST: '10.21.21.10',
      ELECTRUM_PORT: '50001',
      BITCOIN_RPC_HOST: '10.21.21.8',
      BITCOIN_RPC_PORT: '8332',
      BITCOIN_RPC_USER: 'umbrel',
      BITCOIN_RPC_PASS: 'test-only',
      BITCOIN_NETWORK: 'mainnet',
      TRIKEY_TRUSTED_PROXY: 'gateway,trikey-guardian_app_proxy_1,app_proxy_trikey-guardian',
    });
    expect(c.electrum).toEqual({ host: '10.21.21.10', port: 50001 });
    expect(c.platform).toBe('umbrel');
    expect(c.trustedProxies).toEqual(['gateway', 'trikey-guardian_app_proxy_1', 'app_proxy_trikey-guardian']);
    expect(c.relayOptions).toEqual(DEFAULT_RELAY_OPTIONS);
  });

  it('Start9 (packaging/start9 main.ts): the bridge address, plain TCP, the setup code from the package', () => {
    const c = loadConfig({ PORT: '3000', TRIKEY_DATA_DIR: '/data', TRIKEY_PLATFORM: 'start9', BITCOIN_NETWORK: 'bitcoin', ELECTRUM_HOST: '10.0.3.1', ELECTRUM_PORT: '50001', TRIKEY_SETUP_CODE: 'ABCD-EFGH-JKMN-PQRS' });
    expect(c.electrum).toEqual({ host: '10.0.3.1', port: 50001 });
    expect(c.platform).toBe('start9');
    expect(c.setupCode).toBe('ABCDEFGHJKMNPQRS');
  });
});
