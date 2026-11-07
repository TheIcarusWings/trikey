/**
 * The chain source (chain/source.ts): what the web UI may choose, how it is described to the phone and in Activity,
 * how the choice is stored (the RPC password sealed), and what the environment starts with (CHAIN_SOURCE). And, golden:
 * the Umbrel and Start9 environments start with their own Electrs, as before.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ElectrumBackend } from '../src/chain/backend.js';
import { CoreBackend, descriptorsOf } from '../src/chain/core-backend.js';
import { ChainSourceStore, PUBLIC_SERVERS, buildBackend, describe as describeSource, environmentSourceName, parseChainSource, sameChainSource, publicServersFor, publicView, summarize } from '../src/chain/source.js';
import { HelperAccount } from '../src/singlekey.js';
import { makeWallet } from './helpers.js';

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('choosing a chain source (Settings > Server)', () => {
  it('a private Electrum server: TLS optional, a pin needs TLS, plain TCP only to the owner network', () => {
    expect(parseChainSource({ kind: 'electrum', host: 'electrs.local', tls: false })).toEqual({ kind: 'electrum', host: 'electrs.local', port: 50001, tls: false });
    expect(parseChainSource({ kind: 'electrum', host: 'fulcrum.example.com', tls: true, certSha256: FP.replace(/:/g, '') })).toEqual({
      kind: 'electrum',
      host: 'fulcrum.example.com',
      port: 50002,
      tls: true,
      certSha256: FP,
    });
    expect(() => parseChainSource({ kind: 'electrum', host: 'x.lan', tls: false, certSha256: FP })).toThrow(/needs TLS/);
    expect(() => parseChainSource({ kind: 'electrum', host: '203.0.113.5', tls: false })).toThrow(/on the internet: turn TLS on/);
    expect(() => parseChainSource({ kind: 'electrum', host: 'tcp://x:1', tls: false })).toThrow(/host name or an IP address only/);
    expect(() => parseChainSource({ kind: 'electrum', host: 'abc.onion', tls: true })).toThrow(/Tor/);
    expect(() => parseChainSource({ kind: 'electrum', host: 'x.lan', port: 70000, tls: false })).toThrow(/port from 1 to 65535/);
  });

  it('a public server: a listed one, or another public host (always TLS); not an address on the owner network', () => {
    expect(parseChainSource({ kind: 'public', preset: 'mempool-testnet4' })).toEqual({ kind: 'public', host: 'mempool.space', port: 40002 });
    expect(parseChainSource({ kind: 'public', host: 'electrum.example.org' })).toEqual({ kind: 'public', host: 'electrum.example.org', port: 50002 });
    expect(() => parseChainSource({ kind: 'public', preset: 'nope' })).toThrow(/not one of the listed/);
    expect(() => parseChainSource({ kind: 'public', host: '192.168.1.4' })).toThrow(/your own network/);
    expect(() => parseChainSource({ kind: 'public', host: 'umbrel.local' })).toThrow(/your own network/);
  });

  it('Bitcoin Core: address, port, user and password (kept when left out for the same node and user)', () => {
    const core = parseChainSource({ kind: 'core', rpc: { host: '192.168.1.5', port: 8332, user: 'trikey', pass: 'secret-pass-only-for-tests' } });
    expect(core).toEqual({ kind: 'core', rpc: { host: '192.168.1.5', port: 8332, user: 'trikey', pass: 'secret-pass-only-for-tests' } });
    expect(parseChainSource({ kind: 'core', rpc: { host: '192.168.1.5', port: 8332, user: 'trikey' }, wallet: 'my-watch' }, core)).toMatchObject({ rpc: { pass: 'secret-pass-only-for-tests' }, wallet: 'my-watch' });
    expect(() => parseChainSource({ kind: 'core', rpc: { host: '192.168.1.6', port: 8332, user: 'trikey' } }, core)).toThrow(/RPC password/);
    expect(() => parseChainSource({ kind: 'core', rpc: { host: '8.8.4.4', port: 8332, user: 'u', pass: 'p' } })).toThrow(/no encryption/);
    expect(parseChainSource({ kind: 'core', rpc: { host: '8.8.4.4', port: 8332, user: 'u', pass: 'p', allowPublic: true } })).toMatchObject({ rpc: { allowPublic: true } });
    expect(() => parseChainSource({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'a:b', pass: 'p' } })).toThrow(/RPC user/);
    expect(() => parseChainSource({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', pass: 'p' }, wallet: 'bad name' })).toThrow(/Wallet name/);
    expect(() => parseChainSource({ kind: 'nothing' })).toThrow(/Choose a kind of server/);
  });

  it('describes a source for the phone, Activity and alerts without any credential', () => {
    const core = parseChainSource({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', pass: 'do-not-show' } });
    expect(summarize(core)).toEqual({ kind: 'own', backend: 'core', host: 'node', port: 8332 });
    expect(JSON.stringify(publicView(core))).not.toContain('do-not-show');
    expect(publicView(core)).toEqual({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', passSet: true } });
    expect(summarize({ kind: 'public', host: 'mempool.space', port: 60602 })).toEqual({ kind: 'public', backend: 'electrum', host: 'mempool.space', port: 60602 });
    expect(describeSource({ kind: 'electrum', host: 'fd00::1', port: 50001, tls: false })).toBe('your own Electrum server [fd00::1]:50001');
    expect(describeSource({ kind: 'public', host: 'mempool.space', port: 40002 })).toBe('the public server mempool.space:40002');
  });

  it('lists public servers per network, all TLS ports, and none for regtest', () => {
    expect(publicServersFor('bitcoin').length).toBeGreaterThanOrEqual(3);
    expect(publicServersFor('testnet').map((s) => s.chain).sort()).toEqual(['testnet3', 'testnet4']);
    expect(publicServersFor('signet').length).toBe(1);
    expect(publicServersFor('regtest')).toEqual([]);
    for (const s of PUBLIC_SERVERS) expect([50002, 60002, 40002, 60602], s.id).toContain(s.port);
  });

  it('builds an Electrum backend (a public one always TLS, with the network check) or a Bitcoin Core one', () => {
    const pub = buildBackend({ kind: 'public', host: 'mempool.space', port: 60602 }, { network: 'signet' });
    expect(pub).toBeInstanceOf(ElectrumBackend);
    expect((pub as ElectrumBackend).client.transport).toBe('tls');
    expect(buildBackend({ kind: 'core', rpc: { host: '127.0.0.1', port: 18443, user: 'u', pass: 'p' } }, { network: 'regtest' })).toBeInstanceOf(CoreBackend);
  });

  it('gives Bitcoin Core the descriptors of a multisig wallet and of the helper account', async () => {
    const w = await makeWallet();
    const [recv, change] = descriptorsOf(w)!;
    expect(recv).toMatch(/^wsh\(sortedmulti\(2,.*\/0\/\*.*\)\)#[a-z0-9]{8}$/);
    expect(change).toMatch(/\/1\/\*/);
    expect(descriptorsOf({ fingerprint: () => 'x', derive: () => ({ script: new Uint8Array() }) })).toBeUndefined();
    const helperXpub = 'tpubDCJh5BDDPEXDX7dEXsBeeS4Y8vc2HqDGa1wGqT4FxyXpJsW2UVCbG8BVoMKFxqxrHDBNMBWQgo53tbaxd7wK2sYWajr2SqxGqJhUAGBwE2E';
    let helper: HelperAccount | undefined;
    try {
      helper = new HelperAccount(helperXpub, 'regtest');
    } catch {
      /* not a helper-account key at the expected path: covered by singlekey's tests */
    }
    if (helper) expect(descriptorsOf(helper)).toEqual([`wpkh(${helperXpub}/0/*)`, `wpkh(${helperXpub}/1/*)`]);
  });
});

describe('chain-source.json', () => {
  it('stores the choice, the RPC password sealed (never in the clear), and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trikey-chain-source-'));
    const store = new ChainSourceStore(dir);
    expect(await store.load()).toBeUndefined();
    const core = parseChainSource({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', pass: 'sealed-pass-for-tests' }, wallet: 'w1' });
    await store.save(core, 1_800_000_000_000);
    const raw = await readFile(store.path, 'utf8');
    expect(raw).not.toContain('sealed-pass-for-tests');
    expect(JSON.parse(raw)).toMatchObject({ version: 1, source: { kind: 'core', rpc: { host: 'node', user: 'u' } }, rpcPass: { n: expect.any(String), c: expect.any(String) } });
    expect(await new ChainSourceStore(dir).load()).toEqual(core);
    await store.save({ kind: 'public', host: 'mempool.space', port: 60602 }, 1_800_000_000_001);
    expect(await new ChainSourceStore(dir).load()).toEqual({ kind: 'public', host: 'mempool.space', port: 60602 });
  });
});

describe('CHAIN_SOURCE from the environment', () => {
  it('defaults to the Electrum server of ELECTRUM_*; core takes BITCOIN_RPC_*; public a listed server or host:port', () => {
    expect(loadConfig({ ELECTRUM_HOST: 'electrs', BITCOIN_NETWORK: 'signet' }).chainSource).toEqual({ kind: 'electrum', host: 'electrs', port: 50001, tls: false });
    const rpc = { BITCOIN_RPC_HOST: 'bitcoind', BITCOIN_RPC_PORT: '8332', BITCOIN_RPC_USER: 'u', BITCOIN_RPC_PASS: 'p' };
    expect(loadConfig({ CHAIN_SOURCE: 'core', BITCOIN_NETWORK: 'signet', BITCOIN_CORE_WALLET: 'watch', ...rpc }).chainSource).toEqual({
      kind: 'core',
      rpc: { host: 'bitcoind', port: 8332, user: 'u', pass: 'p' },
      wallet: 'watch',
    });
    expect(loadConfig({ CHAIN_SOURCE: 'public', BITCOIN_NETWORK: 'signet' }).chainSource).toEqual({ kind: 'public', host: 'mempool.space', port: 60602 });
    expect(loadConfig({ CHAIN_SOURCE: 'public', BITCOIN_NETWORK: 'bitcoin', PUBLIC_ELECTRUM_SERVER: 'emzy' }).chainSource).toEqual({ kind: 'public', host: 'electrum.emzy.de', port: 50002 });
    expect(loadConfig({ CHAIN_SOURCE: 'public', BITCOIN_NETWORK: 'bitcoin', PUBLIC_ELECTRUM_SERVER: 'electrum.example.org:50012' }).chainSource).toEqual({ kind: 'public', host: 'electrum.example.org', port: 50012 });
    expect(() => loadConfig({ CHAIN_SOURCE: 'core' })).toThrow(/needs BITCOIN_RPC_HOST/);
    expect(() => loadConfig({ CHAIN_SOURCE: 'public', BITCOIN_NETWORK: 'regtest' })).toThrow(/no public server is listed/);
    expect(() => loadConfig({ CHAIN_SOURCE: 'esplora' })).toThrow(/electrum, core or public/);
    expect(() => loadConfig({ BITCOIN_RPC_HOST: '198.51.100.7', BITCOIN_RPC_USER: 'u', BITCOIN_RPC_PASS: 'p' })).toThrow(/no encryption/);
  });

  it('golden: Umbrel and Start9 start with the box Electrs over plain TCP, as before', () => {
    const umbrel = loadConfig({ TRIKEY_PLATFORM: 'umbrel', ELECTRUM_HOST: '10.21.21.10', ELECTRUM_PORT: '50001', BITCOIN_RPC_HOST: '10.21.21.8', BITCOIN_RPC_PORT: '8332', BITCOIN_RPC_USER: 'umbrel', BITCOIN_RPC_PASS: 'x', BITCOIN_NETWORK: 'mainnet' });
    expect(umbrel.chainSource).toEqual({ kind: 'electrum', host: '10.21.21.10', port: 50001, tls: false });
    expect(umbrel.bitcoinRpc).toEqual({ host: '10.21.21.8', port: 8332, user: 'umbrel', pass: 'x' });
    const start9 = loadConfig({ TRIKEY_PLATFORM: 'start9', ELECTRUM_HOST: '10.0.3.1', ELECTRUM_PORT: '50001', BITCOIN_NETWORK: 'bitcoin' });
    expect(start9.chainSource).toEqual({ kind: 'electrum', host: '10.0.3.1', port: 50001, tls: false });
  });
});

describe('a save that changes nothing, and the server the platform set', () => {
  it('compares sources by what they connect to, not by how the input was written', () => {
    const a = parseChainSource({ kind: 'electrum', host: 'electrs.local', tls: false });
    expect(sameChainSource(a, parseChainSource({ kind: 'electrum', host: 'Electrs.LOCAL', port: 50001, tls: false }))).toBe(true);
    expect(sameChainSource(a, { tls: false, port: 50001, host: 'electrs.local', kind: 'electrum' })).toBe(true);
    expect(sameChainSource(a, parseChainSource({ kind: 'electrum', host: 'electrs.local', port: 50002, tls: false }))).toBe(false);
    expect(sameChainSource(a, parseChainSource({ kind: 'electrum', host: 'electrs.local', port: 50001, tls: true }))).toBe(false);
    const pinned = parseChainSource({ kind: 'electrum', host: 'f.lan', tls: true, certSha256: FP });
    expect(sameChainSource(pinned, parseChainSource({ kind: 'electrum', host: 'f.lan', tls: true, certSha256: FP.replace(/:/g, '').toLowerCase() }))).toBe(true);
    expect(sameChainSource(pinned, parseChainSource({ kind: 'electrum', host: 'f.lan', tls: true }))).toBe(false);
    expect(sameChainSource(parseChainSource({ kind: 'public', preset: 'blockstream' }), parseChainSource({ kind: 'public', host: 'electrum.blockstream.info' }))).toBe(true);
    expect(sameChainSource(parseChainSource({ kind: 'public', host: 'electrs.example.org' }), parseChainSource({ kind: 'electrum', host: 'electrs.example.org', tls: true }))).toBe(false);
    // Bitcoin Core: an empty password keeps the stored one (the same source); a new one is a change.
    const core = parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u', pass: 'p' } });
    expect(sameChainSource(core, parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u' } }, core))).toBe(true);
    expect(sameChainSource(core, parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u', pass: 'q' } }, core))).toBe(false);
    expect(sameChainSource(core, parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u' }, wallet: 'w' }, core))).toBe(false);
  });

  it("uses the password of the guardian's own Bitcoin Core (BITCOIN_RPC_*) for its host and user", () => {
    const node = { host: '10.21.21.8', port: 8332, user: 'umbrel', pass: 'secret' };
    expect(parseChainSource({ kind: 'core', rpc: { host: '10.21.21.8', port: 8332, user: 'umbrel' } }, undefined, node)).toEqual({ kind: 'core', rpc: { host: '10.21.21.8', port: 8332, user: 'umbrel', pass: 'secret' } });
    expect(() => parseChainSource({ kind: 'core', rpc: { host: '10.21.21.9', port: 8332, user: 'umbrel' } }, undefined, node)).toThrow(/RPC password/);
    expect(() => parseChainSource({ kind: 'core', rpc: { host: '10.21.21.8', port: 8332, user: 'other' } }, undefined, node)).toThrow(/RPC password/);
  });

  it('never sends a kept RPC password to another port of the same host', () => {
    // Anyone on the node's machine may listen on another port: the password goes only where it was typed for.
    const node = { host: '10.21.21.8', port: 8332, user: 'umbrel', pass: 'secret' };
    expect(() => parseChainSource({ kind: 'core', rpc: { host: '10.21.21.8', port: 9999, user: 'umbrel' } }, undefined, node)).toThrow(/RPC password/);
    const saved = parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u', pass: 'p' } });
    expect(() => parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8333, user: 'u' } }, saved)).toThrow(/RPC password/);
    // The same address keeps it, and a new port with the password typed again is fine.
    expect(parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8332, user: 'u' } }, saved)).toEqual(saved);
    expect(parseChainSource({ kind: 'core', rpc: { host: 'node.lan', port: 8333, user: 'u', pass: 'p' } }, saved)).toMatchObject({ rpc: { port: 8333, pass: 'p' } });
  });

  it('names the platform that set the server', () => {
    expect(environmentSourceName('umbrel')).toBe('the server Umbrel set');
    expect(environmentSourceName('start9')).toBe('the server StartOS set');
    expect(environmentSourceName('docker')).toBe('the server in the .env file');
    expect(environmentSourceName(undefined)).toBe('the server in the .env file');
  });
});
