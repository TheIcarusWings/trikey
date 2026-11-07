/**
 * Unlocking a Jade over Bluetooth: the PIN-server relay.
 *
 * A Jade keeps its keys encrypted under a key it rebuilds from the PIN *and* a secret held by a blind PIN server ("blind
 * oracle", github.com/Blockstream/blind_pin_server). Over USB or Bluetooth the Jade cannot reach the server itself, so
 * the host relays (firmware `main/process/auth_user.c`, `main/process/pinclient.c`; docs/index.rst "auth_user"):
 *
 * 1. The phone sends `auth_user { network, epoch }`. An unlocked Jade answers `true` at once.
 * 2. Otherwise the owner types the PIN on the Jade, and the Jade answers with
 *    `{ http_request: { params: { urls, method: "POST", accept: "json", data: { data: <base64> }, root_certificates? },
 *    "on-reply": "pin" } }` (`send_http_request_reply`, `client_data_request_reply` in `process_utils.c`). `urls` are the
 *    PIN server's `get_pin` (or `set_pin`) address and its onion address: Blockstream's by default (`PINSERVER_URL`
 *    "https://j8d.io" and an onion), or the owner's own server set on the Jade.
 * 3. The phone POSTs `data` as JSON to one of the URLs and sends the JSON reply back as `pin { data }` (`handle_pin`).
 *    The payload is encrypted and signed between the Jade and the server (ECDH with the server's key built into the
 *    Jade, `pinclient.c` `generate_ske`, `encrypt_payload`, `decrypt_reply`): the phone only carries it.
 * 4. The Jade answers `true` (unlocked), `false` (wrong PIN), or another `http_request` (a PIN change asks `set_pin`).
 *
 * The phone reaches only a PIN server it knows: Blockstream's (`j8d.io`, and `jadepin.blockstream.com`, its older name),
 * or one the owner named as their own when their Jade first asked for it (the owner set it on the Jade; the phone asks
 * once and remembers it). A Bluetooth device that only claims to be a Jade could otherwise make the phone fetch any
 * address from where it stands (a router page, a service on the home network or VPN) and hand back the answer. So: only
 * `https://` to a named host (no IP address, no `localhost`, no user name in the URL, no query), a path ending in
 * `/get_pin` or `/set_pin`, a JSON POST, no redirect (a redirected answer is dropped, never passed to the Jade), and an
 * answer of at most 4 KiB. It never sends the PIN-server traffic in plain `http://`, and it cannot reach an onion address
 * (the app has no Tor). When no URL is usable, or the request fails, it sends `pin` with no data: the Jade then shows
 * "Failed communicating with Oracle - retry?" (`handle_pin`: `PIN_CAN_RETRY`) and the owner chooses there.
 *
 * What the PIN server learns (blind_pin_server `pindb.py`): the Jade's own PIN-server key (a per-device public key, so it
 * can tell this Jade's unlocks apart), when it unlocks, how many wrong PINs in a row, and the phone's IP address. Not the
 * PIN (only an HMAC of it under the Jade's key), not the seed, not any address or wallet.
 */
import type { HardwareKind } from '@trikey/wallet';
import { HardwareError } from '../errors';
import type { CborValue } from './cbor';
import { JadeRpcError, type JadeRpc } from './rpc';

const KIND: HardwareKind = 'jade-ble';

/** The request the Jade asks the phone to make, as it sends it. */
export interface JadeHttpRequest {
  urls: string[];
  method: 'GET' | 'POST';
  /** "json": the body is the JSON of `data`, the answer JSON. */
  accept?: string;
  data?: CborValue;
  /** The owner's own server's certificate, when they set one on the Jade. */
  rootCertificates?: string[];
  /** The method to send the answer to: "pin". */
  onReply: string;
}

/** What the relay may call on the Jade with the server's answer. Anything else the Jade asks for is refused. */
const REPLY_METHODS = new Set(['pin']);

function isMap(v: unknown): v is Record<string, CborValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** The `http_request` in an `auth_user` (or `pin`) result, or undefined when the result is something else. */
export function parseHttpRequest(result: CborValue): JadeHttpRequest | undefined {
  if (!isMap(result) || !isMap(result.http_request)) return undefined;
  const req = result.http_request;
  const params = isMap(req.params) ? req.params : undefined;
  const onReply = req['on-reply'];
  if (!params || typeof onReply !== 'string') throw new HardwareError('invalid-response', 'The Jade asked for a PIN-server request Trikey cannot read.', { kind: KIND });
  const urls = Array.isArray(params.urls) ? params.urls.filter((u): u is string => typeof u === 'string') : [];
  const method = params.method === 'GET' ? 'GET' : params.method === 'POST' || params.method === undefined ? 'POST' : undefined;
  if (!method) throw new HardwareError('invalid-response', `The Jade asked for an HTTP ${String(params.method)} request, which Trikey does not make.`, { kind: KIND });
  const roots = Array.isArray(params.root_certificates) ? params.root_certificates.filter((c): c is string => typeof c === 'string') : undefined;
  return {
    urls,
    method,
    ...(typeof params.accept === 'string' ? { accept: params.accept } : {}),
    ...(params.data !== undefined ? { data: params.data } : {}),
    ...(roots?.length ? { rootCertificates: roots } : {}),
    onReply,
  };
}

/** The host of a URL ("j8d.io"), or the URL itself when it is not one. For the screens and the log. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : url;
}

/** Blockstream's PIN server (pinclient.c `PINSERVER_URL`), under its current and its older name. */
export const BLOCKSTREAM_PIN_SERVERS: readonly string[] = ['j8d.io', 'jadepin.blockstream.com'];

/**
 * A PIN-server URL in the one shape Trikey reaches: `https://host[:port]/…/get_pin` (or `set_pin`), host a DNS name.
 * Its `server` is `host`, or `host:port` for a port other than 443: what the owner approves and the phone remembers.
 */
export function parsePinServerUrl(url: string): { server: string; host: string } | undefined {
  const m = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(\/[A-Za-z0-9._~\/-]*)$/i.exec(url);
  if (!m) return undefined;
  const host = m[1]!.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  // A name with a dot, made of real labels; not an IP address, not a local name, not an onion.
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return undefined;
  if (/\.(onion|local|localhost|internal|lan|home\.arpa)$/.test(host)) return undefined;
  const port = m[2] === undefined ? 443 : Number(m[2]);
  if (port < 1 || port > 65535) return undefined;
  if (!/\/(get_pin|set_pin)$/.test(m[3]!) || m[3]!.split('/').some((seg) => seg === '..' || seg === '.')) return undefined;
  return { server: port === 443 ? host : `${host}:${port}`, host };
}

/**
 * The URL to use: the first `https://` one that is not an onion address, to a server in `allowed` (default: Blockstream's).
 * Otherwise the reason in words; `unknownServer` when the first usable URL is to another server, which the owner may
 * approve as their own.
 */
export function pickPinServerUrl(urls: readonly string[], allowed: readonly string[] = BLOCKSTREAM_PIN_SERVERS): { url: string } | { problem: string; unknownServer?: string } {
  let unknown: string | undefined;
  for (const u of urls) {
    if (!/^https:\/\//i.test(u)) continue;
    if (hostOf(u).endsWith('.onion')) continue;
    const parsed = parsePinServerUrl(u);
    if (!parsed) continue;
    if (allowed.includes(parsed.server)) return { url: u };
    unknown ??= parsed.server;
  }
  if (unknown)
    return {
      problem: `Your Jade asked this phone to reach ${unknown}, which is not Blockstream’s PIN server or one you named as your own. Trikey did not contact it.`,
      unknownServer: unknown,
    };
  const https = urls.filter((u) => /^https:\/\//i.test(u) && !hostOf(u).endsWith('.onion'));
  if (https.length) return { problem: `Your Jade gave a PIN-server address Trikey does not reach (${hostOf(https[0]!)}): it must be a named https server, not an IP address or a local name.` };
  if (urls.some((u) => hostOf(u).endsWith('.onion')) && !urls.some((u) => /^https?:\/\//i.test(u) && !hostOf(u).endsWith('.onion')))
    return { problem: 'Your Jade’s PIN server is only an onion address, and Trikey has no Tor. Set an https address for it on the Jade, or use the Jade in QR mode.' };
  if (urls.some((u) => /^http:\/\//i.test(u)))
    return { problem: `Your Jade’s PIN server (${hostOf(urls.find((u) => /^http:\/\//i.test(u))!)}) is a plain http address. Trikey only reaches a PIN server over https. Set an https address on the Jade, or use the Jade in QR mode.` };
  return { problem: 'Your Jade gave no PIN-server address Trikey can use.' };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'error' }) => Promise<{
  ok: boolean;
  status: number;
  /** Set by a fetch that followed a redirect (React Native's follows them natively, whatever `redirect` says). */
  redirected?: boolean;
  /** The address the answer came from, after any redirect. */
  url?: string;
  text(): Promise<string>;
}>;

export interface RelayOptions {
  fetch: FetchLike;
  /** The PIN servers the phone may reach (`host` or `host:port`). Default: Blockstream's. */
  allowedServers?: readonly string[];
  /** Per request. Default 20 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Longest PIN-server answer passed on (the real one is about 100 bytes of JSON). */
const MAX_ANSWER = 4 * 1024;

/**
 * Makes the request the Jade asked for. Resolves with the server's JSON answer, or with `{ problem }` in words when it
 * could not: then the phone sends the Jade an empty `pin`.
 */
export async function relayHttpRequest(req: JadeHttpRequest, opts: RelayOptions): Promise<{ body: CborValue; url: string } | { problem: string }> {
  const picked = pickPinServerUrl(req.urls, opts.allowedServers);
  if ('problem' in picked) return { problem: picked.problem };
  const json = req.accept === 'json' || req.accept === 'application/json';
  // The PIN exchange is a JSON POST (pinclient.c): nothing else is relayed.
  if (req.method !== 'POST' || !json) return { problem: 'The Jade asked for a request Trikey does not make (only the PIN server’s JSON POST is relayed).' };
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  const host = hostOf(picked.url);
  try {
    const body = JSON.stringify(toJson(req.data ?? null));
    // A fetch that does not honour its signal still stops waiting on a timeout or a cancel.
    const stopped = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const res = await Promise.race([
      opts.fetch(picked.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: ac.signal,
        // Never follow a redirect (to plain http, or anywhere else).
        redirect: 'error',
      }),
      stopped,
    ]);
    if (res.redirected === true || (typeof res.url === 'string' && res.url !== '' && res.url !== picked.url))
      return { problem: `The PIN server (${host}) sent this phone somewhere else, which Trikey does not follow.` };
    if (!res.ok) return { problem: `The PIN server (${host}) answered with an error (HTTP ${res.status}).` };
    const text = await Promise.race([res.text(), stopped]);
    if (text.length > MAX_ANSWER) return { problem: `The PIN server (${host}) sent an answer far too long to be one.` };
    try {
      return { body: fromJson(JSON.parse(text)), url: picked.url };
    } catch {
      return { problem: `The PIN server (${host}) sent an answer that is not JSON.` };
    }
  } catch {
    if (opts.signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
    return { problem: `This phone could not reach the PIN server (${host}). Check the internet connection.` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** CBOR from the Jade as JSON: byte strings become hex (jadepy `_hexlify`); the PIN-server payload is text anyway. */
function toJson(v: CborValue): unknown {
  if (v instanceof Uint8Array) return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
  if (Array.isArray(v)) return v.map(toJson);
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}

/** JSON from the server as CBOR for the Jade: strings, whole numbers, booleans, null, arrays and objects. */
function fromJson(v: unknown, depth = 0): CborValue {
  if (depth > 16) throw new Error('too deep');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('not a whole number');
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => fromJson(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fromJson(x, depth + 1)]));
  throw new Error('not JSON data');
}

/** What the unlock tells the screen while it runs. */
export type UnlockEvent =
  /** The Jade waits for its PIN (the owner types it on the Jade). */
  | { type: 'enter-pin' }
  /** The phone is relaying to this PIN server. */
  | { type: 'pin-server'; host: string }
  /** The relay failed; the Jade now asks whether to retry. */
  | { type: 'pin-server-failed'; problem: string };

/** The PIN servers the owner named as their own, and how to ask them about a new one. */
export interface PinServerApproval {
  /** Servers approved before (`host` or `host:port`). */
  approved(): Promise<readonly string[]>;
  /** Asks the owner whether `server` is their own PIN server, and remembers a yes. */
  ask(server: string): Promise<boolean>;
}

export interface UnlockOptions extends Omit<RelayOptions, 'allowedServers'> {
  /** Without it, only Blockstream's PIN server is reached. */
  pinServers?: PinServerApproval;
  /** `mainnet`, `testnet` or `localtest` (Jade's names). */
  network: string;
  /** Seconds since 1970, to set the Jade's clock (auth_user `epoch`). Default now. */
  epoch?: number;
  onEvent?: (e: UnlockEvent) => void;
}

/** How many PIN-server round trips one unlock may take (an unlock, then a PIN change with its `set_pin`, plus retries). */
const MAX_ROUNDS = 8;

/**
 * Unlocks the Jade for this connection (auth_user with the PIN-server relay). Resolves true once unlocked; false when the
 * PIN was wrong (the Jade counts it; three wrong PINs in a row wipe it). Rejects with the Jade's error otherwise, worded
 * with the last relay problem when there was one.
 */
export async function unlockJade(rpc: JadeRpc, opts: UnlockOptions): Promise<boolean> {
  const epoch = opts.epoch ?? Math.floor(Date.now() / 1000);
  opts.onEvent?.({ type: 'enter-pin' });
  let lastProblem: string | undefined;
  let result: CborValue;
  try {
    result = await rpc.call('auth_user', { network: opts.network, epoch }, { timeoutMs: null, signal: opts.signal });
    for (let round = 0; ; round++) {
      if (result === true) return true;
      if (result === false) return false;
      const req = parseHttpRequest(result);
      if (!req) throw new HardwareError('invalid-response', 'The Jade answered the unlock with something Trikey cannot read.', { kind: KIND });
      if (!REPLY_METHODS.has(req.onReply)) throw new HardwareError('invalid-response', `The Jade asked Trikey to call "${req.onReply}" with the PIN server's answer, which it does not do.`, { kind: KIND });
      if (round >= MAX_ROUNDS) throw new HardwareError('device-error', 'The Jade kept asking for the PIN server. Restart it and try again.', { kind: KIND });
      const allowed = [...BLOCKSTREAM_PIN_SERVERS, ...((await opts.pinServers?.approved().catch(() => [])) ?? [])];
      let picked = pickPinServerUrl(req.urls, allowed);
      // A server Trikey does not know: only the owner can say it is theirs (set on the Jade). A no stops here.
      if ('unknownServer' in picked && picked.unknownServer && opts.pinServers) {
        if (!(await opts.pinServers.ask(picked.unknownServer))) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
        allowed.push(picked.unknownServer);
        picked = pickPinServerUrl(req.urls, allowed);
      }
      if ('url' in picked) opts.onEvent?.({ type: 'pin-server', host: hostOf(picked.url) });
      const answer = await relayHttpRequest(req, { ...opts, allowedServers: allowed });
      if ('problem' in answer) {
        lastProblem = answer.problem;
        opts.onEvent?.({ type: 'pin-server-failed', problem: answer.problem });
        // No params: the Jade offers to retry (pinclient.c handle_pin, PIN_CAN_RETRY).
        result = await rpc.call(req.onReply, undefined, { timeoutMs: null, signal: opts.signal });
      } else {
        lastProblem = undefined;
        result = await rpc.call(req.onReply, isMap(answer.body) ? answer.body : { data: answer.body }, { timeoutMs: null, signal: opts.signal });
      }
    }
  } catch (e) {
    // The owner chose not to retry on the Jade after the relay failed: say why it failed.
    if (e instanceof JadeRpcError && lastProblem) throw new HardwareError('unavailable', `${lastProblem} The Jade stayed locked.`, { kind: KIND, detail: e });
    throw e;
  }
}
