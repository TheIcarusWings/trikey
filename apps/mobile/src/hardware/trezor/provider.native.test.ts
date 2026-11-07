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

import { HARDENED as H } from '../common/path';
import { XPUB_VERSION, decodeXpub, encodeXpub, normalizeXpub } from '../common/xpub';
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
/** The same account key (depth 4, child 2') as a mainnet xpub. */
const REAL_XPUB = encodeXpub({ ...decodeXpub(REAL_TPUB), version: XPUB_VERSION });
const TEST_PATH = [48 + H, 1 + H, H, 2 + H];
const MAIN_PATH = [48 + H, H, H, 2 + H];
/** A Suite Lite answer for the test-network account key. */
const testKey = (extra: Record<string, unknown> = {}) => ({ success: true, payload: { xpub: REAL_TPUB, rootFingerprint: 1, fingerprint: 1, path: TEST_PATH, depth: 4, ...extra } });

/** What connect-mobile 10 opens for a call: Suite Lite's link, with our callback address and the call's id in it. */
function suiteLink(id: string, callback = 'trikey://trezor-callback') {
  return `https://connect.trezor.io/10/deeplink/1/?method=getPublicKey&params=%7B%7D&callback=${encodeURIComponent(`${callback}?id=${id}`)}&appName=Trikey`;
}

/** The callback address (with its token) inside a link Trikey opened. */
function callbackIn(opened: string): string {
  return new URL(opened).searchParams.get('callback')!;
}

describe('TrezorProvider (native glue)', () => {
  it('is available on phones', async () => {
    expect(new TrezorProvider().kinds).toEqual(['trezor']);
    expect(await new TrezorProvider().isAvailable()).toBe(true);
    h.platform = 'web';
    expect(await new TrezorProvider().isAvailable()).toBe(false);
  });

  it('initialises Connect once, with the project manifest and the callback URL, and opens deep links', async () => {
    h.connect.getPublicKey.mockResolvedValue(testKey({ rootFingerprint: 0x0abc1234 }));
    const provider = new TrezorProvider({ network: 'testnet' });
    await provider.connect();
    await provider.connect();
    expect(h.connect.init).toHaveBeenCalledTimes(1);
    const settings = h.connect.init.mock.calls[0]![0];
    expect(settings.manifest).toEqual(TREZOR_MANIFEST_DEFAULTS);
    expect(settings.manifest.appUrl).toBe('https://github.com/TheIcarusWings/trikey');
    expect(settings.manifest.email).toBe('dev@trikey.app');
    expect(settings.deeplinkCallbackUrl).toBe('trikey://trezor-callback');
    settings.deeplinkOpen(suiteLink('42'));
    await Promise.resolve();
    // Opened as connect-mobile built it, with a one-time token added to the callback address.
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]!.replace(/(callback=[^&]*)/, '')).toBe(suiteLink('42').replace(/(callback=[^&]*)/, ''));
    expect(callbackIn(h.opened[0]!)).toMatch(/^trikey:\/\/trezor-callback\?id=42&t=[0-9a-f]{32}$/);
    // A link without a callback Trikey can read is never opened: the call fails instead.
    settings.deeplinkOpen('https://connect.trezor.io/10/deeplink/1/?method=getPublicKey');
    await Promise.resolve();
    expect(h.opened).toHaveLength(1);
    expect(h.connect.cancel).toHaveBeenCalledWith(expect.stringMatching(/could not read the request/));
  });

  it('lets the app set the manifest and the callback path', async () => {
    h.connect.getPublicKey.mockResolvedValue(testKey());
    await new TrezorProvider({ network: 'testnet', trezor: { manifest: { email: 'dev@example.org' }, callbackPath: 'back-from-trezor' } }).connect();
    const settings = h.connect.init.mock.calls[0]![0];
    expect(settings.manifest).toMatchObject({ email: 'dev@example.org', appName: 'Trikey' });
    expect(settings.deeplinkCallbackUrl).toBe('trikey://back-from-trezor');
  });

  it('forwards to Connect only the reply to a request still waiting, with its one-time token', async () => {
    h.connect.getPublicKey.mockResolvedValue(testKey());
    await new TrezorProvider({ network: 'testnet' }).connect();
    expect(h.listeners).toHaveLength(1);
    const settings = h.connect.init.mock.calls[0]![0];
    settings.deeplinkOpen(suiteLink('abc'));
    const callback = callbackIn(h.opened.at(-1)!);
    const listener = h.listeners[0]!;
    // Anything that opens the link without the token is dropped: another app, a web page, a guessed id, another path.
    listener({ url: 'trikey://trezor-callback?id=abc&response=%7B%7D' });
    listener({ url: 'trikey://trezor-callback?id=abc&t=00000000000000000000000000000000&response=%7B%7D' });
    listener({ url: `${callback.replace('trezor-callback', 'trezor-callbackX')}&response=%7B%7D` });
    listener({ url: `${callback.replace('id=abc', 'id=abd')}&response=%7B%7D` });
    listener({ url: 'trikey://settings/limit' });
    expect(h.connect.handleDeeplink).not.toHaveBeenCalled();
    // Suite Lite's reply: the callback as sent, with the response added. Passed on once, as id and response only.
    listener({ url: `${callback}&response=${encodeURIComponent('{"success":true}')}` });
    expect(h.connect.handleDeeplink).toHaveBeenCalledTimes(1);
    expect(h.connect.handleDeeplink).toHaveBeenCalledWith(`trikey://trezor-callback?id=abc&response=${encodeURIComponent('{"success":true}')}`);
    // The token is used up: a second reply (a copy, or a forged one after it) is dropped.
    listener({ url: `${callback}&response=${encodeURIComponent('{"success":true,"payload":{}}')}` });
    expect(h.connect.handleDeeplink).toHaveBeenCalledTimes(1);
    // connect-mobile throws on a result that is not JSON (after failing the call); the listener must not.
    settings.deeplinkOpen(suiteLink('def'));
    const second = callbackIn(h.opened.at(-1)!);
    h.connect.handleDeeplink.mockImplementationOnce(() => {
      throw new TypeError("Cannot destructure property 'success' of 'parsedParams' as it is undefined.");
    });
    expect(() => listener({ url: `${second}&response=nope` })).not.toThrow();
  });

  it('connects with one round trip: account key and master fingerprint, from the right path and coin', async () => {
    h.connect.getPublicKey.mockResolvedValue(testKey({ rootFingerprint: 0x0abc1234 }));
    const signer = await new TrezorProvider({ network: 'signet' }).connect();
    expect(h.connect.getPublicKey).toHaveBeenCalledTimes(1);
    expect(h.connect.getPublicKey).toHaveBeenCalledWith({ path: "m/48'/1'/0'/2'", coin: 'test', showOnTrezor: false });
    expect(signer.info).toEqual({ kind: 'trezor', fingerprint: '0abc1234' });
    // The key fetched while connecting is handed to the signer: no second trip.
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(normalizeXpub(REAL_TPUB));
    expect(h.connect.getPublicKey).toHaveBeenCalledTimes(1);

    h.connect.getPublicKey.mockClear();
    h.connect.getPublicKey.mockResolvedValue({ success: true, payload: { xpub: REAL_XPUB, rootFingerprint: 0xffffffff, fingerprint: 1, path: MAIN_PATH, depth: 4 } });
    const main = await new TrezorProvider().connect();
    expect(h.connect.getPublicKey).toHaveBeenCalledWith({ path: "m/48'/0'/0'/2'", coin: 'btc', showOnTrezor: false });
    expect(main.info.fingerprint).toBe('ffffffff');
  });

  it('refuses a key that is not the one asked for: another path, another place in the tree, another network', async () => {
    const provider = new TrezorProvider({ network: 'testnet' });
    h.connect.getPublicKey.mockResolvedValue(testKey({ path: [48 + H, 1 + H, H, 1 + H] }));
    await expect(provider.connect()).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/different path/) });
    h.connect.getPublicKey.mockResolvedValue(testKey({ path: undefined }));
    await expect(provider.connect()).rejects.toMatchObject({ code: 'invalid-response' });
    // The path echoed right, but the key itself is the master key (depth 0).
    h.connect.getPublicKey.mockResolvedValue(testKey({ xpub: encodeXpub({ ...decodeXpub(REAL_TPUB), depth: 0, childNumber: 0 }) }));
    await expect(provider.connect()).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/not the one at the path/) });
    h.connect.getPublicKey.mockResolvedValue(testKey({ xpub: REAL_XPUB }));
    await expect(provider.connect()).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/wrong network/) });
  });

  it('reports a Trezor without root fingerprint, and Suite errors, as typed errors', async () => {
    h.connect.getPublicKey.mockResolvedValue(testKey({ rootFingerprint: undefined }));
    await expect(new TrezorProvider().connect()).rejects.toMatchObject({ code: 'device-error', message: expect.stringMatching(/fingerprint/) });
    h.connect.getPublicKey.mockResolvedValue({ success: false, payload: { error: 'Cancelled', code: 'Method_Cancel' } });
    await expect(new TrezorProvider().connect()).rejects.toMatchObject({ code: 'user-rejected', kind: 'trezor' });
  });

  it('retries initialisation after a failure, and honours abort', async () => {
    h.connect.init.mockRejectedValueOnce(new Error('Init_ManifestMissing'));
    const provider = new TrezorProvider({ network: 'testnet' });
    await expect(provider.connect()).rejects.toMatchObject({ kind: 'trezor' });
    h.connect.getPublicKey.mockResolvedValue(testKey());
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
    // What connect-mobile's cancel(reason) resolves the call in flight with: no `success`, the reason as the error.
    release({ payload: { success: false, error: 'aborted' } });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});
