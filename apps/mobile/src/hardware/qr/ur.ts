/**
 * Uniform Resources (UR, Blockchain Commons BCR-2020-005): the QR format Keystone, Passport, Jade, SeedSigner and
 * others use. A payload becomes `ur:<type>/<bytewords>` for one QR, or `ur:<type>/<seq>-<count>/<bytewords>` fountain-coded
 * frames for an animation. Written on top of `@ngraveio/bc-ur`; tested against the reference vectors of the C++ library.
 *
 * `crypto-psbt` carries a PSBT as a CBOR byte string; `crypto-hdkey`, `crypto-account` and `crypto-multi-accounts` carry
 * the xpubs a device exports (see export.ts).
 */
import '../common/buffer';
import { UR, URDecoder, UREncoder } from '@ngraveio/bc-ur';
import { CryptoPSBT } from '@keystonehq/bc-ur-registry';
import { HardwareError } from '../errors';
import type { QrProgress } from './types';

export const UR_PSBT_TYPE = 'crypto-psbt';
export const DEFAULT_UR_FRAGMENT_LENGTH = 250;

export interface UrEncodeOptions {
  /** Maximum payload bytes per frame. Smaller means simpler QR codes and more frames. Default 250. */
  maxFragmentLength?: number;
  /** Fountain frames shown after the plain ones, to recover from missed frames. Default: half as many as the plain frames. */
  extraFrames?: number;
}

/** The frames of a UR with the given type for a payload that is already CBOR (what `UR.cbor` holds). */
export function encodeUrCbor(type: string, cbor: Uint8Array, opts: UrEncodeOptions = {}): string[] {
  const ur = new UR(Buffer.from(cbor), type);
  const encoder = new UREncoder(ur, opts.maxFragmentLength ?? DEFAULT_UR_FRAGMENT_LENGTH);
  const plain = encoder.fragmentsLength;
  if (plain <= 1) return [encoder.nextPart()];
  const total = plain + (opts.extraFrames ?? Math.ceil(plain / 2));
  return Array.from({ length: total }, () => encoder.nextPart());
}

/** A byte string as UR: the payload is wrapped in a CBOR byte string, as every UR type that carries bytes does. */
export function encodeUrBytes(type: string, bytes: Uint8Array, opts: UrEncodeOptions = {}): string[] {
  return encodeUrCbor(type, UR.fromBuffer(Buffer.from(bytes)).cbor, opts);
}

export function encodePsbtUr(psbt: Uint8Array, opts?: UrEncodeOptions): string[] {
  return encodeUrBytes(UR_PSBT_TYPE, psbt, opts);
}

export interface UrResult {
  type: string;
  /** The CBOR payload of the UR. */
  cbor: Uint8Array;
}

/** Collects UR frames (any order, fountain-coded) until the payload is complete. */
export class UrFrameDecoder {
  private decoder = new URDecoder();
  private frames = 0;

  /** Feeds one frame. Returns false if the frame was not a valid part of this UR (wrong type, corrupt, or for another UR). */
  receive(frame: string): boolean {
    // QR alphanumeric mode is uppercase-only, and some devices show UR in capitals.
    const part = frame.trim().toLowerCase();
    if (!part.startsWith('ur:')) return false;
    const tryReceive = (decoder: URDecoder): boolean => {
      try {
        return decoder.receivePart(part);
      } catch {
        return false;
      }
    };
    if (tryReceive(this.decoder)) {
      this.frames++;
      return true;
    }
    // `receivePart` accepts duplicates and redundant fountain frames, so a refusal means the frame is invalid or belongs
    // to another message (the user scanned a different QR code halfway). If it is a valid start of something else, move on
    // to it, or this decoder would stay stuck on the first message.
    if (this.frames > 0 && !this.decoder.isComplete()) {
      const fresh = new URDecoder();
      if (tryReceive(fresh)) {
        this.decoder = fresh;
        this.frames = 1;
        return true;
      }
    }
    return false;
  }

  isComplete(): boolean {
    return this.decoder.isComplete();
  }

  progress(): QrProgress {
    if (this.decoder.isComplete()) return { fraction: 1, received: this.frames, total: this.frames };
    const total = this.decoder.expectedPartCount();
    const received = this.decoder.receivedPartIndexes().length;
    return { fraction: this.decoder.estimatedPercentComplete(), received, total: total || undefined };
  }

  result(): UrResult {
    if (!this.decoder.isComplete()) throw new HardwareError('invalid-response', 'The QR codes are not complete yet.');
    if (!this.decoder.isSuccess()) throw new HardwareError('invalid-response', `The QR codes could not be decoded: ${this.decoder.resultError()}`);
    const ur = this.decoder.resultUR();
    return { type: ur.type, cbor: new Uint8Array(ur.cbor) };
  }
}

/** The PSBT inside a `crypto-psbt` payload. */
export function psbtFromUr(result: UrResult): Uint8Array {
  if (result.type !== UR_PSBT_TYPE) throw new HardwareError('invalid-response', `Expected a signed transaction (crypto-psbt) but the QR is a ${result.type}.`);
  let psbt: Uint8Array;
  try {
    psbt = new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(result.cbor)).getPSBT());
  } catch (e) {
    throw new HardwareError('invalid-response', 'The QR does not hold a valid PSBT.', { detail: e });
  }
  // The registry decoder is lenient; a PSBT starts with "psbt" and 0xff.
  if (psbt.length < 5 || psbt[0] !== 0x70 || psbt[1] !== 0x73 || psbt[2] !== 0x62 || psbt[3] !== 0x74 || psbt[4] !== 0xff)
    throw new HardwareError('invalid-response', 'The QR does not hold a valid PSBT.');
  return psbt;
}
