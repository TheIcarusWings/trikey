import type { QrScanStep } from './bridge';
import { QrFrameAssembler } from './frames';
import type { QrPayload } from './types';

/**
 * Builds the `accept` function of a scan request: it assembles frames into a payload, then `convert`s the payload to what
 * the caller wants. If `convert` throws (a QR of the wrong kind, a signed transaction for another transaction), the
 * message becomes a hint for the user and scanning goes on from scratch.
 */
export function acceptFrames<T>(convert: (payload: QrPayload) => T): (frame: string) => QrScanStep<T> {
  const assembler = new QrFrameAssembler();
  return (frame) => {
    const step = assembler.receive(frame);
    if (!step.done) return { done: false, progress: step.progress };
    try {
      return { done: true, value: convert(step.payload) };
    } catch (e) {
      assembler.reset();
      return { done: false, hint: e instanceof Error ? e.message : String(e) };
    }
  };
}
