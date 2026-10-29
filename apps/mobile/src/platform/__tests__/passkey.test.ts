import { describe, expect, it } from 'vitest';
import { bytesToBase64, bytesToBase64Url } from '../bytes';
import { PasskeyError } from '../errors';
import { createPasskeyPrf, mapPasskeyError, osSupportsPasskeyPrf } from '../passkey';

const salt = new TextEncoder().encode('trikey backup key v1');
const prf = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

type Req = Record<string, any>;

/** A fake `react-native-passkey`. */
function fakePasskey(over: { create?: (r: Req) => Promise<unknown>; get?: (r: Req) => Promise<unknown>; supported?: boolean } = {}) {
  const requests: { op: 'create' | 'get'; req: Req }[] = [];
  const Passkey = {
    isSupported: () => over.supported ?? true,
    async create(req: Req) {
      requests.push({ op: 'create', req });
      return over.create ? over.create(req) : { id: 'cred-1', clientExtensionResults: { prf: { enabled: true, results: { first: bytesToBase64(prf) } } } };
    },
    async get(req: Req) {
      requests.push({ op: 'get', req });
      return over.get ? over.get(req) : { id: 'cred-1', clientExtensionResults: { prf: { results: { first: bytesToBase64Url(prf) } } } };
    },
  };
  return { load: (async () => ({ Passkey })) as never, requests };
}

const rpId = 'wallet.example.com';
const ios = { os: 'ios', osVersion: '18.1' } as const;

describe('osSupportsPasskeyPrf', () => {
  it('needs iOS 18 or Android 9 (Credential Manager)', () => {
    expect(osSupportsPasskeyPrf('ios', '17.6')).toBe(false);
    expect(osSupportsPasskeyPrf('ios', '18.0')).toBe(true);
    expect(osSupportsPasskeyPrf('ios', '26.1')).toBe(true);
    expect(osSupportsPasskeyPrf('android', 27)).toBe(false);
    expect(osSupportsPasskeyPrf('android', 34)).toBe(true);
    expect(osSupportsPasskeyPrf('web', 1)).toBe(false);
  });
});

describe('isSupported', () => {
  it('is false with no relying party id configured', async () => {
    const f = fakePasskey();
    expect(await createPasskeyPrf({ rpId: null, ...ios, load: f.load }).isSupported()).toBe(false);
  });

  it('is false on an OS that is too old, without even loading the module', async () => {
    let loaded = false;
    const p = createPasskeyPrf({ rpId, os: 'ios', osVersion: '17.5', load: (async () => ((loaded = true), {})) as never });
    expect(await p.isSupported()).toBe(false);
    expect(loaded).toBe(false);
  });

  it('is false when the native module is missing or reports no support', async () => {
    expect(await createPasskeyPrf({ rpId, ...ios, load: async () => Promise.reject(new Error('missing')) }).isSupported()).toBe(false);
    expect(await createPasskeyPrf({ rpId, ...ios, load: fakePasskey({ supported: false }).load }).isSupported()).toBe(false);
  });

  it('is true when configured, new enough and available', async () => {
    expect(await createPasskeyPrf({ rpId, ...ios, load: fakePasskey().load }).isSupported()).toBe(true);
    expect(await createPasskeyPrf({ rpId, os: 'android', osVersion: 34, load: fakePasskey().load }).isSupported()).toBe(true);
  });

  it('create and get reject with "unsupported" when not supported', async () => {
    const p = createPasskeyPrf({ rpId: null, ...ios, load: fakePasskey().load });
    await expect(p.create({ userName: 'me', salt })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(p.get({ salt })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('create', () => {
  it('asks for a resident, user-verified passkey with PRF and the salt', async () => {
    const f = fakePasskey();
    const p = createPasskeyPrf({ rpId, ...ios, load: f.load });
    const result = await p.create({ userName: 'Trikey wallet', salt });
    const req = f.requests[0]!.req;
    expect(req.rp).toEqual({ id: rpId, name: 'Trikey' });
    expect(req.user.name).toBe('Trikey wallet');
    expect(req.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(req.user.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(req.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
    expect(req.extensions.prf.eval.first).toEqual(salt);
    expect(req.pubKeyCredParams.map((c: { alg: number }) => c.alg)).toEqual([-7, -257]);
    expect(result).toEqual({ credentialId: 'cred-1', prfOutput: prf });
  });

  it('uses a different challenge every time', async () => {
    const f = fakePasskey();
    const p = createPasskeyPrf({ rpId, ...ios, load: f.load });
    await p.create({ userName: 'a', salt });
    await p.create({ userName: 'b', salt });
    expect(f.requests[0]!.req.challenge).not.toBe(f.requests[1]!.req.challenge);
  });

  it('does not let the caller change the salt after the call', async () => {
    const f = fakePasskey();
    const mine = salt.slice();
    await createPasskeyPrf({ rpId, ...ios, load: f.load }).create({ userName: 'a', salt: mine });
    mine.fill(0);
    expect(f.requests[0]!.req.extensions.prf.eval.first).toEqual(salt);
  });

  it('accepts base64url PRF output (Android) as well as base64 (iOS)', async () => {
    const f = fakePasskey({
      create: async () => ({ id: 'c', clientExtensionResults: { prf: { enabled: true, results: { first: bytesToBase64Url(prf) } } } }),
    });
    expect((await createPasskeyPrf({ rpId, os: 'android', osVersion: 34, load: f.load }).create({ userName: 'a', salt })).prfOutput).toEqual(prf);
  });

  it('evaluates PRF with a second request when creation only says "enabled"', async () => {
    const f = fakePasskey({ create: async () => ({ id: 'cred-9', clientExtensionResults: { prf: { enabled: true } } }) });
    const result = await createPasskeyPrf({ rpId, ...ios, load: f.load }).create({ userName: 'a', salt });
    expect(f.requests.map((r) => r.op)).toEqual(['create', 'get']);
    expect(f.requests[1]!.req.allowCredentials).toEqual([{ type: 'public-key', id: 'cred-9' }]);
    expect(result).toEqual({ credentialId: 'cred-9', prfOutput: prf });
  });

  it('reports prf-unavailable when the passkey provider has no PRF', async () => {
    for (const clientExtensionResults of [undefined, {}, { prf: { enabled: false } }]) {
      const f = fakePasskey({ create: async () => ({ id: 'c', clientExtensionResults }) });
      await expect(createPasskeyPrf({ rpId, ...ios, load: f.load }).create({ userName: 'a', salt })).rejects.toMatchObject({
        code: 'prf-unavailable',
      });
    }
  });

  it('rejects an output that is not 32 bytes', async () => {
    const f = fakePasskey({
      create: async () => ({ id: 'c', clientExtensionResults: { prf: { enabled: true, results: { first: bytesToBase64(new Uint8Array(16)) } } } }),
      get: async () => ({ id: 'c', clientExtensionResults: { prf: { results: { first: bytesToBase64(new Uint8Array(16)) } } } }),
    });
    await expect(createPasskeyPrf({ rpId, ...ios, load: f.load }).create({ userName: 'a', salt })).rejects.toMatchObject({ code: 'prf-unavailable' });
  });

  it('rejects an empty salt', async () => {
    await expect(createPasskeyPrf({ rpId, ...ios, load: fakePasskey().load }).create({ userName: 'a', salt: new Uint8Array(0) })).rejects.toThrow(TypeError);
  });
});

describe('get', () => {
  it('targets one credential when given its id', async () => {
    const f = fakePasskey();
    const result = await createPasskeyPrf({ rpId, ...ios, load: f.load }).get({ credentialId: 'cred-1', salt });
    const req = f.requests[0]!.req;
    expect(req.rpId).toBe(rpId);
    expect(req.allowCredentials).toEqual([{ type: 'public-key', id: 'cred-1' }]);
    expect(req.userVerification).toBe('required');
    expect(req.extensions.prf.eval.first).toEqual(salt);
    expect(result).toEqual({ credentialId: 'cred-1', prfOutput: prf });
  });

  it('lets the user pick any synced passkey when no id is given', async () => {
    const f = fakePasskey({ get: async () => ({ id: 'other', clientExtensionResults: { prf: { results: { first: bytesToBase64(prf) } } } }) });
    const result = await createPasskeyPrf({ rpId, ...ios, load: f.load }).get({ salt });
    expect(f.requests[0]!.req.allowCredentials).toEqual([]);
    expect(result.credentialId).toBe('other');
  });

  it('reports prf-unavailable when no output comes back', async () => {
    const f = fakePasskey({ get: async () => ({ id: 'c', clientExtensionResults: {} }) });
    await expect(createPasskeyPrf({ rpId, ...ios, load: f.load }).get({ salt })).rejects.toMatchObject({ code: 'prf-unavailable' });
  });

  it('maps library rejections, which are plain { error, message } objects', async () => {
    const f = fakePasskey({ get: async () => Promise.reject({ error: 'UserCancelled', message: 'The user cancelled the request.' }) });
    const err = await createPasskeyPrf({ rpId, ...ios, load: f.load }).get({ salt }).catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(err.code).toBe('cancelled');
  });
});

describe('mapPasskeyError', () => {
  it.each([
    [{ error: 'UserCancelled', message: 'x' }, 'cancelled'],
    [{ error: 'Interrupted', message: 'x' }, 'cancelled'],
    [{ error: 'NoCredentials', message: 'x' }, 'no-credential'],
    [{ error: 'BadConfiguration', message: 'x' }, 'bad-configuration'],
    [{ error: 'CredentialAlreadyExists', message: 'x' }, 'already-exists'],
    [{ error: 'TimedOut', message: 'x' }, 'timeout'],
    [{ error: 'NotSupported', message: 'x' }, 'unsupported'],
    [{ error: 'NoCreateOption', message: 'x' }, 'unsupported'],
    [{ error: 'RequestFailed', message: 'x' }, 'failed'],
    [{ error: 'Native error', message: 'The RP ID "x.com" cannot be validated.' }, 'bad-configuration'],
    [{ error: 'Native error', message: 'Application is not associated with domain' }, 'bad-configuration'],
    [new Error('boom'), 'failed'],
    ['boom', 'failed'],
    [undefined, 'failed'],
  ])('%j -> %s', (input, code) => {
    expect(mapPasskeyError(input).code).toBe(code);
  });

  it('every code has a plain-language message', () => {
    for (const e of [{ error: 'UserCancelled' }, { error: 'NoCredentials' }, { error: 'TimedOut' }]) {
      expect(mapPasskeyError(e).userMessage).toMatch(/passkey|Trikey/i);
    }
  });
});
