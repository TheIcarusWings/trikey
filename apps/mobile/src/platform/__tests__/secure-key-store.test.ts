import { describe, expect, it, vi } from 'vitest';
import { SecureKeyError } from '../errors';
import { createSecureKeyStore, mapSecureStoreError, type SecureStoreBackend } from '../secure-key-store';

vi.mock('expo-secure-store', () => ({}));

/** A fake keychain. `invalidate` mimics biometrics changing: the item stays, reads return null. */
function fakeBackend(over: Partial<SecureStoreBackend> = {}) {
  const items = new Map<string, string>();
  const invalidated = new Set<string>();
  const calls: { op: string; key: string; options?: Parameters<SecureStoreBackend['setItemAsync']>[2] }[] = [];
  const backend: SecureStoreBackend = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    isAvailableAsync: async () => true,
    canUseBiometricAuthentication: () => true,
    async getItemAsync(key, options) {
      calls.push({ op: 'get', key, options });
      return invalidated.has(key) ? null : (items.get(key) ?? null);
    },
    async setItemAsync(key, value, options) {
      calls.push({ op: 'set', key, options });
      items.set(key, value);
      invalidated.delete(key);
    },
    async deleteItemAsync(key) {
      calls.push({ op: 'delete', key });
      items.delete(key);
      invalidated.delete(key);
    },
    ...over,
  };
  return { backend, items, invalidated, calls };
}

const seed = Uint8Array.from({ length: 64 }, (_, i) => i * 3);

describe('SecureKeyStore', () => {
  it('stores bytes as hex and loads them back', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    expect(items.get('k.key2')).toMatch(/^[0-9a-f]{128}$/);
    expect(await store.load('key2', 'Sign a payment')).toEqual(seed);
  });

  it('keeps the seed on this device only and behind biometrics when asked', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    const set = calls.find((c) => c.op === 'set' && c.key === 'k.key2')!;
    expect(set.options?.requireAuthentication).toBe(true);
    expect(set.options?.keychainAccessible).toBe(6); // WHEN_UNLOCKED_THIS_DEVICE_ONLY
    expect(set.options?.keychainService).toBe('trikey.keys');
  });

  it('passes the reason to the biometric prompt on load', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    await store.load('key2', 'Approve a 0.01 BTC payment');
    const get = calls.filter((c) => c.op === 'get' && c.key === 'k.key2').at(-1)!;
    expect(get.options?.authenticationPrompt).toBe('Approve a 0.01 BTC payment');
  });

  it('resolves null for a secret that was never saved', async () => {
    const store = createSecureKeyStore(fakeBackend().backend);
    expect(await store.load('nothing', 'x')).toBeNull();
  });

  it('verifies a silent save by reading it back', async () => {
    const { backend } = fakeBackend({
      async getItemAsync() {
        return 'deadbeef'; // differs from what was written
      },
    });
    const store = createSecureKeyStore(backend);
    await expect(store.save('key2', seed, { requireBiometrics: false })).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('reports biometrics-changed when the item is gone but its marker remains', async () => {
    const { backend, invalidated } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    invalidated.add('k.key2');
    await expect(store.load('key2', 'x')).rejects.toMatchObject({ code: 'biometrics-changed' });
  });

  it('does not confuse an invalidated key with a missing one after remove', async () => {
    const { backend, invalidated } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    invalidated.add('k.key2');
    await store.remove('key2');
    expect(await store.load('key2', 'x')).toBeNull();
  });

  it('remove deletes the secret and its marker', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: false });
    expect(items.size).toBe(2);
    await store.remove('key2');
    expect(items.size).toBe(0);
  });

  it('refuses to save behind biometrics when none is enrolled', async () => {
    const { backend, items } = fakeBackend({ canUseBiometricAuthentication: () => false });
    const store = createSecureKeyStore(backend);
    await expect(store.save('key2', seed, { requireBiometrics: true })).rejects.toMatchObject({ code: 'no-biometrics' });
    expect(items.size).toBe(0);
  });

  it('maps a cancelled prompt on load', async () => {
    const { backend } = fakeBackend();
    const store = createSecureKeyStore(backend);
    await store.save('key2', seed, { requireBiometrics: true });
    backend.getItemAsync = async () => {
      throw Object.assign(new Error('Could not authenticate the user: User canceled the authentication. Canceled'), {
        code: 'ERR_AUTHENTICATION',
      });
    };
    const err = await store.load('key2', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(SecureKeyError);
    expect(err.code).toBe('cancelled');
    expect(err.userMessage.length).toBeGreaterThan(10);
  });

  it('removes the secret if its marker cannot be written', async () => {
    const { backend, items } = fakeBackend();
    const realSet = backend.setItemAsync;
    backend.setItemAsync = async (key, value, options) => {
      if (key.startsWith('m.')) throw new Error('disk full');
      return realSet(key, value, options);
    };
    const store = createSecureKeyStore(backend);
    await expect(store.save('key2', seed, { requireBiometrics: false })).rejects.toBeInstanceOf(SecureKeyError);
    expect(items.size).toBe(0);
  });

  it('reports unavailable where there is no secure store (web, Expo Go)', async () => {
    const store = createSecureKeyStore(fakeBackend({ isAvailableAsync: async () => false }).backend);
    await expect(store.load('key2', 'x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.save('key2', seed, { requireBiometrics: false })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects ids that are not safe keychain names, and empty secrets', async () => {
    const store = createSecureKeyStore(fakeBackend().backend);
    await expect(store.load('../x', 'r')).rejects.toMatchObject({ code: 'invalid-id' });
    await expect(store.save('', seed, { requireBiometrics: false })).rejects.toMatchObject({ code: 'invalid-id' });
    await expect(store.save('key2', new Uint8Array(0), { requireBiometrics: false })).rejects.toThrow(TypeError);
  });

  it('flags a stored value that is not hex', async () => {
    const { backend, items } = fakeBackend();
    const store = createSecureKeyStore(backend);
    items.set('k.key2', 'not hex');
    await expect(store.load('key2', 'x')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('is marked secure', () => {
    expect(createSecureKeyStore(fakeBackend().backend).isSecure).toBe(true);
  });
});

describe('mapSecureStoreError', () => {
  const cases: [string, string, string][] = [
    // Android (BiometricPrompt strings wrapped by expo-secure-store)
    ['User canceled the authentication. Canceled', 'ERR_AUTHENTICATION', 'cancelled'],
    ['Could not authenticate the user: No biometrics enrolled. No biometrics', 'ERR_AUTHENTICATION', 'no-biometrics'],
    ['Could not authenticate the user: Hardware not present. x', 'ERR_AUTHENTICATION', 'no-biometrics'],
    ['Could not authenticate the user: Lockout. Too many attempts', 'ERR_AUTHENTICATION', 'lockout'],
    ['Could not authenticate the user: Lockout permanent. x', 'ERR_AUTHENTICATION', 'lockout'],
    ['Could not authenticate the user: Hardware unavailable. x', 'ERR_AUTHENTICATION', 'unavailable'],
    ['Could not authenticate the user: Timeout. x', 'ERR_AUTHENTICATION', 'authentication-failed'],
    ['Key permanently invalidated', 'ERR_SECURESTORE_DECRYPT', 'biometrics-changed'],
    // iOS (OSStatus descriptions)
    ['User canceled the operation.', 'ERR_KEY_CHAIN', 'cancelled'],
    ['Authentication failed. Provided passphrase/PIN is incorrect or there is no user authentication method configured for this device.', 'ERR_KEY_CHAIN', 'no-biometrics'],
    ['No keychain is available. You may need to restart your computer.', 'ERR_KEY_CHAIN', 'unavailable'],
    ['Invalid key', 'ERR_INVALID_KEY', 'invalid-id'],
    ['Unknown Keychain Error.', 'ERR_KEY_CHAIN', 'failed'],
  ];
  it.each(cases)('%s -> %s', (message, code, expected) => {
    expect(mapSecureStoreError(Object.assign(new Error(message), { code })).code).toBe(expected);
  });

  it('handles non-Error throws and keeps typed errors as they are', () => {
    expect(mapSecureStoreError('boom').code).toBe('failed');
    expect(mapSecureStoreError(undefined).code).toBe('failed');
    const typed = mapSecureStoreError(new Error('User canceled'));
    expect(mapSecureStoreError(typed)).toBe(typed);
  });

  it('every error has a user message and never leaks the secret', () => {
    const e = mapSecureStoreError(new Error('deadbeef'.repeat(16)));
    expect(e.userMessage).not.toContain('deadbeef');
  });
});
