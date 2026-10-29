import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { analyzePsbt, parsePsbt } from '@trikey/core';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { HardwareError, HardwareNotSupportedError } from '../errors';
import { HARDENED } from '../common/path';
import { decodeXpub, encodeXpub } from '../common/xpub';
import { parseWalletPolicy } from '../common/wallet';
import { makeFixture, network, type Fixture } from '../test/fixtures';
import { QrBridge, type QrRequest, type QrScanRequest, type QrShowRequest } from './bridge';
import { encodeBbqr } from './bbqr';
import { signedFromPayload } from './payload';
import { QrFrameAssembler } from './frames';
import { QrProvider } from './provider';
import { coldcardMultisigConfig } from './registration';
import { QR_DEVICES_WITHOUT_MESSAGE_SIGNING, QrSigner, type QrSignerOptions } from './signer';
import type { QrFormat, QrPayload } from './types';
import { encodePsbtUr } from './ur';

const H = HARDENED;
const ACCOUNT = [48 + H, 1 + H, 0 + H, 2 + H];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Plays the user and the device: answers every request the bridge shows. */
function drive(bridge: QrBridge, handlers: { show?: (r: QrShowRequest) => void | Promise<void>; scan?: (r: QrScanRequest) => void | Promise<void> }) {
  const seen = new WeakSet<QrRequest>();
  const log: QrRequest[] = [];
  const check = () => {
    const snap = bridge.getSnapshot();
    if (!snap || seen.has(snap.request)) return;
    seen.add(snap.request);
    log.push(snap.request);
    queueMicrotask(() => {
      if (snap.request.type === 'show') void handlers.show?.(snap.request);
      else void handlers.scan?.(snap.request as QrScanRequest);
    });
  };
  const off = bridge.subscribe(check);
  check();
  return { log, stop: off };
}

/** Frames a device shows back: split by the format, out of order, with a repeat. */
function framesFor(bytes: Uint8Array, format: QrFormat): string[] {
  const frames = format === 'bbqr' ? encodeBbqr(bytes, 'P', { minVersion: 5, maxVersion: 9 }) : encodePsbtUr(bytes, { maxFragmentLength: 120 });
  return [...frames].reverse().concat(frames[0]!);
}

function feed(bridge: QrBridge, frames: string[]): Array<{ progress?: unknown; hint?: string }> {
  const out: Array<{ progress?: unknown; hint?: string }> = [];
  for (const fr of frames) {
    out.push(bridge.submitFrame(fr));
    if (!bridge.getSnapshot()) break;
  }
  return out;
}

/** What the device sees on the screen: the PSBT from the frames we showed. */
function readShownPsbt(frames: string[]): Uint8Array {
  const a = new QrFrameAssembler();
  for (const f of frames) {
    const step = a.receive(f);
    if (step.done) return (signedFromPayload(step.payload) as { bytes: Uint8Array }).bytes;
  }
  throw new Error('the frames never completed');
}

async function setup(over: Partial<QrSignerOptions> & { kind?: 'qr' | 'coldcard' | 'jade' } = {}) {
  const f = await makeFixture();
  const bridge = new QrBridge();
  const signer = new QrSigner(
    { kind: over.kind ?? 'qr', fingerprint: f.hardwareFingerprint },
    { network: 'regtest', bridge, format: 'ur', registration: 'descriptor', label: 'Passport', ...over },
  );
  return { f, bridge, signer };
}

// ------------------------------------------------------------------------------------------------ the bridge

describe('QrBridge', () => {
  it('shows one request at a time, in order, and resolves them when the user answers', async () => {
    const bridge = new QrBridge();
    const req = (title: string) => ({ purpose: 'psbt' as const, title, instructions: '', frames: ['A'], continueLabel: 'Go' });
    const first = bridge.show(req('first'));
    const second = bridge.show(req('second'));
    expect(bridge.getSnapshot()!.request).toMatchObject({ title: 'first' });
    bridge.finishShow();
    await first;
    expect(bridge.getSnapshot()!.request).toMatchObject({ title: 'second' });
    bridge.finishShow();
    await second;
    expect(bridge.getSnapshot()).toBeUndefined();
  });

  it('notifies subscribers and hands out a stable snapshot until something changes', async () => {
    const bridge = new QrBridge();
    let calls = 0;
    const off = bridge.subscribe(() => calls++);
    const p = bridge.show({ purpose: 'address', title: 't', instructions: '', frames: ['A'], continueLabel: 'ok' });
    const a = bridge.getSnapshot();
    expect(bridge.getSnapshot()).toBe(a);
    expect(calls).toBe(1);
    bridge.finishShow();
    await p;
    expect(calls).toBe(2);
    off();
    void bridge.show({ purpose: 'address', title: 't', instructions: '', frames: ['A'], continueLabel: 'ok' }).catch(() => {});
    expect(calls).toBe(2);
    bridge.cancel();
  });

  it('cancel rejects with `cancelled`; so does an aborted signal, queued or active', async () => {
    const bridge = new QrBridge();
    const show = () => ({ purpose: 'psbt' as const, title: 't', instructions: '', frames: ['A'], continueLabel: 'ok' });
    const a = bridge.show(show());
    bridge.cancel();
    await expect(a).rejects.toMatchObject({ code: 'cancelled' });

    const ac = new AbortController();
    const active = bridge.show(show(), ac.signal);
    const queued = bridge.show(show(), ac.signal);
    ac.abort();
    await expect(active).rejects.toMatchObject({ code: 'cancelled' });
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(bridge.getSnapshot()).toBeUndefined();
    await expect(bridge.show(show(), ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a scan resolves when accept says done, reports progress and hints, and rejects if accept throws', async () => {
    const bridge = new QrBridge();
    let n = 0;
    const scan = bridge.scan<string>({
      purpose: 'device-key',
      title: 't',
      instructions: '',
      accept: (frame) => {
        n++;
        if (frame === 'boom') throw new HardwareError('invalid-response', 'boom');
        if (frame === 'junk') return { done: false, hint: 'not that one' };
        if (frame === 'done') return { done: true, value: 'value' };
        return { done: false, progress: { fraction: n / 10, received: n } };
      },
    });
    expect(bridge.submitFrame('a')).toEqual({ progress: { fraction: 0.1, received: 1 }, hint: undefined });
    expect(bridge.getSnapshot()).toMatchObject({ progress: { received: 1 } });
    expect(bridge.submitFrame('junk').hint).toBe('not that one');
    expect(bridge.submitFrame('done')).toEqual({});
    await expect(scan).resolves.toBe('value');

    const failing = bridge.scan({ purpose: 'device-key', title: 't', instructions: '', accept: () => { throw new HardwareError('invalid-response', 'boom'); } });
    bridge.submitFrame('x');
    await expect(failing).rejects.toThrowError('boom');
    // Frames with no scan active are ignored.
    expect(bridge.submitFrame('x')).toEqual({});
    bridge.finishShow();
  });
});

// ------------------------------------------------------------------------------------------------ signing

describe('QrSigner.signPsbt', () => {
  for (const format of ['ur', 'bbqr'] as const) {
    it(`shows the PSBT as ${format}, scans the signed one back and merges the signature`, async () => {
      const { f, bridge, signer } = await setup({ format });
      let shown: QrShowRequest | undefined;
      const d = drive(bridge, {
        show: (r) => {
          shown = r;
          bridge.finishShow();
        },
        scan: async (r) => {
          expect(r.purpose).toBe('signed-psbt');
          // The device read our frames, checked the transaction and signed it.
          const seen = readShownPsbt(shown!.frames);
          expect(seen).toEqual(f.psbtAppSigned);
          const signed = await hwSigner().signPsbt(seen, network);
          const results = feed(bridge, framesFor(signed, format));
          expect(results.length).toBeGreaterThan(0);
        },
      });
      const out = await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy);
      d.stop();
      expect(shown!.purpose).toBe('psbt');
      expect(shown!.frames.length).toBeGreaterThan(1);
      expect(shown!.frames.every((fr) => (format === 'ur' ? fr.startsWith('ur:crypto-psbt/') : fr.startsWith('B$')))).toBe(true);
      expect(shown!.continueLabel).toMatch(/signed transaction/i);
      const analysis = analyzePsbt(base64.decode(out), f.wallet.accountPubkeys(), network);
      expect(analysis.inputs[0]!.signedBy.sort()).toEqual(['app', 'hardware']);
      expect(parsePsbt(base64.decode(out)).getInput(0).proprietary).toHaveLength(3);
    });
  }

  async function signWith(response: (f: Fixture, shownPsbt: Uint8Array) => Promise<string[]>, extra?: (f: Fixture, bridge: QrBridge) => Promise<void>) {
    const { f, bridge, signer } = await setup();
    let shown: QrShowRequest | undefined;
    const d = drive(bridge, {
      show: (r) => {
        shown = r;
        bridge.finishShow();
      },
      scan: async () => {
        if (extra) await extra(f, bridge);
        feed(bridge, await response(f, readShownPsbt(shown!.frames)));
      },
    });
    const result = await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy).finally(d.stop);
    return { f, result };
  }

  it('accepts a finalized PSBT', async () => {
    const { f, result } = await signWith(async (_f, seen) => {
      const tx = parsePsbt(await hwSigner().signPsbt(seen, network));
      tx.finalize();
      return encodePsbtUr(tx.toPSBT());
    });
    expect(analyzePsbt(base64.decode(result), f.wallet.accountPubkeys(), network).inputs[0]!.signedBy.sort()).toEqual(['app', 'hardware']);
  });

  it('accepts a finished transaction (BBQr T, or one bare hex QR, as the Coldcard Q shows them)', async () => {
    const finished = async (seen: Uint8Array) => {
      const tx = parsePsbt(await hwSigner().signPsbt(seen, network));
      tx.finalize();
      return tx.extract();
    };
    for (const encode of [
      (raw: Uint8Array) => encodeBbqr(raw, 'T'),
      (raw: Uint8Array) => [Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()],
    ]) {
      const { f, result } = await signWith(async (_f, seen) => encode(await finished(seen)));
      expect(analyzePsbt(base64.decode(result), f.wallet.accountPubkeys(), network).inputs[0]!.signedBy.sort()).toEqual(['app', 'hardware']);
    }
  });

  it('accepts a bare base64 or hex PSBT in one QR', async () => {
    for (const toText of [(b: Uint8Array) => base64.encode(b), (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')]) {
      const { f, result } = await signWith(async (_f, seen) => [toText(await hwSigner().signPsbt(seen, network))]);
      expect(analyzePsbt(base64.decode(result), f.wallet.accountPubkeys(), network).inputs[0]!.signedBy).toContain('hardware');
    }
  });

  it('tells the user when the QR is something else or for another transaction, and goes on scanning', async () => {
    const other = await makeFixture();
    const hints: string[] = [];
    const { f, result } = await signWith(
      async (_f, seen) => encodePsbtUr(await hwSigner().signPsbt(seen, network)),
      async (_f, bridge) => {
        for (const wrong of ['bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', ...encodePsbtUr(await hwSigner().signPsbt(other.psbt, network))]) {
          const r = bridge.submitFrame(wrong);
          if (r.hint) hints.push(r.hint);
        }
      },
    );
    expect(hints.some((h) => /not a signed transaction/.test(h))).toBe(true);
    expect(hints.some((h) => /different transaction|not the one/.test(h))).toBe(true);
    expect(analyzePsbt(base64.decode(result), f.wallet.accountPubkeys(), network).inputs[0]!.signedBy).toContain('hardware');
  });

  it('fails when the device did not add its signature', async () => {
    const { f, bridge, signer } = await setup();
    let shown: QrShowRequest | undefined;
    drive(bridge, {
      show: (r) => {
        shown = r;
        bridge.finishShow();
      },
      // The device hands back the same PSBT, unsigned.
      scan: () => void feed(bridge, encodePsbtUr(readShownPsbt(shown!.frames))),
    });
    await expect(signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects with `cancelled` when the user closes the sheet, at either step', async () => {
    const { f, bridge, signer } = await setup();
    const d1 = drive(bridge, { show: () => bridge.cancel() });
    await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'cancelled' });
    d1.stop();
    const d2 = drive(bridge, { show: () => bridge.finishShow(), scan: () => bridge.cancel() });
    await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'cancelled' });
    d2.stop();
  });

  it('checks the request before showing anything', async () => {
    const { f, bridge, signer } = await setup();
    await expect(signer.signPsbt('!!!', f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    const stranger = new QrSigner({ kind: 'qr', fingerprint: '00000000' }, { network: 'regtest', bridge, format: 'ur', registration: 'descriptor', label: 'x' });
    await expect(stranger.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    const main = new QrSigner({ kind: 'qr', fingerprint: f.hardwareFingerprint }, { network: 'bitcoin', bridge, format: 'ur', registration: 'descriptor', label: 'x' });
    await expect(main.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(bridge.getSnapshot()).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ the other calls

describe('QrSigner.registerWallet', () => {
  it('shows the Coldcard multisig setup file as BBQr', async () => {
    const { f, bridge, signer } = await setup({ kind: 'coldcard', format: 'bbqr', registration: 'coldcard', label: 'Coldcard' });
    let shown: QrShowRequest | undefined;
    drive(bridge, { show: (r) => { shown = r; bridge.finishShow(); } });
    expect(await signer.registerWallet(f.policy)).toEqual({});
    expect(shown!.purpose).toBe('wallet');
    const payload = scan(shown!.frames);
    if (payload.type !== 'bbqr') throw new Error('expected BBQr');
    expect(payload.fileType).toBe('U');
    const text = new TextDecoder().decode(payload.data);
    expect(text).toBe(coldcardMultisigConfig(parseWalletPolicy(f.policy)));
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Name: Trikey test', 'Policy: 2 of 3', 'Format: P2WSH']);
    // One key per cosigner, each with its own derivation; the guardian's key has none.
    expect(lines).toContain(`B8688DF1: ${f.wallet.keys.hardware.xpub}`);
    expect(lines).toContain(`73C5DA0A: ${f.wallet.keys.app.xpub}`);
    expect(lines.filter((l) => l === "Derivation: m/48'/1'/0'/2'")).toHaveLength(2);
    expect(lines.filter((l) => l === 'Derivation: m')).toHaveLength(1);
  });

  it('shows the descriptor for other devices', async () => {
    const { f, bridge, signer } = await setup();
    let shown: QrShowRequest | undefined;
    drive(bridge, { show: (r) => { shown = r; bridge.finishShow(); } });
    await signer.registerWallet(f.policy);
    expect(shown!.frames).toEqual([f.policy.descriptor]);
    expect(shown!.continueLabel).toBe('I have added it');
  });
});

function scan(frames: string[]): QrPayload {
  const a = new QrFrameAssembler();
  for (const fr of frames) {
    const s = a.receive(fr);
    if (s.done) return s.payload;
  }
  throw new Error('incomplete');
}

describe('QrSigner.displayAddress', () => {
  it('derives the address itself and asks the user to compare it on the device', async () => {
    const { f, bridge, signer } = await setup();
    let shown: QrShowRequest | undefined;
    drive(bridge, { show: (r) => { shown = r; bridge.finishShow(); } });
    expect(await signer.displayAddress(f.policy, 0, 5)).toBe(f.wallet.derive(0, 5).address);
    expect(await signer.displayAddress(f.policy, 1, 2)).toBe(f.wallet.derive(1, 2).address);
    expect(shown).toMatchObject({ purpose: 'address', detail: f.wallet.derive(1, 2).address, frames: [f.wallet.derive(1, 2).address] });
    expect(shown!.instructions).toMatch(/change address 2/);
    await expect(signer.displayAddress(f.policy, 5 as 0, 1)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('rejects when the user says the addresses do not match (closes the sheet)', async () => {
    const { f, bridge, signer } = await setup();
    drive(bridge, { show: () => bridge.cancel() });
    await expect(signer.displayAddress(f.policy, 0, 1)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('QrSigner.getXpub', () => {
  it('answers from the connect-time export, and scans for any other path', async () => {
    const f = await makeFixture();
    const bridge = new QrBridge();
    const signer = new QrSigner(
      { kind: 'coldcard', fingerprint: f.hardwareFingerprint },
      { network: 'regtest', bridge, format: 'bbqr', registration: 'coldcard', label: 'Coldcard', knownKeys: [{ path: ACCOUNT, xpub: f.hardwareXpub }] },
    );
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    expect(bridge.getSnapshot()).toBeUndefined();

    const vpub = encodeXpub({ ...decodeXpub(f.hardwareXpub), version: 0x02575483 });
    const other = { xfp: f.hardwareFingerprint.toUpperCase(), bip84_deriv: "m/84'/1'/0'", bip84: vpub, p2wsh_deriv: "m/48'/1'/1'/2'", p2wsh: vpub };
    drive(bridge, { scan: () => void feed(bridge, encodeBbqr(new TextEncoder().encode(JSON.stringify(other)), 'J')) });
    expect(await signer.getXpub("m/48'/1'/1'/2'")).toBe(f.hardwareXpub);
    // Both keys of the export are remembered now.
    expect(await signer.getXpub("m/84'/1'/0'")).toBe(f.hardwareXpub);
  });

  it('refuses an export from another device or for another network', async () => {
    const { f, bridge, signer } = await setup();
    const json = (over: object) => JSON.stringify({ xfp: f.hardwareFingerprint.toUpperCase(), p2wsh_deriv: "m/48'/1'/0'/2'", p2wsh: f.hardwareXpub, ...over });
    const run = async (text: string, path: string) => {
      const d = drive(bridge, { scan: () => void feed(bridge, [text]) });
      try {
        return await signer.getXpub(path);
      } finally {
        d.stop();
      }
    };
    await expect(run(json({ xfp: '11111111' }), "m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/different device/) });
    await expect(run(json({}), "m/48'/1'/9'/2'")).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/does not include/) });
    await expect(run(json({ p2wsh_deriv: "m/48'/0'/0'/2'" }), "m/48'/0'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/wrong network/) });
    await expect(signer.getXpub('m')).rejects.toMatchObject({ code: 'invalid-request' });
  });
});

describe('QrSigner.signMessage', () => {
  it('is not supported over QR, and says for which devices', async () => {
    const { signer } = await setup();
    const err = await signer.signMessage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardwareNotSupportedError);
    expect(err).toMatchObject({ code: 'not-supported', operation: 'signMessage', devices: QR_DEVICES_WITHOUT_MESSAGE_SIGNING });
    expect((err as HardwareNotSupportedError).devices).toEqual(expect.arrayContaining(['Coldcard Q', 'Jade', 'Keystone', 'Passport']));
  });
});

// ------------------------------------------------------------------------------------------------ provider

describe('QrProvider', () => {
  it('connects by scanning the device export, and picks the format for the device', async () => {
    const f = await makeFixture();
    const bridge = new QrBridge();
    const provider = new QrProvider({ network: 'regtest', qr: { bridge } });
    expect(provider.kinds).toEqual(['qr', 'coldcard', 'jade']);
    const json = JSON.stringify({ xfp: f.hardwareFingerprint.toUpperCase(), p2wsh_deriv: "m/48'/1'/0'/2'", p2wsh: f.hardwareXpub });
    let request: QrScanRequest | undefined;
    drive(bridge, { scan: (r) => { request = r; feed(bridge, [json]); } });
    const signer = await provider.connect({ kind: 'coldcard' });
    expect(request!.title).toMatch(/Coldcard/);
    expect(signer.info).toEqual({ kind: 'coldcard', model: 'Coldcard', fingerprint: f.hardwareFingerprint });
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    // The Coldcard signer speaks BBQr.
    let shown: QrShowRequest | undefined;
    drive(bridge, { show: (r) => { shown = r; bridge.cancel(); } });
    await signer.signPsbt(f.psbtBase64, f.policy).catch(() => {});
    expect(shown!.frames[0]).toMatch(/^B\$/);
  });

  it('refuses kinds it does not handle, honours abort, and reports camera availability', async () => {
    const bridge = new QrBridge();
    const provider = new QrProvider({ qr: { bridge }, cameraAvailable: async () => false });
    await expect(provider.connect({ kind: 'ledger' })).rejects.toMatchObject({ code: 'invalid-request' });
    const ac = new AbortController();
    ac.abort();
    await expect(provider.connect({ signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await provider.isAvailable()).toBe(false);
    expect(await new QrProvider({ cameraAvailable: async () => true }).isAvailable()).toBe(true);
    expect(await new QrProvider({ cameraAvailable: async () => { throw new Error('no'); } }).isAvailable()).toBe(false);
    await tick();
  });
});
