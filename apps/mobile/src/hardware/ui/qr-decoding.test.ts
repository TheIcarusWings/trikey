// The QR reading of the Android build without Google code, from camera frame to what each screen does with the text.
//
// On the phone, modules/trikey-qr-camera hands CameraX frames to zxing-cpp (QrDecoder.kt) and sends each text read to
// JavaScript, where QrScanner passes it to the screen (qr-camera.android.foss.tsx, codeFromEvent). Here the same
// zxing-cpp, built for WebAssembly (zxing-wasm), reads frames drawn like a camera sees a screen or a printed sheet
// (scaled, tilted, blurred, noisy, dim, light on dark), with the reader options taken from QrDecoder.kt itself, and the
// text goes through the very parsers the screens use: pairing and recovery codes, contacts, addresses and payment links,
// the Recovery Kit, and animated UR and BBQr transactions.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { npubEncode } from 'nostr-tools/nip19';
import QRCode from 'qrcode';
import { beforeAll, describe, expect, it } from 'vitest';
import { NETWORKS } from '@trikey/core';
import { encodePairingUri, encodeRecoveryUri } from '@trikey/protocol';
import { parseScannedCode } from '@trikey/wallet/scan';
import { decodeKit, kitQrText } from '../../../../../packages/recovery-key/src/kit';
import { qrMatrix } from '../../../../../packages/recovery-key/src/kit-print';
import { fixtureKit } from '../../../../../packages/recovery-key/test/helpers';
import { codeFromEvent } from '../../../modules/trikey-qr-camera/events';
import { encodeBbqr } from '../qr/bbqr';
import { QrFrameAssembler } from '../qr/frames';
import { encodePsbtUr, psbtFromUr } from '../qr/ur';
import { makeFixture } from '../test/fixtures';
import type { QrPayload } from '../qr/types';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));

type Zxing = typeof import('zxing-wasm/reader');
type ReaderOptions = NonNullable<Parameters<Zxing['readBarcodes']>[1]>;
let zxing: Zxing;

// ---------------------------------------------------------------------------------------------------------------------
// The reader options of the app's decoder, read from its Kotlin source so the test cannot drift from it.

const DECODER_KT = path.join(mobileRoot, 'modules/trikey-qr-camera/android/src/main/java/app/trikey/qrcamera/QrDecoder.kt');

/** BarcodeReader.Options as QrDecoder.kt sets them (the Android wrapper's defaults for the rest), as zxing-wasm options. */
function nativeReaderOptions(): ReaderOptions {
  const src = readFileSync(DECODER_KT, 'utf8');
  const call = /BarcodeReader\.Options\(([\s\S]*?)\n\s*\)/.exec(src)?.[1];
  if (!call) throw new Error('QrDecoder.kt: no BarcodeReader.Options(...)');
  // The Kotlin wrapper's defaults (zxing-cpp's own C++ defaults differ, so they are spelled out).
  const flags: Record<string, boolean> = { tryHarder: false, tryRotate: false, tryInvert: false, tryDownscale: false, tryDenoise: false, isPure: false };
  for (const m of call.matchAll(/(\w+)\s*=\s*(true|false)\b/g)) {
    if (!(m[1]! in flags)) throw new Error(`QrDecoder.kt sets ${m[1]}, which this test does not mirror yet`);
    flags[m[1]!] = m[2] === 'true';
  }
  const formats = /formats\s*=\s*setOf\(([^)]*)\)/.exec(call)?.[1]?.split(',').map((f) => f.trim().replace('BarcodeReader.Format.', ''));
  const textMode = /textMode\s*=\s*BarcodeReader\.TextMode\.(\w+)/.exec(call)?.[1];
  const FORMAT: Record<string, 'QRCode'> = { QR_CODE: 'QRCode' };
  const TEXT_MODE: Record<string, 'Plain'> = { PLAIN: 'Plain' };
  if (!formats?.length || formats.some((f) => !FORMAT[f])) throw new Error(`QrDecoder.kt formats: ${formats}`);
  if (!textMode || !TEXT_MODE[textMode]) throw new Error(`QrDecoder.kt textMode: ${textMode}`);
  return { ...flags, formats: formats.map((f) => FORMAT[f]!), textMode: TEXT_MODE[textMode], maxNumberOfSymbols: 255 };
}

beforeAll(async () => {
  zxing = (await import('zxing-wasm/reader')) as Zxing;
  const wasm = readFileSync(requireHere.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await zxing.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }, fireImmediately: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Camera frames: a QR code drawn into a grey frame the way a camera sees it.

type Matrix = boolean[][];

/** The module matrix `qrcode` makes (what react-native-qrcode-svg and the guardian's web page draw). */
function matrixOf(text: string, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'M'): Matrix {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const n = qr.modules.size;
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => !!qr.modules.get(x, y)));
}

interface Shot {
  /** Pixels per module (a phone 20 cm from a screen sees about 4 to 8). */
  module?: number;
  /** Degrees the code is turned in the frame. */
  rotate?: number;
  /** Box blur radius in pixels (out of focus, motion). */
  blur?: number;
  /** Amplitude of the sensor noise added to each pixel. */
  noise?: number;
  /** Grey levels of the dark and light modules (a dim screen in a bright room has little contrast). */
  dark?: number;
  light?: number;
  /** Light modules on a dark background, as some hardware wallets show their codes. */
  inverted?: boolean;
  /** Where the code's centre is, as a fraction of the frame. */
  at?: [number, number];
  width?: number;
  height?: number;
  seed?: number;
}

/** A deterministic pseudo-random sequence (mulberry32), so a frame is the same on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame (RGBA, like a camera's luminance shown as grey) with `matrix` in it, with a quiet zone of 4 modules. */
function frame(matrix: Matrix, shot: Shot = {}): { data: Uint8ClampedArray; width: number; height: number } {
  const { module = 6, rotate = 0, blur = 0, noise = 0, inverted = false, at = [0.5, 0.5], width = 640, height = 480, seed = 1 } = shot;
  let dark = shot.dark ?? 30;
  let light = shot.light ?? 225;
  if (inverted) [dark, light] = [light, dark];
  const n = matrix.length;
  const quiet = 4;
  const side = (n + 2 * quiet) * module;
  const [cx, cy] = [at[0] * width, at[1] * height];
  const cos = Math.cos((rotate * Math.PI) / 180);
  const sin = Math.sin((rotate * Math.PI) / 180);
  // The background around the code's own quiet zone: a mid grey, like a device's bezel or a desk.
  const background = Math.round((dark + light) / 2);
  let lum: Float32Array = new Float32Array(width * height);
  // Each pixel is the average of 3x3 samples: the edges of the modules are as soft as a lens makes them.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3 - cx;
          const py = y + (sy + 0.5) / 3 - cy;
          // Into the code's own coordinates (turned back by `rotate`), from its centre.
          const u = (cos * px + sin * py + side / 2) / module - quiet;
          const v = (-sin * px + cos * py + side / 2) / module - quiet;
          if (u < -quiet || v < -quiet || u >= n + quiet || v >= n + quiet) sum += background;
          else {
            const [mx, my] = [Math.floor(u), Math.floor(v)];
            sum += mx >= 0 && my >= 0 && mx < n && my < n && matrix[my]![mx] ? dark : light;
          }
        }
      }
      lum[y * width + x] = sum / 9;
    }
  }
  if (blur > 0) lum = boxBlur(lum, width, height, blur);
  const rnd = random(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = lum[i]! + (noise ? (rnd() * 2 - 1) * noise : 0);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const pass = (input: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let count = 0;
        for (let d = -r; d <= r; d++) {
          const [xx, yy] = horizontal ? [x + d, y] : [x, y + d];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += input[yy * w + xx]!;
          count++;
        }
        out[y * w + x] = sum / count;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/**
 * What the app's decoder reads in a frame, and what the scanner then hands to the screen: zxing-cpp with QrDecoder.kt's
 * options, the same filter as QrDecoder.read (text, no error), then the view event as QrCamera reads it.
 */
async function scan(image: ReturnType<typeof frame>, change: Partial<ReaderOptions> = {}): Promise<string[]> {
  const results = await zxing.readBarcodes(image as unknown as Parameters<Zxing['readBarcodes']>[0], { ...nativeReaderOptions(), ...change });
  return results
    .filter((r) => r.isValid && r.text.length > 0)
    .map((r) => codeFromEvent({ nativeEvent: { data: r.text } }))
    .filter((t): t is string => t !== null);
}

async function scanOne(matrix: Matrix, shot?: Shot): Promise<string> {
  const codes = await scan(frame(matrix, shot));
  expect(codes).toHaveLength(1);
  return codes[0]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the screens scan, with throwaway keys.

const NOW = 1_800_000_000;
const guardianPub = hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true).slice(1));
const relays = ['wss://relay.example.com', 'wss://nos.lol'];
const PAIRING = encodePairingUri({ guardianPubkey: guardianPub, relays, secret: 'a'.repeat(43), expiresAt: NOW + 300, label: 'Umbrel' }, NOW);
const RECOVERY = encodeRecoveryUri({ guardianPubkey: guardianPub, relays, network: 'signet', label: 'Umbrel' });
const ADDRESS = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true), NETWORKS.testnet.btc).address!;
const CONTACT = npubEncode(hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(5), true).slice(1)));

describe('the app reads QR codes with its own decoder (FOSS Android build)', () => {
  it('uses the reader options of QrDecoder.kt: QR codes only, harder, inverted and downscaled tries, plain text', () => {
    expect(nativeReaderOptions()).toMatchObject({ formats: ['QRCode'], tryHarder: true, tryInvert: true, tryDownscale: true, textMode: 'Plain' });
  });

  it('a guardian pairing code, held up to the camera a little turned and out of focus', async () => {
    const text = await scanOne(matrixOf(PAIRING), { module: 5, rotate: 12, blur: 1, noise: 12 });
    expect(text).toBe(PAIRING);
    expect(parseScannedCode(text, { now: NOW })).toMatchObject({ kind: 'pairing', uri: PAIRING, relays, label: 'Umbrel' });
  });

  it("a guardian's recovery code on a dim screen in a bright room", async () => {
    const text = await scanOne(matrixOf(RECOVERY), { module: 5, dark: 90, light: 150, noise: 10 });
    expect(parseScannedCode(text, { network: 'signet' })).toMatchObject({ kind: 'recovery', network: 'signet', uri: RECOVERY });
  });

  it('a contact (npub), shown light on dark', async () => {
    const text = await scanOne(matrixOf(CONTACT), { module: 6, inverted: true, noise: 8 });
    expect(parseScannedCode(text)).toMatchObject({ kind: 'contact', npub: CONTACT });
    // Why QrDecoder asks for tryInvert: without it, the same frame reads as nothing.
    expect(await scan(frame(matrixOf(CONTACT), { module: 6, inverted: true, noise: 8 }), { tryInvert: false })).toEqual([]);
  });

  it('an address and a BIP 21 payment link, small and off centre', async () => {
    const link = `bitcoin:${ADDRESS.toUpperCase()}?amount=0.00150001&label=Coffee%20shop`;
    expect(parseScannedCode(await scanOne(matrixOf(ADDRESS.toUpperCase(), 'L'), { module: 3, at: [0.3, 0.6] }), { network: 'testnet' })).toEqual({
      kind: 'address',
      address: ADDRESS,
      network: 'testnet',
    });
    expect(parseScannedCode(await scanOne(matrixOf(link), { module: 4, rotate: -20, blur: 1 }), { network: 'testnet' })).toMatchObject({
      kind: 'address',
      address: ADDRESS,
      amountSats: 150_001,
      label: 'Coffee shop',
    });
  });

  it('the QR code of a printed Recovery Kit (as kit-print draws it), photographed at an angle', async () => {
    const kit = await fixtureKit();
    const text = await scanOne(qrMatrix(kitQrText(kit)), { module: 4, rotate: 30, blur: 1, noise: 15, width: 800, height: 600 });
    expect(text.startsWith('TRIKEYKIT1:')).toBe(true); // what the kit screens check before reading it
    expect(decodeKit(text)).toEqual(kit);
  });

  it('an animated UR transaction (crypto-psbt), frame by frame, into the same payload as the frames sent', async () => {
    const f = await makeFixture();
    const frames = encodePsbtUr(f.psbt, { maxFragmentLength: 120 });
    expect(frames.length).toBeGreaterThan(3);
    const assembler = new QrFrameAssembler();
    let payload: QrPayload | undefined;
    for (const [i, ur] of [...frames, ...frames].entries()) {
      // Each frame a little different, like a hand-held phone: angle, focus and noise vary.
      const text = await scanOne(matrixOf(ur.toUpperCase(), 'L'), { module: 5, rotate: (i % 5) * 4 - 8, blur: i % 2, noise: 10, seed: i + 1 });
      const step = assembler.receive(text);
      if (step.done) {
        payload = step.payload;
        break;
      }
    }
    expect(payload?.type).toBe('ur');
    expect(psbtFromUr({ type: (payload as { urType: string }).urType, cbor: (payload as { cbor: Uint8Array }).cbor })).toEqual(f.psbt);
  });

  it('an animated BBQr transaction (Coldcard style, zlib), frame by frame', async () => {
    const f = await makeFixture();
    const parts = encodeBbqr(f.psbt, 'P', { encoding: 'Z', minVersion: 5, maxVersion: 8 });
    expect(parts.length).toBeGreaterThan(1);
    const assembler = new QrFrameAssembler();
    let payload: QrPayload | undefined;
    for (const [i, part] of parts.entries()) {
      const step = assembler.receive(await scanOne(matrixOf(part, 'L'), { module: 5, rotate: i * 3, noise: 12, seed: i + 7 }));
      if (step.done) payload = step.payload;
    }
    expect(payload).toEqual({ type: 'bbqr', fileType: 'P', data: f.psbt });
  });

  it('a dense code (version 20 and up) at the resolution the camera module asks for', async () => {
    const f = await makeFixture();
    const [single] = encodePsbtUr(f.psbt, { maxFragmentLength: 2000 });
    const matrix = matrixOf(single!.toUpperCase(), 'L');
    expect(matrix.length).toBeGreaterThanOrEqual(97); // version 20 is 97 modules across
    // QrDecoder gets 1920x1080 frames (TrikeyQrCameraView.ANALYSIS_SIZE); here the code fills about half the height.
    const text = await scanOne(matrix, { module: 5, width: 1280, height: 720, blur: 1, noise: 8 });
    expect(new QrFrameAssembler().receive(text)).toMatchObject({ done: true, payload: { type: 'ur', urType: 'crypto-psbt' } });
  });

  it('reads nothing in a frame without a code, or with only half a code in view', async () => {
    expect(await scan(frame([[false]], { module: 1, noise: 30 }))).toEqual([]);
    expect(await scan(frame(matrixOf(PAIRING), { module: 6, at: [1.0, 0.5] }))).toEqual([]);
  });

  it('passes on only the text of a scan event, whatever else the event carries', () => {
    expect(codeFromEvent({ nativeEvent: { data: PAIRING } })).toBe(PAIRING);
    for (const data of [undefined, null, '', 42, { text: 'x' }]) expect(codeFromEvent({ nativeEvent: { data } })).toBeNull();
    expect(codeFromEvent(undefined)).toBeNull();
  });
});
