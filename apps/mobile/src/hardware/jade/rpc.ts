/**
 * Jade's RPC over a byte pipe (firmware `main/wire.c`, `main/utils/cbor_rpc.{c,h}`, docs/index.rst; client
 * `jadepy/jade.py` `JadeInterface`):
 *
 * - A request is one CBOR map `{ id, method, params? }`: `id` a string of 1 to 16 characters (`MAXLEN_ID`), `method` up
 *   to 32 (`rpc_request_valid`). Requests are written back to back with no length prefix; the Jade parses a message once
 *   its CBOR is complete (`get_msg_len`) and drops a partial message after 2 to 3 seconds without new bytes
 *   (`TIMEOUT_TICKS`), so a message is written in one go.
 * - A reply is a map `{ id, result }` or `{ id, error: { code, message, data } }`. The Jade also sends `{ log: <bytes> }`
 *   lines, which are skipped (`jadepy` `read_cbor_message`). An error about a message it could not read at all has the
 *   id "00" (`validate_reply`).
 * - Error codes (`cbor_rpc.h`): -32600 invalid request, -32601 unknown method, -32602 bad parameters, -32603 internal
 *   error, -32000 the owner declined on the Jade, -32001 protocol error, -32002 locked, -32003 network mismatch.
 *
 * One request at a time: Jade handles messages in order (docs/index.rst), and every flow here waits for each reply.
 */
import type { HardwareKind } from '@trikey/wallet';
import { HardwareError } from '../errors';
import { CborError, CborIncomplete, decodeCbor, encodeCbor, type CborValue } from './cbor';
import type { JadeConnection } from './link';

const KIND: HardwareKind = 'jade-ble';

export const JADE_ERROR = {
  INVALID_REQUEST: -32600,
  UNKNOWN_METHOD: -32601,
  BAD_PARAMETERS: -32602,
  INTERNAL_ERROR: -32603,
  USER_CANCELLED: -32000,
  PROTOCOL_ERROR: -32001,
  HW_LOCKED: -32002,
  NETWORK_MISMATCH: -32003,
} as const;

/** An `error` reply from the Jade, mapped to the adapters' codes; `jadeCode` and `jadeMessage` are the Jade's own. */
export class JadeRpcError extends HardwareError {
  constructor(
    readonly jadeCode: number,
    readonly jadeMessage: string,
    readonly method: string,
  ) {
    super(codeFor(jadeCode), messageFor(jadeCode, jadeMessage, method), { kind: KIND, detail: { code: jadeCode, message: jadeMessage, method } });
  }
}

function codeFor(code: number): HardwareError['code'] {
  switch (code) {
    case JADE_ERROR.USER_CANCELLED:
      return 'user-rejected';
    case JADE_ERROR.HW_LOCKED:
      return 'device-locked';
    case JADE_ERROR.NETWORK_MISMATCH:
    case JADE_ERROR.BAD_PARAMETERS:
    case JADE_ERROR.INVALID_REQUEST:
    case JADE_ERROR.UNKNOWN_METHOD:
      return 'invalid-request';
    default:
      return 'device-error';
  }
}

function messageFor(code: number, message: string, method: string): string {
  switch (code) {
    case JADE_ERROR.USER_CANCELLED:
      return 'You declined on the Jade.';
    case JADE_ERROR.HW_LOCKED:
      return 'The Jade is locked, or unlocked over another connection (USB or QR mode). Unlock it over Bluetooth with Trikey and try again.';
    case JADE_ERROR.NETWORK_MISMATCH:
      return 'This Jade is set up for another network (mainnet or the test networks): use it with a wallet on its own network.';
    case JADE_ERROR.UNKNOWN_METHOD:
      return `This Jade's firmware does not know "${method}". Update the Jade's firmware and try again.`;
    default:
      return `The Jade answered: ${message || 'an error'} (${code}).`;
  }
}

export interface JadeReply {
  id: string;
  result?: CborValue;
  error?: { code: number; message: string };
  /** Replies split over several messages (`sign_psbt`): this part's number and the count (`get_extended_data`). */
  seqnum?: number;
  seqlen?: number;
}

export interface CallOptions {
  /** Milliseconds to wait for the reply; `null` waits as long as it takes (the owner acts on the Jade). Default 30 s. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A partial message is kept at most this long (bytes); the Jade never sends one this big. */
const MAX_BUFFER = 1 << 20;

function isMap(v: unknown): v is Record<string, CborValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

export class JadeRpc {
  private buffer = new Uint8Array(0);
  private waiting?: { id: string; resolve: (r: JadeReply) => void; reject: (e: unknown) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = Math.floor(Math.random() * 900_000) + 100_000;
  private closed?: Error;
  private readonly offs: Array<() => void> = [];
  /** Bytes that were not CBOR the Jade would send, for the log. Never shown to the owner. */
  junk = 0;

  constructor(private readonly conn: JadeConnection) {
    this.offs.push(conn.onData((bytes) => this.receive(bytes)));
    this.offs.push(
      conn.onDisconnect((e) => {
        this.closed = new HardwareError('disconnected', 'The Jade disconnected. Keep it on and close to the phone, and try again.', { kind: KIND, detail: e });
        this.waiting?.reject(this.closed);
        this.waiting = undefined;
      }),
    );
  }

  private receive(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    for (;;) {
      if (this.buffer.length === 0) return;
      let decoded: { value: CborValue; end: number };
      try {
        decoded = decodeCbor(this.buffer);
      } catch (e) {
        if (!(e instanceof CborError)) throw e;
        if (e instanceof CborIncomplete && this.buffer.length < MAX_BUFFER) return;
        // Not CBOR (or a runaway partial message): drop a byte and look again.
        this.junk++;
        this.buffer = this.buffer.slice(1);
        continue;
      }
      this.buffer = this.buffer.slice(decoded.end);
      this.handle(decoded.value);
    }
  }

  private handle(message: CborValue): void {
    if (!isMap(message)) return;
    if ('log' in message && !('id' in message)) return;
    const id = message.id;
    if (typeof id !== 'string') return;
    const w = this.waiting;
    if (!w) return;
    // "00": the Jade could not read a message at all (jadepy validate_reply).
    if (id !== w.id && !(id === '00' && 'error' in message)) return;
    this.waiting = undefined;
    const reply: JadeReply = { id };
    if ('error' in message) {
      const err = isMap(message.error) ? message.error : {};
      reply.error = { code: typeof err.code === 'number' ? err.code : JADE_ERROR.INTERNAL_ERROR, message: typeof err.message === 'string' ? err.message : '' };
    } else if ('result' in message) {
      reply.result = message.result;
    } else {
      w.reject(new HardwareError('invalid-response', 'The Jade sent a reply with neither a result nor an error.', { kind: KIND }));
      return;
    }
    if (typeof message.seqnum === 'number') reply.seqnum = message.seqnum;
    if (typeof message.seqlen === 'number') reply.seqlen = message.seqlen;
    w.resolve(reply);
  }

  private newId(): string {
    this.nextId = this.nextId >= 999_999 ? 100_000 : this.nextId + 1;
    return String(this.nextId);
  }

  /** Sends one request and waits for its reply (in order behind any request still waiting). The whole reply. */
  request(method: string, params?: Record<string, unknown>, opts: CallOptions = {}): Promise<JadeReply> {
    const run = () => this.send(method, params, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** `request`, then the result, or a `JadeRpcError` for an error reply. */
  async call(method: string, params?: Record<string, unknown>, opts: CallOptions = {}): Promise<CborValue> {
    const reply = await this.request(method, params, opts);
    if (reply.error) throw new JadeRpcError(reply.error.code, reply.error.message, method);
    return reply.result ?? null;
  }

  private async send(method: string, params: Record<string, unknown> | undefined, opts: CallOptions, id = this.newId()): Promise<JadeReply> {
    if (this.closed) throw this.closed;
    if (opts.signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
    const bytes = encodeCbor(params === undefined ? { id, method } : { id, method, params });
    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    return new Promise<JadeReply>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (this.waiting?.id === id) this.waiting = undefined;
      };
      const onAbort = () => {
        done();
        reject(new HardwareError('cancelled', 'Cancelled.', { kind: KIND }));
      };
      this.waiting = {
        id,
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      };
      if (timeoutMs !== null)
        timer = setTimeout(() => {
          done();
          reject(new HardwareError('timeout', 'The Jade did not answer in time. Check that it is on, unlocked and close to the phone.', { kind: KIND }));
        }, timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.conn.write(bytes).catch((e: unknown) => {
        done();
        reject(e instanceof HardwareError ? e : new HardwareError('disconnected', 'Could not send to the Jade. Keep it close to the phone and try again.', { kind: KIND, detail: e }));
      });
    });
  }

  /**
   * A reply split over several messages (`sign_psbt`, docs/index.rst "get_extended_data"): the first part comes with
   * `seqnum` 1 and `seqlen` n; each next part is asked for with `get_extended_data { origid, orig, seqnum, seqlen }`, and
   * the byte results are joined (`jadepy` `sign_psbt`, firmware `sign_psbt.c` `sign_psbt_process`).
   */
  async callJoined(method: string, params: Record<string, unknown>, opts: CallOptions = {}): Promise<Uint8Array> {
    const first = await this.requestWithId(method, params, opts);
    const parts: Uint8Array[] = [];
    let reply = first.reply;
    for (;;) {
      if (reply.error) throw new JadeRpcError(reply.error.code, reply.error.message, method);
      if (!(reply.result instanceof Uint8Array)) throw new HardwareError('invalid-response', `The Jade's answer to ${method} is not bytes.`, { kind: KIND });
      parts.push(reply.result);
      const { seqnum, seqlen } = reply;
      if (seqnum === undefined || seqlen === undefined || seqnum === seqlen) break;
      if (seqnum !== parts.length || seqlen < seqnum || seqlen > 10_000)
        throw new HardwareError('invalid-response', `The Jade sent part ${seqnum} of ${seqlen} out of order.`, { kind: KIND });
      reply = await this.request('get_extended_data', { origid: first.id, orig: method, seqnum: seqnum + 1, seqlen }, { signal: opts.signal });
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /** `request`, also giving the id it used (for `get_extended_data`). */
  private async requestWithId(method: string, params: Record<string, unknown>, opts: CallOptions): Promise<{ id: string; reply: JadeReply }> {
    let used = '';
    const run = () => {
      used = this.newId();
      return this.send(method, params, opts, used);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    const reply = await p;
    return { id: used, reply };
  }

  /** Stops listening and closes the link. */
  async close(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    this.waiting?.reject(new HardwareError('cancelled', 'Cancelled.', { kind: KIND }));
    this.waiting = undefined;
    await this.conn.close().catch(() => undefined);
  }
}
