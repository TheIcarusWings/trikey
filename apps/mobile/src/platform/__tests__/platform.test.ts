import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web', Version: 0 } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6 }));

const { createPlatform, firstAvailableBackup } = await import('../index');

describe('createPlatform on web', () => {
  const p = createPlatform({ os: 'web' });

  it('uses in-memory fallbacks and marks them not secure', async () => {
    expect(p.os).toBe('web');
    expect(p.isSecure).toBe(false);
    expect(p.secureKeys.isSecure).toBe(false);
    expect(p.kv.isSecure).toBe(false);
    expect(p.cloudBackup.isSecure).toBe(false);
    expect(p.cloudBackup.provider).toBe('file');
    expect(p.cloudBackups).toEqual([p.cloudBackup]);
  });

  it('the fallbacks work end to end', async () => {
    await p.secureKeys.save('key2', Uint8Array.of(1, 2, 3), { requireBiometrics: true });
    expect(await p.secureKeys.load('key2', 'x')).toEqual(Uint8Array.of(1, 2, 3));
    await p.kv.set('a', 'b');
    expect(await p.kv.get('a')).toBe('b');
    await p.cloudBackup.write('x.bak', Uint8Array.of(9, 9));
    expect(await p.cloudBackup.read('x.bak')).toEqual(Uint8Array.of(9, 9));
  });

  it('has no passkeys', async () => {
    expect(await p.passkeys.isSupported()).toBe(false);
    await expect(p.passkeys.get({ salt: Uint8Array.of(1) })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('createPlatform on iOS and Android', () => {
  it('iOS: iCloud first, then the file provider; secure storage', () => {
    const p = createPlatform({ os: 'ios', osVersion: '18.2', config: { googleClientId: null, passkeyRpId: null } });
    expect(p.isSecure).toBe(true);
    expect(p.secureKeys.isSecure).toBe(true);
    expect(p.cloudBackup.provider).toBe('icloud');
    expect(p.cloudBackups.map((c) => c.provider)).toEqual(['icloud', 'file']);
  });

  it('Android: Google Drive first, then the file provider', () => {
    const p = createPlatform({ os: 'android', osVersion: 34, config: { googleClientId: null, passkeyRpId: null } });
    expect(p.cloudBackups.map((c) => c.provider)).toEqual(['google-drive', 'file']);
  });

  it('can put the file provider first for development', () => {
    const p = createPlatform({ os: 'android', osVersion: 34, preferFileBackup: true, config: { googleClientId: null } });
    expect(p.cloudBackups.map((c) => c.provider)).toEqual(['file', 'google-drive']);
    expect(p.cloudBackup.provider).toBe('file');
  });

  it('Google Drive is unavailable and passkeys unsupported when the publisher has not configured them', async () => {
    const p = createPlatform({ os: 'android', osVersion: 34, config: { googleClientId: null, passkeyRpId: null } });
    expect(await p.cloudBackup.isAvailable()).toBe(false);
    expect(await p.passkeys.isSupported()).toBe(false);
  });

  it('reads nothing from the environment unless it is set (no hard-coded ids)', async () => {
    vi.stubEnv('EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('EXPO_PUBLIC_PASSKEY_RP_ID', '');
    const p = createPlatform({ os: 'android', osVersion: 34 });
    expect(await p.cloudBackup.isAvailable()).toBe(false);
    expect(await p.passkeys.isSupported()).toBe(false);
  });

  it('firstAvailableBackup picks the first provider that says yes', async () => {
    const mk = (provider: 'icloud' | 'file', ok: boolean) => ({ provider, isAvailable: async () => ok }) as never;
    expect((await firstAvailableBackup({ cloudBackups: [mk('icloud', false), mk('file', true)] }))?.provider).toBe('file');
    expect((await firstAvailableBackup({ cloudBackups: [mk('icloud', true), mk('file', true)] }))?.provider).toBe('icloud');
    expect(await firstAvailableBackup({ cloudBackups: [mk('icloud', false)] })).toBeNull();
  });
});
