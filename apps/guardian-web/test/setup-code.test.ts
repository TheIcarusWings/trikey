/**
 * First run on plain Docker: the setup code (checked before the passphrase, and sent with the setup), and the words
 * of the first-run screen there (the owner's own Electrum server, not the box's apps; the computer has to stay on).
 * Umbrel and Start9 keep their words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { createHttpApi } from '../src/api/http';
import { MOCK_SETUP_CODE, createMockApi } from '../src/api/mock';
import type { SetupPreflight } from '../src/api/types';
import { STAY_ON_NOTE, chainCheckCopy, setupCodeFormatError } from '../src/lib/setup';

const base: SetupPreflight = { node: 'found', electrs: 'found', synced: true, relayOptions: [] };

describe('the first-run chain check', () => {
  it('Umbrel and Start9 (and guardians that do not say): the box apps, as before', () => {
    expect(chainCheckCopy(base)).toEqual({ ok: true, title: 'Bitcoin Node and Electrs found' });
    expect(chainCheckCopy({ ...base, platform: 'umbrel', electrs: 'missing' })).toEqual({
      ok: false,
      title: 'Electrs not found',
      body: 'Install and start both apps on this box, then reload this page. The guardian only reads chain data from them.',
    });
    expect(chainCheckCopy({ ...base, synced: false, syncProgress: 0.42 }).body).toMatch(/Still syncing \(42%\)/);
  });

  it('plain Docker: the Electrum server from .env, and why it cannot be reached', () => {
    const docker = { ...base, platform: 'docker' as const };
    expect(chainCheckCopy(docker)).toEqual({ ok: true, title: 'Bitcoin node and Electrum server found' });
    const missing = chainCheckCopy({ ...docker, electrs: 'missing', node: 'missing', electrsProblem: 'connection refused: nothing listens on that port' });
    expect(missing.title).toBe('Electrum server not reachable');
    expect(missing.body).toMatch(/ELECTRUM_HOST, ELECTRUM_PORT and ELECTRUM_TLS/);
    expect(missing.body).toMatch(/The guardian says: connection refused/);
    expect(STAY_ON_NOTE).toMatch(/stay|on and awake/);
  });
});

describe('setup code input', () => {
  it('asks for 16 letters and digits, with any separators', () => {
    expect(setupCodeFormatError('')).toMatch(/Enter the setup code/);
    expect(setupCodeFormatError('ABCD-EFGH')).toMatch(/16 letters and digits/);
    expect(setupCodeFormatError('abcd efgh jkmn pqrs')).toBeUndefined();
    expect(setupCodeFormatError(MOCK_SETUP_CODE)).toBeUndefined();
  });
});

describe('the setup code over HTTP', () => {
  let sent: { method: string; url: string; body?: Record<string, unknown> }[];
  let answer: { status: number; body: unknown };

  beforeEach(() => {
    sent = [];
    answer = { status: 200, body: { ok: true } };
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('checks the code with POST /api/setup/code and sends it with the setup', async () => {
    const api = createHttpApi();
    await api.checkSetupCode('7K3M-Q9TX-2HWB-F4NR');
    expect(sent[0]).toEqual({ method: 'POST', url: '/api/setup/code', body: { code: '7K3M-Q9TX-2HWB-F4NR' } });
    answer = { status: 200, body: { setupComplete: true } };
    await api.completeSetup({ passphrase: 'correct horse battery staple', relays: ['wss://relay.example'], setupCode: '7K3M-Q9TX-2HWB-F4NR' });
    expect(sent[1]!.body).toMatchObject({ setupCode: '7K3M-Q9TX-2HWB-F4NR', relays: ['wss://relay.example'] });
  });

  it('a wrong code rejects with bad_setup_code', async () => {
    answer = { status: 401, body: { error: { code: 'bad_setup_code', message: 'That is not the setup code.' } } };
    const err = await createHttpApi()
      .checkSetupCode('AAAA-AAAA-AAAA-AAAA')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('bad_setup_code');
  });
});

describe('the mock (?mock=dockerfirstrun)', () => {
  it('asks for its code and refuses another one', async () => {
    const api = createMockApi('dockerfirstrun');
    expect(await api.getSetupPreflight()).toMatchObject({ platform: 'docker', setupCodeRequired: true });
    await expect(api.checkSetupCode('AAAA-AAAA-AAAA-AAAA')).rejects.toMatchObject({ code: 'bad_setup_code' });
    await expect(api.checkSetupCode(MOCK_SETUP_CODE.toLowerCase())).resolves.toBeUndefined();
    expect((await createMockApi('firstrun').getSetupPreflight()).setupCodeRequired).toBeUndefined();
  }, 20_000);
});
