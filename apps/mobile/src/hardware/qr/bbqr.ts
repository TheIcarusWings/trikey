/**
 * BBQr, Coinkite's "Better Bitcoin QR" (https://github.com/coinkite/BBQr): the format of the Coldcard Q.
 * Every frame is `B$` + encoding (H hex, 2 base32, Z zlib+base32) + file type (P PSBT, T transaction, J JSON, U text...)
 * + two base-36 digits for the frame count + two for this frame's index, then the data. Frames may arrive in any order.
 *
 * Splitting and joining are done by the `bbqr` package; this wrapper adds the frame bookkeeping a camera loop needs.
 */
import { joinQRs, splitQRs } from 'bbqr';
import { HardwareError } from '../errors';
import type { QrProgress } from './types';

export type BbqrFileType = 'P' | 'T' | 'J' | 'U' | 'C' | 'B';
export type BbqrEncoding = 'H' | '2' | 'Z';

export interface BbqrEncodeOptions {
  /** Default 'Z': zlib then base32, the smallest. The library falls back to base32 if compression does not help. */
  encoding?: BbqrEncoding;
  /** Largest QR version to use. The Coldcard Q reads high versions, but a phone screen is easier to scan with fewer, simpler codes. Default 15. */
  maxVersion?: number;
  minVersion?: number;
}

export function encodeBbqr(data: Uint8Array, fileType: BbqrFileType, opts: BbqrEncodeOptions = {}): string[] {
  const result = splitQRs(data, fileType, {
    encoding: opts.encoding ?? 'Z',
    minVersion: (opts.minVersion ?? 5) as never,
    maxVersion: (opts.maxVersion ?? 15) as never,
  });
  return result.parts;
}

const HEADER = /^B\$([H2Z])([A-Z0-9])([0-9A-Z]{2})([0-9A-Z]{2})/;

export function isBbqrFrame(frame: string): boolean {
  return /^B\$/i.test(frame.trim());
}

export interface BbqrResult {
  fileType: string;
  data: Uint8Array;
}

/** Collects BBQr frames in any order until all are in. */
export class BbqrFrameDecoder {
  private parts = new Map<number, string>();
  private header?: { encoding: string; fileType: string; total: number };

  /** Returns false if the frame is not BBQr or belongs to a different series (then the decoder starts over with it). */
  receive(frame: string): boolean {
    // Alphanumeric QR mode is uppercase; be lenient about a lowercased copy.
    const text = frame.trim().toUpperCase();
    const m = HEADER.exec(text);
    if (!m) return false;
    const total = parseInt(m[3]!, 36);
    const index = parseInt(m[4]!, 36);
    if (total < 1 || index >= total) return false;
    const header = { encoding: m[1]!, fileType: m[2]!, total };
    if (this.header && (this.header.encoding !== header.encoding || this.header.fileType !== header.fileType || this.header.total !== header.total)) {
      this.parts.clear();
    }
    this.header = header;
    this.parts.set(index, text);
    return true;
  }

  isComplete(): boolean {
    return !!this.header && this.parts.size === this.header.total;
  }

  progress(): QrProgress {
    const total = this.header?.total;
    const received = this.parts.size;
    return { fraction: total ? received / total : 0, received, total };
  }

  result(): BbqrResult {
    if (!this.header || !this.isComplete()) throw new HardwareError('invalid-response', 'The QR codes are not complete yet.');
    const ordered = Array.from({ length: this.header.total }, (_, i) => this.parts.get(i)!);
    try {
      const joined = joinQRs(ordered);
      return { fileType: joined.fileType, data: joined.raw };
    } catch (e) {
      throw new HardwareError('invalid-response', 'The QR codes could not be decoded.', { detail: e });
    }
  }
}
