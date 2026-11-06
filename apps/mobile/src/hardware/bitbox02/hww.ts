/**
 * The BitBox02's request layer above the framing (firmware `src/hww.c`, `hww_req_t` / `hww_rsp_t`; client
 * `bitbox-api-ts/src/internal/hww.ts`):
 *
 * - `i` (0x69), sent alone: the device info, answered at once and unframed by status: a length-prefixed version string
 *   ("v9.27.1"), the platform (0 BitBox02, 2 Nova), the edition (0 Multi, 1 Bitcoin-only), unlocked, initialized
 *   (`_api_info`).
 * - `0x00` + request: a new request. The device answers `0x00` (ACK) + the response when it has one at once, `0x01`
 *   (NOT_READY) while the owner is still deciding on the device, `0x02` (BUSY) when another workflow holds it, `0x03` (NACK)
 *   on a framing error. While NOT_READY the host asks again with `0x01` (retry) until it gets ACK: this is how a request
 *   waits for the owner, so no timeout applies to the owner's decision, only to each round trip.
 * - `0x03`: reset the session (firmware 9.28.0 and later), so a host that reconnects after an interrupted request starts
 *   clean (`_reset_session`).
 */
import { HardwareError } from '../errors';
import { REPORT_SIZE, ReportReader, encodeReports } from './framing';
import type { BitBoxConnection } from './link';

const KIND = 'bitbox02' as const;

export const HWW_REQ_NEW = 0x00;
export const HWW_REQ_RETRY = 0x01;
export const HWW_REQ_RESET = 0x03;
export const HWW_REQ_INFO = 0x69;
export const HWW_RSP_ACK = 0x00;
export const HWW_RSP_NOT_READY = 0x01;
export const HWW_RSP_BUSY = 0x02;
export const HWW_RSP_NACK = 0x03;

/** The BitBox02 answers every round trip at once (NOT_READY while it waits for the owner): a silent link is dead. */
const ROUND_TRIP_TIMEOUT_MS = 15_000;
const NOT_READY_SLEEP_MS = 200;
const BUSY_SLEEP_MS = 1000;
/** How long a BUSY device (another workflow on it) is waited for before giving up. */
const BUSY_GIVE_UP_MS = 30_000;

export type BitBoxPlatform = 'bitbox02' | 'bitbox02-nova';

export interface HwwInfo {
  /** "9.27.1" (without the "v"). */
  version: string;
  platform: BitBoxPlatform;
  edition: 'multi' | 'btconly';
  unlocked: boolean;
  initialized?: boolean;
}

export interface HwwOptions {
  sleep?: (ms: number) => Promise<void>;
  roundTripTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "9.27.1" >= [9, 27, 1]. */
export function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
}

/** Parses the answer to `i` (`src/hww.c` `_api_info`). */
export function parseInfo(r: Uint8Array): HwwInfo {
  const bad = (why: string) => new HardwareError('invalid-response', `The BitBox02 gave device information Trikey cannot read (${why}).`, { kind: KIND });
  if (r.length < 1) throw bad('empty');
  const n = r[0]!;
  if (r.length < 1 + n + 3) throw bad('too short');
  const raw = new TextDecoder().decode(r.subarray(1, 1 + n));
  if (!/^v\d+\.\d+\.\d+$/.test(raw)) throw bad(`version "${raw}"`);
  const [platform, edition, unlocked, initialized] = [r[1 + n]!, r[2 + n]!, r[3 + n]!, r[4 + n]];
  if (platform !== 0 && platform !== 2) throw bad(`platform ${platform}`);
  if (edition !== 0 && edition !== 1) throw bad(`edition ${edition}`);
  if (unlocked !== 0 && unlocked !== 1) throw bad(`locked byte ${unlocked}`);
  if (initialized !== undefined && initialized !== 0 && initialized !== 1) throw bad(`initialized byte ${initialized}`);
  return {
    version: raw.slice(1),
    platform: platform === 2 ? 'bitbox02-nova' : 'bitbox02',
    edition: edition === 1 ? 'btconly' : 'multi',
    unlocked: unlocked === 1,
    ...(initialized === undefined ? {} : { initialized: initialized === 1 }),
  };
}

export class BitBoxHww {
  private readonly reader = new ReportReader();
  private readonly offReport: () => void;
  private readonly offDown: () => void;
  private waiting?: { resolve: (m: Uint8Array) => void; reject: (e: Error) => void };
  private inbox: Uint8Array[] = [];
  private down?: Error;
  private busy = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    readonly conn: BitBoxConnection,
    opts: HwwOptions = {},
  ) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.roundTripTimeoutMs ?? ROUND_TRIP_TIMEOUT_MS;
    this.offReport = conn.onReport((report) => {
      let message: Uint8Array | undefined;
      try {
        message = this.reader.push(report);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (!message) return;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(message);
      } else this.inbox.push(message);
    });
    this.offDown = conn.onDisconnect((error) => {
      this.fail(new HardwareError('disconnected', 'The BitBox02 disconnected. Keep it plugged in (or close to the phone) and try again.', { kind: KIND, detail: error }));
    });
  }

  private fail(e: Error): void {
    this.down ??= e;
    const w = this.waiting;
    this.waiting = undefined;
    w?.reject(e);
  }

  /** One framed message out, one framed message back. */
  async roundTrip(message: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.down) throw this.down;
    if (this.busy) throw new HardwareError('device-error', 'The BitBox02 is already answering another request.', { kind: KIND });
    this.busy = true;
    try {
      this.inbox = [];
      this.reader.reset();
      await this.conn.write(encodeReports(message));
      return await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = undefined;
          reject(new HardwareError('timeout', 'The BitBox02 stopped answering. Unplug it (or turn it off and on), then try again.', { kind: KIND }));
        }, this.timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          this.waiting = undefined;
          reject(new HardwareError('cancelled', 'Cancelled.', { kind: KIND }));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const done = (fn: () => void) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          fn();
        };
        const early = this.inbox.shift();
        if (early) return done(() => resolve(early));
        if (this.down) return done(() => reject(this.down));
        this.waiting = { resolve: (m) => done(() => resolve(m)), reject: (e) => done(() => reject(e)) };
      });
    } finally {
      this.busy = false;
    }
  }

  async info(signal?: AbortSignal): Promise<HwwInfo> {
    return parseInfo(await this.roundTrip(new Uint8Array([HWW_REQ_INFO]), signal));
  }

  /** Clears an unfinished session on the device (firmware 9.28.0 and later only; older firmware has no such command). */
  async resetSession(signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    for (;;) {
      const r = await this.roundTrip(new Uint8Array([HWW_REQ_RESET]), signal);
      if (r.length === 1 && r[0] === HWW_RSP_ACK) return;
      if (r.length === 1 && r[0] === HWW_RSP_BUSY && Date.now() - started < BUSY_GIVE_UP_MS) {
        await this.sleep(BUSY_SLEEP_MS);
        continue;
      }
      throw new HardwareError('device-error', 'The BitBox02 did not reset its session.', { kind: KIND });
    }
  }

  /** A request, waiting (by NOT_READY and retry) for as long as the owner takes on the device. */
  async request(payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const framed = new Uint8Array(payload.length + 1);
    framed[0] = HWW_REQ_NEW;
    framed.set(payload, 1);
    const started = Date.now();
    let r = await this.roundTrip(framed, signal);
    while (r.length >= 1 && r[0] === HWW_RSP_BUSY) {
      if (Date.now() - started > BUSY_GIVE_UP_MS)
        throw new HardwareError('device-error', 'The BitBox02 is busy with something else. Finish or cancel it on the BitBox02, then try again.', { kind: KIND });
      await this.sleep(BUSY_SLEEP_MS);
      r = await this.roundTrip(framed, signal);
    }
    for (;;) {
      if (r.length < 1) throw new HardwareError('invalid-response', 'The BitBox02 sent an empty answer.', { kind: KIND });
      if (r[0] === HWW_RSP_ACK) return r.slice(1);
      if (r[0] !== HWW_RSP_NOT_READY) throw new HardwareError('device-error', `The BitBox02 refused the request (status ${r[0]}).`, { kind: KIND });
      await this.sleep(NOT_READY_SLEEP_MS);
      if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      r = await this.roundTrip(new Uint8Array([HWW_REQ_RETRY]), signal);
    }
  }

  async close(): Promise<void> {
    this.offReport();
    this.offDown();
    this.fail(new HardwareError('disconnected', 'The connection to the BitBox02 was closed.', { kind: KIND }));
    await this.conn.close().catch(() => undefined);
  }
}

export { REPORT_SIZE };
