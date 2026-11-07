import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { analyzePsbt, parsePsbt } from '@trikey/core';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { HardwareError, HardwareNotSupportedError } from '../errors';
import { HARDENED } from '../common/path';
import { decodeXpub, encodeXpub } from '../common/xpub';
import { parseWalletPolicy } from '../common/wallet';
import { makeFixture, network, type Fixture } from '../test/fixtures';
import { QrBridge, type DeviceFileIo, type QrFileRequest, type QrNoticeRequest, type QrRequest, type QrScanRequest, type QrShowRequest } from './bridge';
import { encodeBbqr } from './bbqr';
import { signedFromPayload } from './payload';
import { QrFrameAssembler } from './frames';
import { QrProvider } from './provider';
import { coldcardMultisigConfig } from './registration';
import { QR_DEVICES_WITHOUT_MESSAGE_SIGNING, QrSigner, type QrSignerOptions } from './signer';
import type { QrFormat, QrPayload } from './types';
import { encodePsbtUr } from './ur';
import { messageAddresses } from './message';
import { verifyBip137Message } from '@trikey/wallet';
import { signMessage as signBip137 } from '../../../../../packages/wallet/src/bip137';

const H = HARDENED;
const ACCOUNT = [48 + H, 1 + H, 0 + H, 2 + H];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Plays the user and the device: answers every request the bridge shows. A notice is confirmed unless `notice` says otherwise. */
function drive(
  bridge: QrBridge,
  handlers: {
    show?: (r: QrShowRequest) => void | Promise<void>;
    scan?: (r: QrScanRequest) => void | Promise<void>;
    file?: (r: QrFileRequest) => void | Promise<void>;
    notice?: (r: QrNoticeRequest) => void | Promise<void>;
  },
) {
  const seen = new WeakSet<QrRequest>();
  const log: QrRequest[] = [];
  const check = () => {
    const snap = bridge.getSnapshot();
    if (!snap || seen.has(snap.request)) return;
    seen.add(snap.request);
    log.push(snap.request);
    queueMicrotask(() => {
      if (snap.request.type === 'show') void handlers.show?.(snap.request);
      else if (snap.request.type === 'file') void handlers.file?.(snap.request);
      else if (snap.request.type === 'notice') void (handlers.notice ? handlers.notice(snap.request) : bridge.acknowledge());
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

  it('a notice resolves only when the owner confirms it: cancel (the back gesture) leaves it on screen, an aborted signal ends it', async () => {
    const bridge = new QrBridge();
    const notice = { purpose: 'delete-files' as const, title: 't', instructions: '', items: ['a.txt'], continueLabel: 'I deleted them' };
    let settled = false;
    const p = bridge.notice(notice).then(() => (settled = true));
    expect(bridge.getSnapshot()!.request).toMatchObject({ type: 'notice', items: ['a.txt'] });
    bridge.cancel();
    bridge.finishShow();
    await tick();
    expect(settled).toBe(false);
    expect(bridge.getSnapshot()!.request.type).toBe('notice');
    bridge.acknowledge();
    await p;
    expect(bridge.getSnapshot()).toBeUndefined();
    const ac = new AbortController();
    const q = bridge.notice(notice, ac.signal);
    ac.abort();
    await expect(q).rejects.toMatchObject({ code: 'cancelled' });
    // acknowledge does nothing to another request.
    const show = bridge.show({ purpose: 'psbt', title: 't', instructions: '', frames: ['A'], continueLabel: 'ok' });
    bridge.acknowledge();
    expect(bridge.getSnapshot()!.request.type).toBe('show');
    bridge.cancel();
    await expect(show).rejects.toMatchObject({ code: 'cancelled' });
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

    const vpub = (xpub: string) => encodeXpub({ ...decodeXpub(xpub), version: 0x02575483 });
    const account1 = f.hardwareXpubAt("m/48'/1'/1'/2'");
    const bip84 = f.hardwareXpubAt("m/84'/1'/0'");
    const other = { xfp: f.hardwareFingerprint.toUpperCase(), bip84_deriv: "m/84'/1'/0'", bip84: vpub(bip84), p2wsh_deriv: "m/48'/1'/1'/2'", p2wsh: vpub(account1) };
    drive(bridge, { scan: () => void feed(bridge, encodeBbqr(new TextEncoder().encode(JSON.stringify(other)), 'J')) });
    expect(await signer.getXpub("m/48'/1'/1'/2'")).toBe(account1);
    // Both keys of the export are remembered now.
    expect(await signer.getXpub("m/84'/1'/0'")).toBe(bip84);
  });

  it('refuses a key it was given at connect that is not the one its path claims', async () => {
    const f = await makeFixture();
    const signer = new QrSigner(
      { kind: 'coldcard', fingerprint: f.hardwareFingerprint },
      { network: 'regtest', bridge: new QrBridge(), format: 'bbqr', registration: 'coldcard', label: 'Coldcard', knownKeys: [{ path: ACCOUNT, xpub: f.hardwareXpubAt("m/84'/1'/0'") }] },
    );
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response', message: expect.stringMatching(/does not match its derivation path/) });
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
  const AUTH = "m/48'/1'/0'/2'/0/0";
  const TEXT = `Trikey pair v1 wallet=0123456789abcdef guardian=03${'ab'.repeat(32)}`;
  const authKey = () => hwSigner().master(network).derive(AUTH).privateKey!;
  const sign = (text: string, key = authKey()) => signBip137(text, key);

  async function messageSetup(model: QrSignerOptions['model']) {
    const f = await makeFixture();
    const bridge = new QrBridge();
    const signer = new QrSigner(
      { kind: 'qr', fingerprint: f.hardwareFingerprint, ...(model ? { qrModel: model } : {}) },
      { network: 'regtest', bridge, format: 'ur', registration: 'descriptor', label: 'signing device', knownKeys: [{ path: ACCOUNT, xpub: f.hardwareXpub }], ...(model ? { model } : {}) },
    );
    return { f, bridge, signer };
  }

  it.each(['seedsigner', 'other', 'coldcard-mk4', undefined] as const)('%s: refused with the reason, before anything is shown', async (model) => {
    const { signer, bridge } = await messageSetup(model);
    const shown = drive(bridge, {});
    const err = await signer.signMessage(AUTH, TEXT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardwareNotSupportedError);
    expect(err).toMatchObject({ code: 'not-supported', operation: 'signMessage', devices: QR_DEVICES_WITHOUT_MESSAGE_SIGNING });
    expect((err as Error).message).toMatch(model === 'seedsigner' ? /m\/48'.*co-signs payments only/ : model === 'coldcard-mk4' ? /no camera/ : /doesn.t know/);
    expect(shown.log).toEqual([]);
    expect(QR_DEVICES_WITHOUT_MESSAGE_SIGNING).toEqual(expect.arrayContaining(['SeedSigner', 'Coldcard Mk4', 'Other QR device']));
    expect(QR_DEVICES_WITHOUT_MESSAGE_SIGNING).not.toContain('Krux');
    expect(QR_DEVICES_WITHOUT_MESSAGE_SIGNING).not.toContain('Passport (2nd generation)');
    shown.stop();
  });

  it('Coldcard Q: shows the signmessage QR with the text, the steps and the address, then takes the bare signature', async () => {
    const { signer, bridge } = await messageSetup('coldcard-q');
    let show: QrShowRequest | undefined;
    let scan: QrScanRequest | undefined;
    drive(bridge, {
      show: (r) => {
        show = r;
        bridge.finishShow();
      },
      scan: (r) => {
        scan = r;
        feed(bridge, [sign(TEXT)]);
      },
    });
    const sig = await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' });
    expect(verifyBip137Message(TEXT, hwSigner().master(network).derive(AUTH).publicKey!, sig)).toBe(true);
    expect(show).toMatchObject({ purpose: 'message', frames: [`signmessage m/48h/1h/0h/2h/0/0 ascii:${TEXT}`], detail: TEXT, continueLabel: 'Scan the signature' });
    expect(show!.title).toBe('Sign on your Coldcard Q');
    expect(show!.steps!.join(' ')).toMatch(/press the QR key.*m\/48'\/1'\/0'\/2'\/0\/0/);
    const notes = show!.notes!.join(' ');
    expect(notes).toMatch(/proves to your guardian/);
    expect(notes).toMatch(/shows the text before it signs/);
    // The P2PKH address the Coldcard shows for that key, for the owner to compare.
    expect(notes).toMatch(/It shows this address for the key: [mn][1-9A-HJ-NP-Za-km-z]{25,34}$/);
    expect(scan).toMatchObject({ purpose: 'signed-message', title: 'Scan the signature' });
  });

  it("takes Coldcard's armored answer, and checks the text and the address in it", async () => {
    const { signer, bridge } = await messageSetup('coldcard-q');
    const pub = hwSigner().master(network).derive(AUTH).publicKey!;
    const { p2pkh } = messageAddresses(pub, 'regtest');
    const armor = (text: string, address: string, sig: string) =>
      `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----\n`;
    const hints: Array<string | undefined> = [];
    drive(bridge, {
      show: () => bridge.finishShow(),
      scan: () => {
        // Another text, then another key's address, then the right one.
        hints.push(feed(bridge, [armor(`${TEXT} x`, p2pkh, sign(`${TEXT} x`))])[0]!.hint);
        const other = messageAddresses(hwSigner().master(network).derive("m/48'/1'/0'/2'/0/1").publicKey!, 'regtest').p2pkh;
        hints.push(feed(bridge, [armor(TEXT, other, sign(TEXT))])[0]!.hint);
        feed(bridge, [armor(TEXT, p2pkh, sign(TEXT))]);
      },
    });
    const sig = await signer.signMessage(AUTH, TEXT);
    expect(sig).toBe(sign(TEXT));
    expect(hints[0]).toMatch(/signed a different text/);
    expect(hints[1]).toMatch(/signed with another key \(address [mn]\w+, not [mn]\w+\)/);
  });

  it('a signature by another key, garbage, or Trikey’s own request stay hints; scanning goes on until the right one', async () => {
    const { signer, bridge } = await messageSetup('specter-diy');
    const hints: Array<string | undefined> = [];
    drive(bridge, {
      show: () => bridge.finishShow(),
      scan: () => {
        for (const frame of [sign(TEXT, new Uint8Array(32).fill(3)), 'hello', `signmessage m/48h/1h/0h/2h/0/0 ascii:${TEXT}`]) hints.push(feed(bridge, [frame])[0]!.hint);
        feed(bridge, [sign(TEXT)]);
      },
    });
    await signer.signMessage(AUTH, TEXT);
    expect(hints[0]).toMatch(/not from this wallet.s key m\/48'\/1'\/0'\/2'\/0\/0.*same seed and passphrase.*text was not changed/);
    expect(hints[1]).toMatch(/not a message signature/);
    expect(hints[2]).toMatch(/That is Trikey.s request/);
  });

  it('notes and unlock: says the device shows the same text twice, and which round this is', async () => {
    const { signer, bridge } = await messageSetup('jade');
    const shows: QrShowRequest[] = [];
    drive(bridge, {
      show: (r) => {
        shows.push(r);
        bridge.finishShow();
      },
      scan: () => void feed(bridge, [sign(TEXT)]),
    });
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } });
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    expect(shows.map((r) => r.title)).toEqual(['Sign on your Jade / Jade Plus (1 of 2)', 'Sign on your Jade / Jade Plus (2 of 2)']);
    expect(shows[0]!.notes!.join(' ')).toMatch(/will show the same text twice/);
    expect(shows[1]!.notes!.join(' ')).toMatch(/Round 2 of 2: the same text again/);
    expect(shows[0]!.notes!.join(' ')).toMatch(/encrypts your notes/);
  });

  it('Jade: warns that a long text is cut on its screen; Keystone: no address; Passport Prime: the account to sign from', async () => {
    const long = `Trikey recovery-access v2 wallet=0123456789abcdef guardian=${'a'.repeat(64)} phone=${'b'.repeat(64)} expires=2026-11-07T00:00:00Z`;
    const shown = async (model: QrSignerOptions['model'], text: string) => {
      const { signer, bridge } = await messageSetup(model);
      let req: QrShowRequest | undefined;
      drive(bridge, { show: (r) => ((req = r), bridge.cancel()) });
      await signer.signMessage(AUTH, text).catch(() => {});
      return req!;
    };
    expect((await shown('jade', long)).notes!.join(' ')).toMatch(/This text is 223 characters. The Jade \/ Jade Plus shows about the first 188/);
    expect((await shown('jade', TEXT)).notes!.join(' ')).not.toMatch(/about the first/);
    const keystone = await shown('keystone-3', TEXT);
    expect(keystone.steps!.join(' ')).toMatch(/shows no address for this key/);
    expect(keystone.notes!.join(' ')).not.toMatch(/It shows this address/);
    expect((await shown('passport-prime', TEXT)).steps![0]).toMatch(/open account 0/);
  });

  it("refuses a text the Coldcard would refuse, and a cancel rejects with 'cancelled'", async () => {
    const { signer, bridge } = await messageSetup('coldcard-q');
    await expect(signer.signMessage(AUTH, 'a'.repeat(241))).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/at most 240/) });
    await expect(signer.signMessage(AUTH, 'caf\u00e9')).rejects.toMatchObject({ code: 'invalid-request' });
    drive(bridge, { show: () => bridge.cancel() });
    await expect(signer.signMessage(AUTH, TEXT)).rejects.toMatchObject({ code: 'cancelled' });
  });

  // ---------------------------------------------------------------------------------------------- microSD (sd-message.ts)

  /** The signed file Passport gen 2 writes: its RFC template (public_constants.py), with a trailing newline. */
  const passportSigned = (text: string, address: string, sig: string) =>
    `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----\n`;
  const fileOf = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
  const legacy = () => messageAddresses(hwSigner().master(network).derive(AUTH).publicKey!, 'regtest').p2pkh;

  it('dispatch: Passport gen 2 and Krux sign from a microSD file (one file request, no QR shown); QR models never get a file request', async () => {
    for (const model of ['passport', 'krux'] as const) {
      const { signer, bridge } = await messageSetup(model);
      const d = drive(bridge, { file: (r) => void bridge.submitFile(fileOf(`${r.file.name.replace('.txt', '')}-signed.txt`, passportSigned(TEXT, legacy(), sign(TEXT)))) });
      expect(await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' })).toBe(sign(TEXT));
      expect(d.log.map((r) => r.type)).toEqual(['file', 'notice']);
      d.stop();
    }
    const { signer, bridge } = await messageSetup('keystone-3');
    const d = drive(bridge, { show: () => bridge.finishShow(), scan: () => void feed(bridge, [sign(TEXT)]) });
    await signer.signMessage(AUTH, TEXT);
    expect(d.log.map((r) => r.type)).toEqual(['show', 'scan']);
  });

  it('Passport gen 2: the 2-line request file, the device steps and the address; the signed file comes back through the file I/O', async () => {
    const { signer, bridge } = await messageSetup('passport');
    let req: QrFileRequest | undefined;
    const card = new Map<string, string>();
    const io: DeviceFileIo = {
      saveToFolder: async (name, text) => (card.set(name, text), true),
      share: async () => {},
      pick: async () => fileOf('trikey-pair-signed-001.txt', passportSigned(TEXT, legacy(), sign(TEXT))),
    };
    drive(bridge, {
      file: async (r) => {
        req = r;
        expect(await bridge.saveFile(io)).toBe(true);
        expect(bridge.getSnapshot()!.saved).toBe(true);
        await bridge.pickFile(io);
      },
    });
    expect(await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' })).toBe(sign(TEXT));
    expect(card.get('trikey-pair.txt')).toBe(`${TEXT}\nm/48h/1h/0h/2h/0/0\n`);
    expect(req).toMatchObject({ purpose: 'message-file', title: 'Sign on your Passport (2nd generation)', file: { name: 'trikey-pair.txt' }, detail: TEXT });
    expect(req!.acceptFrame).toBeUndefined();
    const steps = req!.steps!.join(' ');
    expect(steps).toMatch(/Save trikey-pair.txt to the microSD card/);
    expect(steps).toMatch(/Sign a Message > Sign with microSD, and pick trikey-pair.txt/);
    expect(steps).toMatch(/trikey-pair-signed- and a number/);
    expect(req!.notes!.join(' ')).toMatch(new RegExp(`It shows this address for the key: ${legacy()}$`));
  });

  it('Krux: the 3-line request file (p2pkh), and its signature QR is taken instead of the file', async () => {
    const { signer, bridge } = await messageSetup('krux');
    let req: QrFileRequest | undefined;
    drive(bridge, {
      file: (r) => {
        req = r;
        bridge.submitFrame(sign(TEXT));
      },
    });
    expect(await signer.signMessage(AUTH, TEXT)).toBe(sign(TEXT));
    expect(req!.file).toEqual({ name: 'trikey-sign.txt', text: `${TEXT}\nm/48h/1h/0h/2h/0/0\np2pkh\n` });
    expect(req!.acceptFrame).toBeTypeOf('function');
    expect(req!.steps!.join(' ')).toMatch(/Sign > Message > Load from SD card.*SHA256.*Sign to SD card.*trikey-sign-signed.txt.*Scan the signature instead/);
    expect(req!.notes!.join(' ')).toMatch(/It shows this address for the key/);
    // A text past what a small Krux screen shows: the note says so.
    const long = `${TEXT} ${'x'.repeat(40)}`;
    const k = await messageSetup('krux');
    let longReq: QrFileRequest | undefined;
    drive(k.bridge, { file: (r) => ((longReq = r), k.bridge.cancel()) });
    await k.signer.signMessage(AUTH, long).catch(() => {});
    expect(longReq!.notes!.join(' ')).toMatch(/This text is 155 characters. On a small screen the Krux shows about the first 120 and then "…"/);
  });

  it('a wrong file, another key, an altered text or garbage stay hints; only a signature that verifies is returned', async () => {
    const { signer, bridge } = await messageSetup('passport');
    const hints: Array<string | undefined> = [];
    const otherKey = new Uint8Array(32).fill(3);
    drive(bridge, {
      file: (r) => {
        const tries = [
          fileOf('trikey-pair.txt', r.file.text), // Trikey's own request
          fileOf('trikey-pair-signed-001.txt', passportSigned(`${TEXT}x`, legacy(), sign(`${TEXT}x`))), // altered text
          fileOf('trikey-pair-signed-001.txt', passportSigned(TEXT, legacy(), sign(TEXT, otherKey))), // another key, our address
          fileOf('notes.txt', 'shopping list'), // garbage
          { name: 'trikey-pair-signed.sig', bytes: new Uint8Array([0x30, 0x44, 0x02, 0x20, 0xff, 0xfe]) }, // Krux signed a hash
          { name: 'photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81]) }, // binary
          fileOf('empty.txt', ''),
        ];
        for (const t of tries) hints.push(bridge.submitFile(t).hint);
        bridge.submitFile(fileOf('trikey-pair-signed-002.txt', passportSigned(TEXT, legacy(), sign(TEXT))));
      },
    });
    expect(await signer.signMessage(AUTH, TEXT, { purpose: 'pairing' })).toBe(sign(TEXT));
    expect(hints[0]).toMatch(/file Trikey made \(the request\).*-signed/);
    expect(hints[1]).toMatch(/holds a different text/);
    expect(hints[2]).toMatch(/not from this wallet.s key m\/48'\/1'\/0'\/2'\/0\/0.*pick the new signed file/);
    expect(hints[3]).toMatch(/not a signed message/);
    expect(hints[4]).toMatch(/\.sig file.*did not read the file/);
    expect(hints[5]).toMatch(/not text/);
    expect(hints[6]).toMatch(/empty/);
  });

  it('notes: two rounds, two files named by round; the other round’s signed file is refused', async () => {
    const { signer, bridge } = await messageSetup('passport');
    const reqs: QrFileRequest[] = [];
    const hints: Array<string | undefined> = [];
    drive(bridge, {
      file: (r) => {
        reqs.push(r);
        if (reqs.length === 2) hints.push(bridge.submitFile(fileOf('trikey-notes-1of2-signed-001.txt', passportSigned(TEXT, legacy(), sign(TEXT)))).hint);
        bridge.submitFile(fileOf(`${r.file.name.replace('.txt', '')}-signed-001.txt`, passportSigned(TEXT, legacy(), sign(TEXT))));
      },
    });
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } });
    await signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    expect(reqs.map((r) => [r.title, r.file.name])).toEqual([
      ['Sign on your Passport (2nd generation) (1 of 2)', 'trikey-notes-1of2.txt'],
      ['Sign on your Passport (2nd generation) (2 of 2)', 'trikey-notes-2of2.txt'],
    ]);
    expect(reqs[0]!.notes!.join(' ')).toMatch(/signs the same text twice, from two files: this is the first/);
    expect(reqs[1]!.notes!.join(' ')).toMatch(/Round 2 of 2: the same text again, in a new file/);
    expect(hints[0]).toMatch(/signed file of the other round.*round 2 of 2/);
  });

  it('microSD: after the signed file, the files to delete by name; the signature is returned only once the owner confirms', async () => {
    // Passport, notes: the request and the signed file it wrote; they can open the notes.
    const { signer, bridge } = await messageSetup('passport');
    const notices: QrNoticeRequest[] = [];
    let confirm = () => {};
    drive(bridge, {
      file: (r) => void bridge.submitFile(fileOf(`${r.file.name.replace('.txt', '')}-signed-001.txt`, passportSigned(TEXT, legacy(), sign(TEXT)))),
      notice: (r) => {
        notices.push(r);
        confirm = () => bridge.acknowledge();
      },
    });
    let returned: string | undefined;
    const p = signer.signMessage(AUTH, TEXT, { purpose: 'notes', round: { n: 1, of: 2 } }).then((v) => (returned = v));
    for (let i = 0; i < 100 && notices.length === 0; i++) await tick();
    expect(notices[0]).toMatchObject({
      type: 'notice',
      purpose: 'delete-files',
      title: 'Delete these files from the card',
      instructions: 'Delete these files from the card now, and from any computer or email you copied them through. They can open your notes.',
      items: ['trikey-notes-1of2.txt', 'trikey-notes-1of2-signed-001.txt'],
      continueLabel: 'I deleted them',
    });
    expect(notices[0]!.notes![0]).toMatch(/^trikey-notes-1of2-signed-001\.txt holds the signature your Passport \(2nd generation\) just made, and that signature is the key to your notes/);
    await tick();
    expect(returned).toBeUndefined();
    confirm();
    expect(await p).toBe(sign(TEXT));

    // Krux, a signed file: its own name (as the file chooser gives it); approvals say they are not needed again.
    const k = await messageSetup('krux');
    const kn: QrNoticeRequest[] = [];
    drive(k.bridge, {
      file: (r) => void k.bridge.submitFile(fileOf(`${r.file.name.replace('.txt', '')}-signed.txt`, passportSigned(TEXT, legacy(), sign(TEXT)))),
      notice: (r) => (kn.push(r), k.bridge.acknowledge()),
    });
    await k.signer.signMessage(AUTH, TEXT, { purpose: 'approval' });
    expect(kn[0]).toMatchObject({
      items: ['trikey-approve.txt', 'trikey-approve-signed.txt'],
      instructions: 'Delete these files from the card now, and from any computer or email you copied them through. Trikey does not need them again.',
    });
    expect(kn[0]!.notes!.join(' ')).toMatch(/They hold the text your Krux signed and its signature, which name this wallet and your guardian/);

    // Krux, the signature by QR: only the request file is on the card; for notes, a signed file written anyway must go too.
    const q = await messageSetup('krux');
    const qn: QrNoticeRequest[] = [];
    drive(q.bridge, { file: () => void q.bridge.submitFrame(sign(TEXT)), notice: (r) => (qn.push(r), q.bridge.acknowledge()) });
    await q.signer.signMessage(AUTH, TEXT, { purpose: 'notes' });
    expect(qn[0]).toMatchObject({ title: 'Delete this file from the card', items: ['trikey-notes.txt'], continueLabel: 'I deleted it' });
    expect(qn[0]!.notes![0]).toMatch(/came back as a QR code, so it is not on the card.*starts with trikey-notes-signed.*it can open your notes/);

    // QR models show no such step: nothing was written anywhere.
    const c = await messageSetup('keystone-3');
    const d = drive(c.bridge, { show: () => c.bridge.finishShow(), scan: () => void feed(c.bridge, [sign(TEXT)]) });
    await c.signer.signMessage(AUTH, TEXT, { purpose: 'notes' });
    expect(d.log.map((r) => r.type)).toEqual(['show', 'scan']);
  });

  it('microSD: refuses a text either firmware would change or refuse, before anything is shown; a cancel rejects', async () => {
    const { signer, bridge } = await messageSetup('passport');
    const d = drive(bridge, { file: () => bridge.cancel() });
    await expect(signer.signMessage(AUTH, `${TEXT} `)).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/starts or ends with a space/) });
    await expect(signer.signMessage(AUTH, 'Trikey    four spaces')).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/more than 3 spaces/) });
    expect(d.log).toEqual([]);
    await expect(signer.signMessage(AUTH, TEXT)).rejects.toMatchObject({ code: 'cancelled' });
    const krux = await messageSetup('krux');
    await expect(krux.signer.signMessage(AUTH, ` ${TEXT}`)).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringMatching(/Krux does not sign a text that starts or ends with a space/) });
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
