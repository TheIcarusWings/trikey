/**
 * The BitBox02's U2F HID framing: every message to and from the device travels as 64-byte reports, over USB and over
 * Bluetooth alike (the Nova's Bluetooth chip passes each 64-byte report to the main chip as one USB frame: firmware
 * `src/da14531/da14531_handler.c` `_hww_handler`, `USB_REPORT_SIZE`).
 *
 * A message is an init report (channel id, command, big-endian length, then 57 bytes) followed by continuation reports
 * (channel id, sequence number 0..127, then 59 bytes), zero-padded to 64 (FIDO U2F HID; the BitBox clients
 * `bitbox-api-ts/src/internal/u2f-framing.ts`, `bitbox-api-rs/src/u2fframing.rs`). The BitBox's own messages use the
 * command `0xC1` (`FIRMWARE_CMD = 0x80 | 0x40 | 0x01`) and, like the official clients, the channel id `0xff00ff00`.
 */
import { HardwareError } from '../errors';

export const REPORT_SIZE = 64;
const INIT_HEADER = 7;
const CONT_HEADER = 5;
const INIT_PAYLOAD = REPORT_SIZE - INIT_HEADER;
const CONT_PAYLOAD = REPORT_SIZE - CONT_HEADER;
/** The longest message the framing can carry: one init report and 128 continuations. */
export const MAX_MESSAGE = INIT_PAYLOAD + 128 * CONT_PAYLOAD;

/** The command of the BitBox02's own (non-U2F) messages. */
export const HWW_CMD = 0xc1;
/** The channel id the official clients use for every message. */
export const HWW_CID = 0xff00ff00;

const KIND = 'bitbox02' as const;

/** `message` as 64-byte reports, concatenated. */
export function encodeReports(message: Uint8Array, cmd = HWW_CMD, cid = HWW_CID): Uint8Array {
  if (message.length > MAX_MESSAGE) throw new HardwareError('invalid-request', 'The message is too long for the BitBox02.', { kind: KIND });
  const reports = message.length <= INIT_PAYLOAD ? 1 : 1 + Math.ceil((message.length - INIT_PAYLOAD) / CONT_PAYLOAD);
  const out = new Uint8Array(reports * REPORT_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, cid >>> 0, false);
  out[4] = cmd;
  view.setUint16(5, message.length, false);
  out.set(message.subarray(0, INIT_PAYLOAD), INIT_HEADER);
  let at = INIT_PAYLOAD;
  for (let seq = 0; at < message.length; seq++) {
    const base = (seq + 1) * REPORT_SIZE;
    view.setUint32(base, cid >>> 0, false);
    out[base + 4] = seq;
    out.set(message.subarray(at, at + CONT_PAYLOAD), base + CONT_HEADER);
    at += CONT_PAYLOAD;
  }
  return out;
}

/**
 * Reassembles one message from 64-byte reports. `push` returns the message once its last report arrives, `undefined`
 * before. Reports for another channel, another command or out of sequence are refused (the device never sends them).
 */
export class ReportReader {
  private buf?: Uint8Array;
  private length = 0;
  private filled = 0;
  private seq = 0;

  constructor(
    private readonly cmd = HWW_CMD,
    private readonly cid = HWW_CID,
  ) {}

  push(report: Uint8Array): Uint8Array | undefined {
    if (report.length !== REPORT_SIZE) throw this.bad(`a report of ${report.length} bytes instead of 64`);
    const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
    if (view.getUint32(0, false) !== this.cid >>> 0) throw this.bad('a report for another channel');
    if (this.buf === undefined) {
      if (report[4] !== this.cmd) throw this.bad(`command 0x${report[4]!.toString(16)} instead of 0x${this.cmd.toString(16)}`);
      this.length = view.getUint16(5, false);
      if (this.length > MAX_MESSAGE) throw this.bad('a message longer than the framing allows');
      this.buf = new Uint8Array(this.length);
      const n = Math.min(INIT_PAYLOAD, this.length);
      this.buf.set(report.subarray(INIT_HEADER, INIT_HEADER + n));
      this.filled = n;
      this.seq = 0;
    } else {
      if (report[4] !== this.seq) throw this.bad(`continuation ${report[4]} instead of ${this.seq}`);
      const n = Math.min(CONT_PAYLOAD, this.length - this.filled);
      this.buf.set(report.subarray(CONT_HEADER, CONT_HEADER + n), this.filled);
      this.filled += n;
      this.seq++;
    }
    if (this.filled < this.length) return undefined;
    const done = this.buf;
    this.buf = undefined;
    return done;
  }

  reset(): void {
    this.buf = undefined;
  }

  private bad(what: string): HardwareError {
    this.buf = undefined;
    return new HardwareError('invalid-response', `The BitBox02 sent ${what}.`, { kind: KIND });
  }
}
