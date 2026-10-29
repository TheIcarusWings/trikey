/**
 * What the camera loop feeds: one decoded QR string at a time. The assembler works out whether it is UR, BBQr or plain
 * text, collects multi-frame payloads, and says when it has a complete `QrPayload`.
 */
import { BbqrFrameDecoder, isBbqrFrame } from './bbqr';
import { UrFrameDecoder } from './ur';
import type { QrPayload, QrProgress } from './types';

export type AssemblerStep = { done: false; progress?: QrProgress } | { done: true; payload: QrPayload };

export class QrFrameAssembler {
  private ur = new UrFrameDecoder();
  private bbqr = new BbqrFrameDecoder();
  private active?: 'ur' | 'bbqr';

  reset(): void {
    this.ur = new UrFrameDecoder();
    this.bbqr = new BbqrFrameDecoder();
    this.active = undefined;
  }

  receive(raw: string): AssemblerStep {
    const frame = raw.trim();
    if (/^ur:/i.test(frame)) {
      if (this.active !== 'ur') this.reset();
      this.active = 'ur';
      this.ur.receive(frame);
      if (this.ur.isComplete()) {
        const r = this.ur.result();
        return { done: true, payload: { type: 'ur', urType: r.type, cbor: r.cbor } };
      }
      return { done: false, progress: this.ur.progress() };
    }
    if (isBbqrFrame(frame)) {
      if (this.active !== 'bbqr') this.reset();
      this.active = 'bbqr';
      if (this.bbqr.receive(frame) && this.bbqr.isComplete()) {
        const r = this.bbqr.result();
        return { done: true, payload: { type: 'bbqr', fileType: r.fileType, data: r.data } };
      }
      return { done: false, progress: this.bbqr.progress() };
    }
    // A bare QR: the whole payload is in this one frame.
    return { done: true, payload: { type: 'text', text: frame } };
  }
}
