/**
 * Settings > Server: the form's checks, the body it sends, the words it shows (the public-server warning, the recovery
 * refusal), and the mock's behaviour. The guardian checks everything again (apps/guardian/src/chain/source.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { createMockApi, readScenario } from '../src/api/mock';
import type { ChainSettings } from '../src/api/types';
import { PUBLIC_WARNING, mempoolText, draftError, draftFrom, inputFrom, presetLabel, recoveryBlock, sourceLabel, type ServerDraft } from '../src/lib/server';

const settings = (over: Partial<ChainSettings> = {}): ChainSettings => ({
  source: { kind: 'electrum', host: '10.21.21.10', port: 50001, tls: false },
  summary: { kind: 'own', backend: 'electrum', host: '10.21.21.10', port: 50001 },
  origin: 'environment',
  status: { connected: true, rescans: [] },
  publicServers: [{ id: 'mempool-signet', host: 'mempool.space', port: 60602, operator: 'mempool.space' }],
  network: 'signet',
  recoveryRunning: false,
  ...over,
});
const draft = (over: Partial<ServerDraft>): ServerDraft => ({ ...draftFrom(settings()), ...over });

describe('Settings > Server form', () => {
  it('starts from the source in use, without the RPC password', () => {
    expect(draftFrom(settings())).toMatchObject({ kind: 'electrum', host: '10.21.21.10', port: '50001', tls: false });
    const core = draftFrom(settings({ source: { kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', passSet: true } } }));
    expect(core).toMatchObject({ kind: 'core', host: 'node', port: '8332', user: 'u', pass: '' });
    expect(draftFrom(settings({ source: { kind: 'public', host: 'mempool.space', port: 60602 } }))).toMatchObject({ kind: 'public', preset: 'mempool-signet' });
  });

  it('checks the draft in plain words', () => {
    expect(draftError(draft({ host: '' }), false)).toMatch(/Enter the server/);
    expect(draftError(draft({ host: 'http://x' }), false)).toMatch(/no http/);
    expect(draftError(draft({ port: '70000' }), false)).toMatch(/1 to 65535/);
    expect(draftError(draft({ certSha256: 'ab:cd' , tls: true }), false)).toMatch(/64 hex digits/);
    expect(draftError(draft({ certSha256: 'ab'.repeat(32), tls: false }), false)).toMatch(/needs TLS/);
    expect(draftError(draft({ kind: 'core', host: 'node', port: '', user: 'u' }), false)).toMatch(/RPC port/);
    expect(draftError(draft({ kind: 'core', host: 'node', port: '8332', user: 'u', pass: '' }), false)).toMatch(/RPC password/);
    expect(draftError(draft({ kind: 'core', host: 'node', port: '8332', user: 'u', pass: '' }), true)).toBeUndefined();
    expect(draftError(draft({ kind: 'public', preset: 'mempool-signet', host: '' }), false)).toBeUndefined();
  });

  it('sends the body the guardian expects', () => {
    expect(inputFrom(draft({ host: 'fulcrum.lan', port: '', tls: true, certSha256: 'AB'.repeat(32) }))).toEqual({ kind: 'electrum', host: 'fulcrum.lan', tls: true, certSha256: 'AB'.repeat(32) });
    expect(inputFrom(draft({ kind: 'public', preset: 'mempool-signet' }))).toEqual({ kind: 'public', preset: 'mempool-signet' });
    expect(inputFrom(draft({ kind: 'public', preset: '', host: 'electrum.example.org', port: '50002' }))).toEqual({ kind: 'public', host: 'electrum.example.org', port: 50002 });
    expect(inputFrom(draft({ kind: 'core', host: 'node', port: '8332', user: 'u', pass: '' }))).toEqual({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u' } });
    expect(inputFrom(draft({ kind: 'core', host: 'node', port: '8332', user: 'u', pass: 'p', wallet: 'w' }))).toEqual({ kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', pass: 'p' }, wallet: 'w' });
  });

  it('says what a public server can do, and refuses one during a recovery', () => {
    expect(PUBLIC_WARNING).toMatch(/sees every address/);
    expect(PUBLIC_WARNING).toMatch(/cannot spend or change any rule/);
    expect(PUBLIC_WARNING).toMatch(/Use your own node/);
    expect(recoveryBlock(draft({ kind: 'public' }), settings({ recoveryRunning: true }))).toMatch(/recovery is running/);
    expect(recoveryBlock(draft({ kind: 'electrum' }), settings({ recoveryRunning: true }))).toBeUndefined();
    expect(sourceLabel({ kind: 'public', host: 'mempool.space', port: 60602 })).toBe('Public server mempool.space:60602');
    expect(sourceLabel({ kind: 'electrum', host: 'f', port: 50002, tls: true, certSha256: 'x' })).toMatch(/pinned certificate/);
    expect(presetLabel({ id: 'x', host: 'mempool.space', port: 40002, operator: 'mempool.space', chain: 'testnet4' })).toBe('mempool.space:40002 (mempool.space, testnet4)');
  });
});

describe('the server API', () => {
  let sent: { method: string; url: string; body?: unknown }[];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GET /api/chain, PUT /api/chain, POST /api/chain/test', async () => {
    const api = createHttpApi();
    await api.getChain();
    await api.setChain({ kind: 'public', preset: 'mempool-signet' });
    await api.testChain({ kind: 'electrum', host: 'electrs', tls: false });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/chain', 'PUT /api/chain', 'POST /api/chain/test']);
    expect(sent[1]!.body).toEqual({ kind: 'public', preset: 'mempool-signet' });
  });

  it('the mock switches, and refuses a public server during a recovery', async () => {
    const api = createMockApi('default');
    expect((await api.getChain()).summary?.kind).toBe('own');
    expect((await api.setChain({ kind: 'public', preset: 'mempool-signet' })).summary).toMatchObject({ kind: 'public', host: 'mempool.space' });
    await expect(createMockApi('recovery').setChain({ kind: 'public', preset: 'mempool-signet' })).rejects.toMatchObject({ code: 'recovery_pending' });
    expect((await createMockApi('publicserver').getChain()).summary?.kind).toBe('public');
  }, 20_000);
});

describe('an Electrum server that reports no unconfirmed payments', () => {
  it('?mock=nomempool: the home status and Settings > Server say so, in the words asked for', async () => {
    expect(readScenario('?mock=nomempool')).toBe('nomempool');
    const api = createMockApi('nomempool');
    const st = await api.getStatus();
    if (!('chain' in st)) throw new Error('signed in');
    expect(st.chain).toMatchObject({ state: 'synced', mempoolUnseen: true, mempoolCause: 'electrs_core32', mempoolViaNode: true });
    expect((await api.getChain()).status).toMatchObject({ mempoolUnseen: true, mempoolCause: 'electrs_core32' });
  });

  it('names the cause: Electrs and Bitcoin Core 32, with or without the guardian reading Core itself', () => {
    expect(mempoolText({ mempoolCause: 'electrs_core32' }).text).toBe(
      "Electrs can't read Bitcoin Core 32's mempool; unconfirmed payments show once confirmed, or switch Settings > Server to Bitcoin Core alone.",
    );
    expect(mempoolText({ mempoolCause: 'electrs_core32', mempoolViaNode: true }).text).toMatch(/reads unconfirmed payments from Bitcoin Core itself/);
    // Slow too (pings of seconds): said plainly, with both fixes.
    const slow = mempoolText({ mempoolCause: 'electrs_core32', mempoolViaNode: true, mempoolServerSlow: true });
    expect(slow.text).toBe("Electrs is slowed down and can't see unconfirmed payments: it doesn't work with Bitcoin Core 32's mempool.");
    expect(slow.detail).toMatch(/deprecatedrpc=bip125/);
    expect(slow.detail).toMatch(/Settings > Server to Bitcoin Core alone/);
    expect(mempoolText({}).text).toBe("Your Electrum server doesn't report unconfirmed payments; they will show once confirmed.");
    for (const m of [{}, { mempoolViaNode: true }, { mempoolCause: 'electrs_core32' as const }]) expect(mempoolText(m).detail).toMatch(/Payments your phone makes still show at once/);
  });

  it('every other scenario: nothing to say', async () => {
    const st = await createMockApi('default').getStatus();
    expect('chain' in st ? st.chain.mempoolUnseen : undefined).toBeUndefined();
    expect((await createMockApi('default').getChain()).status.mempoolUnseen).toBeUndefined();
  });
});
