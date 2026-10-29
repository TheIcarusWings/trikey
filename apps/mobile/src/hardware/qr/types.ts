/** How a payload is cut into QR frames. UR is Blockchain Commons' fountain-coded format, BBQr is Coinkite's. */
export type QrFormat = 'ur' | 'bbqr';

/** What a finished scan produced. */
export type QrPayload =
  | { type: 'ur'; urType: string; cbor: Uint8Array }
  | { type: 'bbqr'; fileType: string; data: Uint8Array }
  /** A QR that holds the whole thing in one frame as plain text: base64/hex PSBT, JSON, a descriptor, an xpub. */
  | { type: 'text'; text: string };

/** Progress of a multi-frame scan, for the progress bar. */
export interface QrProgress {
  /** 0..1 */
  fraction: number;
  /** Frames seen so far, and the total when it is known. */
  received: number;
  total?: number;
}
