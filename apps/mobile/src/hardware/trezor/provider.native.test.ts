/**
 * The Trezor provider's glue (Connect initialisation, deep-link callback forwarding, connect) with Trezor Connect,
 * expo-linking and React Native replaced by fakes. Real behaviour needs Trezor Suite Lite on a phone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'ios',
  listeners: [] as Array<(e: { url: string }) => void>,
  opened: [] as string[],
  connect: undefined as any,
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return h.platform; } } }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `trikey://${path}`,
  addEventListener: (_type: string, cb: (e: { url: string }) => void) => {
    h.listeners.push(cb);
    return { remove: () => void (h.listeners = h.listeners.filter((l) => l !== cb)) };
  },
  openURL: async (url: string) => void h.opened.push(url),
}));
vi.mock('@trezor/connect-mobile', () => {
  const connect = {
    init: vi.fn(async (_settings: any) => {}),
    handleDeeplink: vi.fn((_url: string) => {}),
    cancel: vi.fn((_reason?: string) => {}),
    getPublicKey: vi.fn(async (_params: any): Promise<any> => ({ success: true, payload: { xpub: 'tpubDUMMY', rootFingerprint: 0x0abc1234, fingerprint: 1, path: [], depth: 4 } })),
  };
  h.connect = connect;
  return { default: connect };
});

import { normalizeXpub } from '../common/xpub';
import { TREZOR_MANIFEST_DEFAULTS } from '../options';
import { TrezorProvider } from './provider.native';

beforeEach(() => {
  h.platform = 'ios';
  h.listeners = [];
  h.opened = [];
  for (const fn of Object.values(h.connect) as Array<{ mockClear?: () => void }>) fn.mockClear?.();
});

// A real tpub so `normalizeXpub` accepts the seeded key.
const REAL_TPUB = 'tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ';

describe('TrezorProvider (native glue)', () => {
  it('is available on phones', async () => {
    expect(new TrezorProvider().kinds).toEqual(['trezor']);
    expect(await new TrezorProvider().isAvailable()).toBe(true);
    h.platform = 'web';
    expect(await new TrezorProvider().isAvailable()).toBe(false);
  });

  it('initialises Connect once, with the project manifest and the callback URL, and opens deep links', async () => {
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 0x0abc1234, fingerprint: 1, path: [], depth: 4 } });
    const provider = new TrezorProvider({ network: 'testnet' });
    await provider.connect();
    await provider.connect();
    expect(h.connect.init).toHaveBeenCalledTimes(1);
    const settings = h.connect.init.mock.calls[0]![0];
    expect(settings.manifest).toEqual(TREZOR_MANIFEST_DEFAULTS);
    expect(settings.manifest.appUrl).toBe('https://github.com/TheIcarusWings/trikey');
    expect(settings.manifest.email).toBe('dev@trikey.app');
    expect(settings.deeplinkCallbackUrl).toBe('trikey://trezor-callback');
    settings.deeplinkOpen('https://connect.trezor.io/10/deeplink/1/?method=getPublicKey');
    await Promise.resolve();
    expect(h.opened).toEqual(['https://connect.trezor.io/10/deeplink/1/?method=getPublicKey']);
  });

  it('lets the app set the manifest and the callback path', async () => {
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 1, fingerprint: 1, path: [], depth: 4 } });
    await new TrezorProvider({ trezor: { manifest: { email: 'dev@example.org' }, callbackPath: 'back-from-trezor' } }).connect();
    const settings = h.connect.init.mock.calls[0]![0];
    expect(settings.manifest).toMatchObject({ email: 'dev@example.org', appName: 'Trikey' });
    expect(settings.deeplinkCallbackUrl).toBe('trikey://back-from-trezor');
  });

  it('forwards only its own callback URLs to Connect', async () => {
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 1, fingerprint: 1, path: [], depth: 4 } });
    await new TrezorProvider().connect();
    expect(h.listeners).toHaveLength(1);
    h.listeners[0]!({ url: 'trikey://trezor-callback?id=abc&response=%7B%7D' });
    h.listeners[0]!({ url: 'trikey://settings/limit' });
    expect(h.connect.handleDeeplink).toHaveBeenCalledTimes(1);
    expect(h.connect.handleDeeplink).toHaveBeenCalledWith('trikey://trezor-callback?id=abc&response=%7B%7D');
  });

  it('connects with one round trip: account key and master fingerprint, from the right path and coin', async () => {
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 0x0abc1234, fingerprint: 1, path: [], depth: 4 } });
    const signer = await new TrezorProvider({ network: 'signet' }).connect();
    expect(h.connect.getPublicKey).toHaveBeenCalledTimes(1);
    expect(h.connect.getPublicKey).toHaveBeenCalledWith({ path: "m/48'/1'/0'/2'", coin: 'test', showOnTrezor: false });
    expect(signer.info).toEqual({ kind: 'trezor', fingerprint: '0abc1234' });
    // The key fetched while connecting is handed to the signer: no second trip.
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(normalizeXpub(REAL_TPUB));
    expect(h.connect.getPublicKey).toHaveBeenCalledTimes(1);

    h.connect.getPublicKey.mockClear();
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8', rootFingerprint: 0xffffffff, fingerprint: 1, path: [], depth: 4 } });
    const main = await new TrezorProvider().connect();
    expect(h.connect.getPublicKey).toHaveBeenCalledWith({ path: "m/48'/0'/0'/2'", coin: 'btc', showOnTrezor: false });
    expect(main.info.fingerprint).toBe('ffffffff');
  });

  it('reports a Trezor without root fingerprint, and Suite errors, as typed errors', async () => {
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, fingerprint: 1, path: [], depth: 4 } });
    await expect(new TrezorProvider().connect()).rejects.toMatchObject({ code: 'device-error', message: expect.stringMatching(/fingerprint/) });
    h.connect.getPublicKey.mockResolvedValue({ success: false, payload: { error: 'Cancelled', code: 'Method_Cancel' } });
    await expect(new TrezorProvider().connect()).rejects.toMatchObject({ code: 'user-rejected', kind: 'trezor' });
  });

  it('retries initialisation after a failure, and honours abort', async () => {
    h.connect.init.mockRejectedValueOnce(new Error('Init_ManifestMissing'));
    const provider = new TrezorProvider();
    await expect(provider.connect()).rejects.toMatchObject({ kind: 'trezor' });
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 1, fingerprint: 1, path: [], depth: 4 } });
    await expect(provider.connect()).resolves.toBeDefined();
    expect(h.connect.init).toHaveBeenCalledTimes(2);

    const ac = new AbortController();
    ac.abort();
    await expect(provider.connect({ signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(provider.connect({ kind: 'ledger' })).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('cancels the request in flight when the signal aborts', async () => {
    let release: (v: unknown) => void = () => {};
    h.connect.getPublicKey.mockImplementation(() => new Promise((r) => (release = r)));
    const ac = new AbortController();
    const p = new TrezorProvider().connect({ signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(h.connect.cancel).toHaveBeenCalledWith('aborted');
    release({ success: false, payload: { error: 'Interrupted', code: 'Method_Interrupted' } });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});
