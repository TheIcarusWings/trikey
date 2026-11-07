/**
 * A Jade over Bluetooth, end to end in the app's hardware layer: the Jade provider and signer, the bridge the screen
 * drives, and a fake Jade (../test/fake-jade-ble.ts, written from the firmware) behind a fake Bluetooth link, with a fake
 * blind PIN server. Covers connecting and unlocking (the PIN-server relay and its notice, failures, a wrong PIN, old
 * firmware, no Bluetooth), registering the wallet and showing an address, payments (good, a signature that does not
 * verify, another transaction, a missing signature, a reply in several parts), and Trikey's texts (deterministic, never
 * anti-exfil, checked against the key: another key, another text, garbage).
 */
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { parsePsbt } from '@trikey/core';
import { verifyBip137Message } from '@trikey/wallet';
import { MNEMONICS, hwSigner } from '../../../../../packages/core/test/helpers';
import { HARDENED } from '../common/path';
import { describeHardwareError } from '../errors';
import { parseWalletPolicy } from '../common/wallet';
import { FakeJade, fakePinServer } from '../test/fake-jade-ble';
import { makeFixture, network } from '../test/fixtures';
import { JadeBleBridge, memoryNoticeStore, memoryPinServerStore, type JadeBridgeScreen } from './bridge';
import { noBle } from './link';
import { BLOCKSTREAM_PIN_SERVERS, hostOf, parseHttpRequest, parsePinServerUrl, pickPinServerUrl, relayHttpRequest, unlockJade } from './pin-server';
import type { JadeRpc } from './rpc';
import { JadeBleProvider, PIN_SERVER_NOTICE, versionAtLeast } from './provider';
import { JadeSigner, fingerprintOfRoot, jadeNetwork, jadeWalletName, registerMultisigParams } from './signer';

const H = HARDENED;
const AUTH = "m/48'/1'/0'/2'/0/0";
const TEXT = `Trikey pair v1 wallet=0123456789abcdef guardian=03${'ab'.repeat(32)}`;

/** Plays the owner in front of the sheet: answers the PIN-server notice (yes unless told otherwise) and records screens. */
function owner(bridge: JadeBleBridge, opts: { acceptNotice?: boolean; acceptServer?: boolean } = {}) {
  const screens: JadeBridgeScreen[] = [];
  bridge.subscribe(() => {
    const s = bridge.getSnapshot();
    if (!s) return;
    screens.push(s);
    const yes = s.title === 'A PIN server Trikey does not know' ? opts.acceptServer !== false : opts.acceptNotice !== false;
    if (s.type === 'confirm') queueMicrotask(() => (yes ? bridge.proceed() : bridge.cancel()));
  });
  return screens;
}

async function setup(jadeOpts: Partial<ConstructorParameters<typeof FakeJade>[0]> = {}, ownerOpts: { acceptNotice?: boolean; acceptServer?: boolean } = {}) {
  const f = await makeFixture();
  const jade = new FakeJade({ mnemonic: MNEMONICS.hardware, ...jadeOpts });
  const link = jade.link();
  const bridge = new JadeBleBridge(link);
  const screens = owner(bridge, ownerOpts);
  const server = fakePinServer();
  const notices = memoryNoticeStore();
  const pinServers = memoryPinServerStore();
  const provider = new JadeBleProvider({ network: 'regtest', bridge, fetch: server.fetch, notices, pinServers, now: () => 1_800_000_000 });
  return { f, jade, link, bridge, screens, server, notices, pinServers, provider };
}

async function connected() {
  const s = await setup();
  const signer = (await s.provider.connect({ kind: 'jade-ble' })) as JadeSigner;
  return { ...s, signer };
}

describe('JadeBleProvider: finding, pairing and unlocking', () => {
  it('unlocks a locked Jade through its PIN server, after the one-time notice, and reads its fingerprint', async () => {
    const { jade, provider, screens, server, bridge } = await setup();
    expect(provider.kinds).toEqual(['jade-ble']);
    expect(await provider.isAvailable()).toBe(true);
    const signer = await provider.connect({ kind: 'jade-ble' });
    expect(signer.info).toEqual({ kind: 'jade-ble', model: 'Jade Plus', fingerprint: jade.fingerprint });
    expect(signer.info.fingerprint).toBe(hwSigner().master(network).fingerprint.toString(16).padStart(8, '0'));
    expect(jade.isUnlocked).toBe(true);
    // The notice, then the PIN, then the relay; the sheet is gone at the end.
    expect(screens.map((s) => s.title)).toEqual([
      'Looking for your Jade',
      'Connecting to Jade ABC123',
      'Your Jade’s PIN server',
      'Enter your PIN on the Jade',
      'Checking your PIN',
    ]);
    expect(screens[2]).toMatchObject({ type: 'confirm', instructions: PIN_SERVER_NOTICE });
    expect(PIN_SERVER_NOTICE).toMatch(/Blockstream’s, unless you set your own.*IP address.*never your PIN or your keys.*QR mode/);
    expect(bridge.getSnapshot()).toBeUndefined();
    // The phone POSTed the Jade's payload, as JSON, to the https URL the Jade gave (never the onion), and passed the answer back.
    expect(server.calls).toEqual([{ url: 'https://j8d.io/get_pin', body: expect.stringMatching(/^\{"data":"[A-Za-z0-9+/=]+"\}$/) }]);
    expect(jade.requests.map((r) => r.method)).toEqual(['get_version_info', 'auth_user', 'pin', 'get_xpub']);
    expect(jade.requests[1]!.params).toEqual({ network: 'localtest', epoch: 1_800_000_000 });
    expect(jade.requests[2]!.params).toEqual({ data: expect.stringMatching(/^server:/) });
    expect(jade.requests[3]!.params).toEqual({ network: 'localtest', path: [] });
  });

  it('shows the notice once only', async () => {
    const s = await setup();
    await (await s.provider.connect()).close();
    const before = s.screens.length;
    await s.provider.connect();
    expect(s.screens.slice(before).map((x) => x.title)).not.toContain('Your Jade’s PIN server');
  });

  it('stops, with nothing sent to the PIN server, when the owner declines the notice', async () => {
    const s = await setup({}, { acceptNotice: false });
    await expect(s.provider.connect()).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.server.calls).toEqual([]);
    expect(s.jade.requests.map((r) => r.method)).toEqual(['get_version_info']);
    expect(await s.notices.seen()).toBe(false);
  });

  it('needs no PIN when the Jade is already unlocked over Bluetooth', async () => {
    const s = await setup({ unlocked: true });
    await s.provider.connect();
    expect(s.server.calls).toEqual([]);
    expect(s.jade.requests.map((r) => r.method)).toEqual(['get_version_info', 'get_xpub']);
  });

  it('says so on a wrong PIN (the Jade counts it), in words the screens keep', async () => {
    const s = await setup({ pinRight: false });
    const err = await s.provider.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'device-locked', message: expect.stringMatching(/Wrong PIN.*three wrong PINs/) });
    expect(describeHardwareError(err)).toMatch(/Wrong PIN.*three wrong PINs/);
    expect(s.jade.conn!.closed).toBe(true);
  });

  it('when the PIN server cannot be reached: an empty pin, the Jade asks to retry, and the phone says why', async () => {
    const s = await setup();
    s.server.failWith = 503;
    const err = await s.provider.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/PIN server \(j8d\.io\) answered with an error \(HTTP 503\).*stayed locked/) });
    // The Jade got "pin" with no params (handle_pin: PIN_CAN_RETRY) and the owner chose not to retry.
    expect(s.jade.requests.map((r) => [r.method, r.params === undefined])).toEqual([
      ['get_version_info', true],
      ['auth_user', false],
      ['pin', true],
    ]);
    expect(s.screens.map((x) => x.title)).toContain('The PIN server could not be reached');
    expect(s.screens.find((x) => x.title === 'The PIN server could not be reached')!.hint).toMatch(/HTTP 503/);
  });

  it('retries when the owner says so on the Jade', async () => {
    const s = await setup();
    s.server.unreachable = true;
    s.jade.retryPinServer = true;
    let calls = 0;
    const real = s.server.fetch;
    s.server.fetch = async (url, init) => {
      if (++calls === 2) s.server.unreachable = false;
      return real(url, init);
    };
    const provider = new JadeBleProvider({ network: 'regtest', bridge: s.bridge, fetch: s.server.fetch, notices: s.notices });
    await provider.connect();
    expect(s.jade.isUnlocked).toBe(true);
    expect(s.jade.requests.map((r) => r.method)).toEqual(['get_version_info', 'auth_user', 'pin', 'pin', 'get_xpub']);
  });

  it('never uses plain http or an onion address for the PIN server', async () => {
    const httpOnly = await setup({ pinServerUrls: ['http://pins.example.lan/get_pin'] });
    await expect(httpOnly.provider.connect()).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/plain http address.*only reaches a PIN server over https/) });
    expect(httpOnly.server.calls).toEqual([]);
    const onionOnly = await setup({ pinServerUrls: ['http://mrrxtq6tjpbnbm7vh5jt6mpjctn7ggyfy5wegvbeff3x7jrznqawlmid.onion/get_pin'] });
    await expect(onionOnly.provider.connect()).rejects.toMatchObject({ message: expect.stringMatching(/only an onion address.*no Tor/) });
    expect(onionOnly.server.calls).toEqual([]);
    // The owner's own server over https: used once the owner says it is theirs, and not asked again.
    const own = await setup({ pinServerUrls: ['https://pin.example.org/get_pin', 'http://abc.onion/get_pin'] });
    await (await own.provider.connect()).close();
    expect(own.server.calls.map((c) => c.url)).toEqual(['https://pin.example.org/get_pin']);
    const asked = own.screens.filter((x) => x.title === 'A PIN server Trikey does not know');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ type: 'confirm', instructions: expect.stringMatching(/pin\.example\.org.*not Blockstream’s.*set this server on your Jade yourself/) });
    expect(await own.pinServers.list()).toEqual(['pin.example.org']);
    await own.provider.connect();
    expect(own.server.calls).toHaveLength(2);
    expect(own.screens.filter((x) => x.title === 'A PIN server Trikey does not know')).toHaveLength(1);
  });

  it('never lets a Jade (or anything claiming to be one) point the phone at an address on its network', async () => {
    for (const url of [
      'https://10.0.0.5:8443/admin',
      'https://192.168.1.1/get_pin',
      'https://[fd00::1]/get_pin',
      'https://localhost/get_pin',
      'https://router.lan/get_pin',
      'https://nas.local/get_pin',
      'https://user:pass@pin.example.org/get_pin',
      'https://pin.example.org/get_pin?x=1',
      'https://pin.example.org/admin',
    ]) {
      const s = await setup({ pinServerUrls: [url] });
      const err = await s.provider.connect().catch((e: unknown) => e);
      expect(err, url).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/does not reach/) });
      expect(s.server.calls, url).toEqual([]);
      // Not even asked: no answer from the owner can make such an address one to reach.
      expect(s.screens.map((x) => x.title), url).not.toContain('A PIN server Trikey does not know');
    }
  });

  it('reaches no server the owner did not name: a no on the question stops, with nothing sent', async () => {
    const s = await setup({ pinServerUrls: ['https://pins.attacker.example/get_pin'] }, { acceptServer: false });
    await expect(s.provider.connect()).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.server.calls).toEqual([]);
    expect(await s.pinServers.list()).toEqual([]);
    // Without a way to ask (unlockJade on its own), only Blockstream's is reached: the Jade gets an empty pin.
    const methods: string[] = [];
    const rpc = {
      call: async (method: string) => {
        methods.push(method);
        if (method === 'pin') throw new Error('stop');
        return { http_request: { params: { urls: ['https://pins.attacker.example/get_pin'], method: 'POST', accept: 'json', data: { data: 'a' } }, 'on-reply': 'pin' } };
      },
    } as unknown as JadeRpc;
    const fetched: string[] = [];
    await expect(unlockJade(rpc, { network: 'testnet', fetch: async (u) => (fetched.push(u), { ok: true, status: 200, text: async () => '{}' }) })).rejects.toThrow('stop');
    expect(fetched).toEqual([]);
    expect(methods).toEqual(['auth_user', 'pin']);
  });

  it('does not follow a redirect from the PIN server: the answer is dropped and the Jade gets an empty pin', async () => {
    const s = await setup();
    const real = s.server.fetch;
    const inits: unknown[] = [];
    const provider = new JadeBleProvider({
      network: 'regtest',
      bridge: s.bridge,
      notices: s.notices,
      fetch: async (url, init) => {
        inits.push(init);
        const res = await real(url, init);
        // What React Native's fetch reports after following a redirect natively.
        return { ...res, redirected: true, url: 'http://192.168.1.1/' };
      },
    });
    const err = await provider.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/sent this phone somewhere else.*stayed locked/) });
    expect(inits).toEqual([expect.objectContaining({ redirect: 'error' })]);
    expect(s.jade.requests.map((r) => [r.method, r.params === undefined])).toEqual([
      ['get_version_info', true],
      ['auth_user', false],
      ['pin', true],
    ]);
  });

  it('refuses firmware too old for Trikey, and says what is missing on a phone without Bluetooth', async () => {
    const old = await setup({ version: '0.1.46' });
    await expect(old.provider.connect()).rejects.toMatchObject({ code: 'not-supported', message: expect.stringMatching(/0\.1\.46.*0\.1\.47 or later/) });
    expect(versionAtLeast('1.0.41', [0, 1, 47])).toBe(true);
    expect(versionAtLeast('0.1.47', [0, 1, 47])).toBe(true);
    expect(versionAtLeast('0.1.46-beta', [0, 1, 47])).toBe(false);
    expect(versionAtLeast('', [0, 1, 47])).toBe(false);

    const off = await setup();
    off.link.prepareProblem = 'Bluetooth is off on this phone. Turn it on, then try again.';
    await expect(off.provider.connect()).rejects.toMatchObject({ code: 'unavailable', message: /Bluetooth is off/ });
    off.link.supported = false;
    expect(await off.provider.isAvailable()).toBe(false);
    expect(await off.provider.unavailableReason()).toBe('This phone has no Bluetooth.');
    const web = new JadeBleProvider({ bridge: new JadeBleBridge(noBle) });
    expect(await web.isAvailable()).toBe(false);
    expect(await web.unavailableReason()).toMatch(/phone app/);
    await expect(web.connect()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(web.connect({ kind: 'ledger' })).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('cancel on the sheet stops the unlock', async () => {
    const s = await setup();
    // The PIN server never answers.
    const provider = new JadeBleProvider({ network: 'regtest', bridge: s.bridge, fetch: () => new Promise(() => {}), notices: s.notices });
    const p = provider.connect();
    for (let i = 0; i < 100 && s.bridge.getSnapshot()?.title !== 'Checking your PIN'; i++) await new Promise((r) => setTimeout(r, 1));
    s.bridge.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('names the model from BOARD_TYPE', async () => {
    for (const [board, model] of [
      ['JADE', 'Jade'],
      ['JADE_V1.1', 'Jade'],
      ['JADE_V2', 'Jade Plus'],
      ['JADE_V2C', 'Jade Core'],
    ] as const) {
      const s = await setup({ board, unlocked: true });
      expect((await s.provider.connect()).info.model).toBe(model);
    }
  });
});

describe('the PIN-server relay', () => {
  it('reads the http_request as pinclient.c sends it, and picks the first https URL that is not an onion', () => {
    const req = parseHttpRequest({
      http_request: { params: { urls: ['https://j8d.io/get_pin', 'http://x.onion/get_pin'], method: 'POST', accept: 'json', data: { data: 'abc' } }, 'on-reply': 'pin' },
    });
    expect(req).toEqual({ urls: ['https://j8d.io/get_pin', 'http://x.onion/get_pin'], method: 'POST', accept: 'json', data: { data: 'abc' }, onReply: 'pin' });
    expect(parseHttpRequest(true)).toBeUndefined();
    expect(() => parseHttpRequest({ http_request: { params: { method: 'PUT' }, 'on-reply': 'pin' } })).toThrow(/PUT/);
    expect(pickPinServerUrl(['http://x.onion/get_pin', 'https://y.onion/get_pin', 'https://j8d.io/get_pin'])).toEqual({ url: 'https://j8d.io/get_pin' });
    expect(pickPinServerUrl([])).toEqual({ problem: expect.stringMatching(/no PIN-server address/) });
    expect(hostOf('https://J8D.io:443/get_pin')).toBe('j8d.io');
    // Blockstream's only, by default; another server only when allowed, and named with its port when not 443.
    expect(BLOCKSTREAM_PIN_SERVERS).toEqual(['j8d.io', 'jadepin.blockstream.com']);
    expect(pickPinServerUrl(['https://J8D.io/get_pin'])).toEqual({ url: 'https://J8D.io/get_pin' });
    expect(pickPinServerUrl(['https://j8d.io:8443/get_pin'])).toMatchObject({ unknownServer: 'j8d.io:8443' });
    expect(pickPinServerUrl(['https://pin.example.org/set_pin'])).toMatchObject({ unknownServer: 'pin.example.org' });
    expect(pickPinServerUrl(['https://pin.example.org/set_pin'], ['pin.example.org'])).toEqual({ url: 'https://pin.example.org/set_pin' });
    expect(pickPinServerUrl(['https://j8d.io.attacker.example/get_pin'])).toMatchObject({ unknownServer: 'j8d.io.attacker.example' });
    expect(parsePinServerUrl('https://pin.example.org:9443/jade/get_pin')).toEqual({ server: 'pin.example.org:9443', host: 'pin.example.org' });
    for (const bad of ['https://1.2.3.4/get_pin', 'https://pin.example.org/../get_pin', 'https://pin.example.org/get_pin#x', 'http://j8d.io/get_pin', 'https://j8d.io/'])
      expect(parsePinServerUrl(bad), bad).toBeUndefined();
  });

  it('passes the server answer on as JSON, and reports a server that answers garbage', async () => {
    const req = { urls: ['https://j8d.io/get_pin'], method: 'POST' as const, accept: 'json', data: { data: 'abc' }, onReply: 'pin' };
    const seen: unknown[] = [];
    const ok = await relayHttpRequest(req, {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, text: async () => '{"data":"xyz"}' };
      },
    });
    expect(ok).toEqual({ body: { data: 'xyz' }, url: 'https://j8d.io/get_pin' });
    expect(seen).toEqual([
      { url: 'https://j8d.io/get_pin', init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{"data":"abc"}', signal: expect.anything(), redirect: 'error' } },
    ]);
    expect(await relayHttpRequest(req, { fetch: async () => ({ ok: true, status: 200, text: async () => '<html>' }) })).toEqual({ problem: expect.stringMatching(/not JSON/) });
    expect(await relayHttpRequest(req, { fetch: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(70_000) }) })).toEqual({ problem: expect.stringMatching(/too long/) });
    expect(await relayHttpRequest(req, { fetch: () => Promise.reject(new TypeError('Network request failed')) })).toEqual({ problem: expect.stringMatching(/could not reach the PIN server \(j8d\.io\)/) });
    const slow = await relayHttpRequest(req, { timeoutMs: 10, fetch: (_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))) });
    expect(slow).toEqual({ problem: expect.stringMatching(/could not reach/) });
  });

  it('only ever answers the Jade with "pin"', async () => {
    const asks = { call: async () => ({ http_request: { params: { urls: ['https://j8d.io/x'] }, 'on-reply': 'sign_psbt' } }) } as unknown as JadeRpc;
    await expect(unlockJade(asks, { network: 'testnet', fetch: fakePinServer().fetch })).rejects.toThrow(/"sign_psbt"/);
  });
});

describe('JadeSigner', () => {
  it('registers the 2-of-3 wallet as register_multisig wants it, under a name Jade takes', async () => {
    const { f, jade, signer } = await connected();
    expect(await signer.registerWallet(f.policy)).toEqual({});
    expect([...jade.wallets.keys()]).toEqual(['Trikey-test']);
    const reg = jade.requests.find((r) => r.method === 'register_multisig')!.params!;
    const parsed = parseWalletPolicy(f.policy);
    expect(reg).toEqual(registerMultisigParams(parsed, 'Trikey-test', 'regtest'));
    expect(reg).toMatchObject({ network: 'localtest', multisig_name: 'Trikey-test', descriptor: { variant: 'wsh(multi(k))', sorted: true, threshold: 2 } });
    const signers = (reg.descriptor as { signers: { fingerprint: Uint8Array; derivation: number[]; xpub: string; path: number[] }[] }).signers;
    expect(signers).toHaveLength(3);
    const mine = signers.find((x) => Array.from(x.fingerprint, (b) => b.toString(16).padStart(2, '0')).join('') === jade.fingerprint)!;
    expect(mine).toEqual({ fingerprint: expect.any(Uint8Array), derivation: [48 + H, 1 + H, 0 + H, 2 + H], xpub: f.hardwareXpub, path: [] });
    expect(jadeWalletName('Trikey savings')).toBe('Trikey-savings');
    expect(jadeWalletName('A very long wallet name')).toBe('A-very-long-wal');
    expect(jadeWalletName('   ')).toBe('---');
    expect(jadeNetwork('bitcoin')).toBe('mainnet');
    expect(jadeNetwork('signet')).toBe('testnet');
    expect(jadeNetwork('regtest')).toBe('localtest');
  });

  it('a declined registration is the owner’s refusal; a wallet without this Jade is refused before asking', async () => {
    const { f, jade, signer } = await connected();
    jade.approve = false;
    await expect(signer.registerWallet(f.policy)).rejects.toMatchObject({ code: 'user-rejected' });
    const other = new JadeSigner({ kind: 'jade-ble', fingerprint: '00000000' }, (signer as unknown as { rpc: never }).rpc, { network: 'regtest' });
    await expect(other.registerWallet(f.policy)).rejects.toThrow(/not part of the wallet/);
  });

  it('shows an address the Jade derives from the registered wallet, and checks it is the phone’s', async () => {
    const { f, jade, signer } = await connected();
    await signer.registerWallet(f.policy);
    expect(await signer.displayAddress(f.policy, 0, 0)).toBe(f.wallet.derive(0, 0).address);
    expect(jade.requests.at(-1)!.params).toEqual({ network: 'localtest', paths: [[0, 0], [0, 0], [0, 0]], multisig_name: 'Trikey-test' });
    expect(await signer.displayAddress(f.policy, 1, 7)).toBe(f.wallet.derive(1, 7).address);
  });

  it('co-signs a payment: every signature verified, every input of this Jade signed', async () => {
    const { f, jade, signer } = await connected();
    const out = await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy);
    const tx = parsePsbt(base64.decode(out));
    expect(tx.getInput(0).partialSig).toHaveLength(2);
    expect(jade.requests.at(-1)).toMatchObject({ method: 'sign_psbt', params: { network: 'localtest', psbt: f.psbtAppSigned } });
  });

  it('joins a signed payment sent in parts (get_extended_data)', async () => {
    const s = await setup({ psbtChunk: 100, mtu: 40 });
    const signer = await s.provider.connect();
    const out = await signer.signPsbt(s.f.psbtBase64, s.f.policy);
    expect(parsePsbt(base64.decode(out)).getInput(0).partialSig).toHaveLength(1);
    const ext = s.jade.requests.filter((r) => r.method === 'get_extended_data');
    expect(ext.length).toBeGreaterThan(2);
    expect(ext[0]!.params).toMatchObject({ orig: 'sign_psbt', seqnum: 2 });
  });

  it('refuses a payment signature that does not verify, another transaction, or a missing signature', async () => {
    for (const [tamper, why] of [
      ['bad-signature', /does not verify/],
      ['other-tx', /different transaction/],
      ['drop-signature', /did not sign/],
    ] as const) {
      const { f, jade, signer } = await connected();
      jade.tamper = tamper;
      await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toThrow(why);
    }
  });

  it('signs Trikey’s text with RFC 6979 (the same signature twice), never asking for anti-exfil, checked against the key', async () => {
    const { jade, signer } = await connected();
    const a = await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } });
    const b = await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    expect(a).toBe(b);
    expect(verifyBip137Message(TEXT, hwSigner().master(network).derive(AUTH).publicKey!, a)).toBe(true);
    expect(base64.decode(a)[0]).toBeGreaterThanOrEqual(31);
    const sm = jade.requests.filter((r) => r.method === 'sign_message');
    expect(sm).toHaveLength(2);
    for (const r of sm) expect(r.params).toEqual({ path: [48 + H, 1 + H, 0 + H, 2 + H, 0, 0], message: TEXT });
    expect(jade.signedTexts).toEqual([TEXT, TEXT]);
  });

  it('refuses a text signature by another key, of another text, or that is not a signature', async () => {
    for (const [tamper, why] of [
      ['wrong-key', /not from this wallet’s key m\/48'\/1'\/0'\/2'\/0\/0/],
      ['other-text', /not from this wallet’s key/],
      ['bad-message-signature', /not base64|wrong length/],
    ] as const) {
      const { jade, signer } = await connected();
      jade.tamper = tamper;
      await expect(signer.signMessage(AUTH, TEXT)).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(why) });
    }
    const { signer } = await connected();
    await expect(signer.signMessage(AUTH, 'héllo')).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.signMessage("m/48'/1'/0'/2'", TEXT)).rejects.toThrow(/below an account key/);
  });

  it('a dropped link fails the call as a disconnect, so the wallet connects again', async () => {
    const { jade, signer } = await connected();
    const p = signer.signMessage(AUTH, TEXT);
    jade.disconnect();
    await expect(p).rejects.toMatchObject({ name: 'HardwareError', code: 'disconnected' });
  });

  it('computes the fingerprint from the root key, and refuses a key that is not one', () => {
    const root = hwSigner().master(network);
    expect(fingerprintOfRoot(root.publicExtendedKey)).toBe(root.fingerprint.toString(16).padStart(8, '0'));
    expect(() => fingerprintOfRoot(root.derive("m/48'").publicExtendedKey)).toThrow(/root key/);
  });
});

