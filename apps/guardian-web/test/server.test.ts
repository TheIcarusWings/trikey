/**
 * Settings > Server: the form's checks, the body it sends, the words it shows (the public-server warning, the recovery
 * refusal), and the mock's behaviour. The guardian checks everything again (apps/guardian/src/chain/source.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { createMockApi, readScenario } from '../src/api/mock';
import type { ChainSettings } from '../src/api/types';
import {
  CORE_LINK,
  HOME_CORE32_FIX,
  PUBLIC_WARNING,
  backButton,
  coreDraft,
  draftError,
  draftFrom,
  draftUnchanged,
  environmentLine,
  inputFrom,
  mempoolText,
  passKnown,
  presetLabel,
  recoveryBlock,
  serverPageMode,
  sourceLabel,
  type ServerDraft,
} from '../src/lib/server';

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
    expect(mempoolText({ mempoolCause: 'electrs_core32' }).text).toBe("Electrs can't read Bitcoin Core 32's mempool, so payments to you show only once confirmed.");
    expect(mempoolText({ mempoolCause: 'electrs_core32', mempoolViaNode: true }).text).toMatch(/reads unconfirmed payments from Bitcoin Core itself/);
    // Slow too (pings of seconds): said plainly, with both fixes.
    const slow = mempoolText({ mempoolCause: 'electrs_core32', mempoolViaNode: true, mempoolServerSlow: true });
    expect(slow.text).toBe('Electrs is slowed down by Bitcoin Core 32; unconfirmed payments are read from Bitcoin Core instead.');
    expect(slow.detail).toMatch(/deprecatedrpc=bip125/);
    expect(slow.detail).toMatch(/Settings > Server to Bitcoin Core alone/);
    expect(mempoolText({ mempoolCause: 'electrs_core32', mempoolServerSlow: true }).text).toBe(
      "Electrs is slowed down by Bitcoin Core 32 and can't see unconfirmed payments, so payments to you show only once confirmed.",
    );
    expect(mempoolText({}).text).toBe("Your Electrum server doesn't report unconfirmed payments, so payments to you show only once confirmed.");
    for (const m of [{}, { mempoolViaNode: true }, { mempoolCause: 'electrs_core32' as const }]) expect(mempoolText(m).detail).toMatch(/Payments your phone makes still show at once/);
  });

  it('every title reads right on its own (the home page shows only it): unconfirmed payments are seen exactly when Core covers them', () => {
    for (const mempoolCause of [undefined, 'electrs_core32' as const])
      for (const mempoolViaNode of [false, true])
        for (const mempoolServerSlow of [false, true]) {
          const { text, core32 } = mempoolText({ mempoolCause, mempoolViaNode, mempoolServerSlow });
          expect(text).toMatch(/\.$/);
          expect(core32).toBe(mempoolCause === 'electrs_core32');
          if (mempoolViaNode) {
            expect(text).toMatch(/from Bitcoin Core/);
            expect(text).not.toMatch(/once confirmed|can't see/);
          } else {
            expect(text).toMatch(/payments to you show only once confirmed/);
          }
          if (mempoolCause && mempoolServerSlow) expect(text).toMatch(/slowed down by Bitcoin Core 32/);
          expect(text).not.toMatch(/Settings > Server|below/);
        }
  });

  it('the home note for Core 32 keeps the bip125 fix and links to Bitcoin Core alone, on the Server page', () => {
    expect(HOME_CORE32_FIX).toMatch(/deprecatedrpc=bip125/);
    expect(CORE_LINK).toBe('/settings?server=core');
  });

  it('every other scenario: nothing to say', async () => {
    const st = await createMockApi('default').getStatus();
    expect('chain' in st ? st.chain.mempoolUnseen : undefined).toBeUndefined();
    expect((await createMockApi('default').getChain()).status.mempoolUnseen).toBeUndefined();
  });
});

describe('Settings > Server from the platform settings', () => {
  it('fills the form from the source in use when nothing was chosen here (Umbrel)', () => {
    const env = settings({ source: null, summary: { kind: 'own', backend: 'electrum', host: '192.168.1.158', port: 50001 }, origin: 'environment' });
    expect(draftFrom(env)).toMatchObject({ kind: 'electrum', host: '192.168.1.158', port: '50001' });
  });
  it('words the Core 32 fix for the page it is on', () => {
    const m = { mempoolCause: 'electrs_core32' as const, mempoolServerSlow: true, mempoolViaNode: true };
    expect(mempoolText(m).detail).toContain('switch Settings > Server to Bitcoin Core alone');
    expect(mempoolText(m, { onServerPage: true }).detail).toContain('choose Your own Bitcoin Core below');
    expect(mempoolText(m, { onServerPage: true }).detail).not.toContain('Settings > Server');
  });
});

const umbrel = (over: Partial<ChainSettings> = {}): ChainSettings =>
  settings({ platform: 'umbrel', environment: { kind: 'own', backend: 'electrum', host: '10.21.21.10', port: 50001 }, nodeRpc: { host: '10.21.21.8', port: 8332, user: 'umbrel' }, ...over });
const chosen = (over: Partial<ChainSettings> = {}): ChainSettings =>
  umbrel({ origin: 'settings', source: { kind: 'electrum', host: 'fulcrum.lan', port: 50002, tls: true }, summary: { kind: 'own', backend: 'electrum', host: 'fulcrum.lan', port: 50002 }, ...over });

describe('Settings > Server: the server Umbrel or StartOS set', () => {
  it('Umbrel and StartOS with their own setting: one line, the form folded under Advanced', () => {
    expect(serverPageMode(umbrel())).toBe('platform');
    expect(environmentLine(umbrel())).toBe("Connected to this Umbrel's Electrs and Bitcoin Core (set up by Umbrel).");
    expect(environmentLine(umbrel({ nodeRpc: undefined }))).toBe("Connected to this Umbrel's Electrs (set up by Umbrel).");
    expect(environmentLine(umbrel({ status: { connected: false, rescans: [] } }))).toBe("Not connected to this Umbrel's Electrs and Bitcoin Core (set up by Umbrel).");
    expect(serverPageMode(umbrel({ platform: 'start9' }))).toBe('platform');
    expect(environmentLine(umbrel({ platform: 'start9' }))).toBe("Connected to this StartOS server's Electrs and Bitcoin Core (set up by StartOS).");
    const core = umbrel({ environment: { kind: 'own', backend: 'core', host: '10.21.21.8', port: 8332 } });
    expect(environmentLine(core)).toBe("Connected to this Umbrel's Bitcoin Core (set up by Umbrel).");
    expect(backButton(umbrel())).toBeUndefined();
  });

  it('plain Docker keeps the form, with the .env file named', () => {
    const docker = umbrel({ platform: 'docker' });
    expect(serverPageMode(docker)).toBe('form');
    expect(environmentLine(docker)).toBe('Connected to the server in your .env file (your own Electrum server 10.21.21.10:50001).');
    // Older guardians say nothing of the platform: the form, as before.
    expect(serverPageMode(settings())).toBe('form');
    expect(serverPageMode(umbrel({ environment: undefined }))).toBe('form');
  });

  it('a server chosen here: shown, with the way back named for the platform', () => {
    expect(serverPageMode(chosen())).toBe('chosen');
    expect(environmentLine(chosen())).toBeUndefined();
    expect(backButton(chosen())).toEqual({
      label: 'Use the server Umbrel set',
      note: "Chosen here, so the guardian no longer follows Umbrel's setting (your own Electrum server 10.21.21.10:50001). Going back is announced like any change.",
    });
    expect(backButton(chosen({ platform: 'start9' }))?.label).toBe('Use the server StartOS set');
    expect(backButton(chosen({ platform: 'docker' }))?.label).toBe('Use the server in the .env file');
    // Nothing to go back to.
    expect(backButton(chosen({ environment: undefined }))).toBeUndefined();
  });

  it('"use Bitcoin Core alone" fills in the guardian\'s own node, whose password the guardian has', () => {
    const d = coreDraft(umbrel());
    expect(d).toMatchObject({ kind: 'core', host: '10.21.21.8', port: '8332', user: 'umbrel', pass: '' });
    expect(passKnown(d, umbrel())).toBe(true);
    expect(draftError(d, passKnown(d, umbrel()))).toBeUndefined();
    expect(inputFrom(d)).toEqual({ kind: 'core', rpc: { host: '10.21.21.8', port: 8332, user: 'umbrel' } });
    expect(passKnown({ ...d, user: 'other' }, umbrel())).toBe(false);
    // Another port on the same host needs the password again (the guardian refuses to send it there).
    expect(passKnown({ ...d, port: '9999' }, umbrel())).toBe(false);
    expect(draftError({ ...d, port: '9999' }, passKnown({ ...d, port: '9999' }, umbrel()))).toBeDefined();
    expect(coreDraft(umbrel({ nodeRpc: undefined }))).toMatchObject({ kind: 'core', host: '', user: '' });
  });
});

describe('Settings > Server: Save only when something changes', () => {
  it('disables Save while the form is the server in use', () => {
    const s = umbrel();
    const d = draftFrom(s);
    expect(draftUnchanged(d, s)).toBe(true);
    expect(draftUnchanged({ ...d, port: '' }, s)).toBe(true); // the default port
    expect(draftUnchanged({ ...d, host: ' 10.21.21.10 ' }, s)).toBe(true);
    expect(draftUnchanged({ ...d, port: '50002' }, s)).toBe(false);
    expect(draftUnchanged({ ...d, tls: true }, s)).toBe(false);
    expect(draftUnchanged({ ...d, host: 'electrs.lan' }, s)).toBe(false);
    expect(draftUnchanged(coreDraft(s), s)).toBe(false);
    expect(draftUnchanged(d, settings({ source: null }))).toBe(false);
  });

  it('a pinned certificate, a public server and Bitcoin Core: the same choice written another way is unchanged', () => {
    const FP = 'AB'.repeat(32);
    const pinned = settings({ source: { kind: 'electrum', host: 'f.lan', port: 50002, tls: true, certSha256: FP.replace(/(..)(?!$)/g, '$1:') } });
    expect(draftUnchanged({ ...draftFrom(pinned), certSha256: FP.toLowerCase() }, pinned)).toBe(true);
    expect(draftUnchanged({ ...draftFrom(pinned), certSha256: '' }, pinned)).toBe(false);
    const pub = settings({ source: { kind: 'public', host: 'mempool.space', port: 60602 } });
    expect(draftUnchanged(draftFrom(pub), pub)).toBe(true);
    expect(draftUnchanged({ ...draftFrom(pub), preset: '', host: 'electrum.example.org', port: '' }, pub)).toBe(false);
    // The RPC password is write-only: empty means unchanged, anything typed is a change.
    const core = settings({ source: { kind: 'core', rpc: { host: 'node', port: 8332, user: 'u', passSet: true } } });
    expect(draftUnchanged(draftFrom(core), core)).toBe(true);
    expect(draftUnchanged({ ...draftFrom(core), pass: 'p' }, core)).toBe(false);
    expect(draftUnchanged({ ...draftFrom(core), wallet: 'w' }, core)).toBe(false);
  });

  it('the mock: the same server again changes nothing; going back to Umbrel\'s is announced', async () => {
    const api = createMockApi('default');
    const s = await api.getChain();
    expect(s).toMatchObject({ origin: 'environment', platform: 'umbrel', environment: { host: '10.21.21.10' } });
    expect((await api.setChain(inputFrom(draftFrom(s)))).origin).toBe('environment');
    const changed = await api.setChain({ kind: 'electrum', host: 'fulcrum.lan', tls: true });
    expect(changed.origin).toBe('settings');
    const back = await api.resetChain();
    expect(back).toMatchObject({ origin: 'environment', source: { host: '10.21.21.10' } });
    const entries = (await api.listActivity({ limit: 10 })).map((e) => e.summary);
    expect(entries.filter((x) => x === 'Server changed')).toHaveLength(1);
    expect(entries).toContain("Server back to Umbrel's setting");
  }, 20_000);

  it('DELETE /api/chain', async () => {
    const sent: string[] = [];
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push(`${String(init.method)} ${url}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await createHttpApi().resetChain();
    expect(sent).toEqual(['DELETE /api/chain']);
    vi.unstubAllGlobals();
  });
});

describe('Electrs and Core 32 while the guardian covers it', () => {
  const m = { mempoolCause: 'electrs_core32' as const, mempoolServerSlow: true, mempoolViaNode: true };
  it('on Umbrel says nothing is needed and points at Umbrel, not at another server', () => {
    const t = mempoolText(m, { onServerPage: true, platform: 'umbrel' });
    expect(t.text).toContain('reads unconfirmed payments from Bitcoin Core');
    expect(t.detail).toContain('Nothing to do');
    expect(t.detail).toContain('Electrs update from Umbrel');
    expect(t.detail).not.toContain('Bitcoin Core alone');
  });
  it('elsewhere keeps both fixes', () => {
    expect(mempoolText(m, { onServerPage: true }).detail).toContain('choose Your own Bitcoin Core below');
  });
});
