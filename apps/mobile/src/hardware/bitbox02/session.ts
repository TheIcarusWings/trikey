/**
 * Opening a BitBox02 session: unlock, the Noise handshake, the pairing code, then encrypted requests. From the firmware
 * (`src/rust/bitbox02-rust/src/hww.rs:71-128`, `hww/noise.rs:61-136`, `workflow/pairing.rs:9-34`) and the official client
 * (`bitbox-api-ts/src/internal/pairing.ts`):
 *
 * 1. `u` (unlock): the BitBox02 asks for its password on its own screen (Trikey never sees it) and answers `0` once
 *    unlocked, `2` if it has no wallet yet. While the owner types, the request waits (NOT_READY, hww.ts).
 * 2. `h`: start a handshake; `H` + message 1 → message 2; `H` + message 3 → `0` (the device knows this phone, or the link
 *    is Bluetooth, already paired with the six-digit code) or `1` (the device wants the pairing code confirmed).
 * 3. If either side has not seen the other before, the pairing code: the first 20 characters of the base32 handshake hash,
 *    as "ABCDE FGHIJ\nKLMNO PQRST". The phone shows it and sends `v`; the BitBox02 shows the same code and the owner
 *    confirms on it (`0`) or rejects (an error, and the session is reset). Once confirmed, each side remembers the other's
 *    static key, so the next session skips this.
 * 4. `n` + ciphertext: every request after that, encrypted both ways (Noise transport messages).
 *
 * What the phone remembers (`BitBoxPairingStore`): its own static key, and the static keys of the BitBox02s it paired with.
 */
import { HardwareError } from '../errors';
import type { BitBoxHww } from './hww';
import { NoiseXX, newNoiseKey, type CipherState } from './noise';
import { ErrorCode, parseResponse, type Response } from './proto';

const KIND = 'bitbox02' as const;

const OP_UNLOCK = 0x75; // 'u'
const OP_HANDSHAKE_START = 0x68; // 'h'
const OP_HANDSHAKE = 0x48; // 'H'
const OP_PAIRING_VERIFY = 0x76; // 'v'
const OP_NOISE = 0x6e; // 'n'
const STATUS_SUCCESS = 0;
const STATUS_UNINITIALIZED = 2;
const DEVICE_WANTS_PAIRING = 1;

/** The phone's side of the pairing: its Noise key and the BitBox02s it has paired with. */
export interface BitBoxPairingData {
  appStaticKey?: Uint8Array;
  devices: Uint8Array[];
}

export interface BitBoxPairingStore {
  load(): Promise<BitBoxPairingData>;
  save(data: BitBoxPairingData): Promise<void>;
}

/** In memory: forgotten when the app restarts (tests, and where the app passes no store). */
export function memoryPairingStore(): BitBoxPairingStore {
  let data: BitBoxPairingData = { devices: [] };
  return {
    load: async () => ({ ...(data.appStaticKey ? { appStaticKey: data.appStaticKey.slice() } : {}), devices: data.devices.map((d) => d.slice()) }),
    save: async (d) => {
      data = { ...(d.appStaticKey ? { appStaticKey: d.appStaticKey.slice() } : {}), devices: d.devices.map((x) => x.slice()) };
    },
  };
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** The pairing data as a string for a key-value store, and back (anything unreadable reads as nothing remembered). */
export function serializePairing(d: BitBoxPairingData): string {
  return JSON.stringify({ v: 1, key: d.appStaticKey ? hexOf(d.appStaticKey) : null, devices: d.devices.map(hexOf) });
}

export function deserializePairing(s: string | null): BitBoxPairingData {
  try {
    const o = JSON.parse(s ?? 'null') as { v?: unknown; key?: unknown; devices?: unknown };
    if (o?.v !== 1 || !Array.isArray(o.devices)) return { devices: [] };
    const ok = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
    return { ...(ok(o.key) ? { appStaticKey: bytesOf(o.key) } : {}), devices: o.devices.filter(ok).map(bytesOf) };
  } catch {
    return { devices: [] };
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The pairing code the BitBox02 shows for a handshake hash (`workflow/pairing.rs` `format_hash`). */
export function pairingCode(hash: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of hash) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  return `${out.slice(0, 5)} ${out.slice(5, 10)}\n${out.slice(10, 15)} ${out.slice(15, 20)}`;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface SessionHooks {
  /** The BitBox02 is waiting for its password (shown while `u` waits). */
  onUnlock?: () => void;
  /** Show this code; the BitBox02 shows the same and the owner confirms on it. Called before `v` is sent. */
  onPairingCode?: (code: string) => void;
  signal?: AbortSignal;
}

/** An open, encrypted session: one request at a time. */
export class BitBoxSession {
  constructor(
    private readonly hww: BitBoxHww,
    private readonly send: CipherState,
    private readonly recv: CipherState,
    /** The BitBox02's Noise static key, which identifies it to this phone. */
    readonly deviceStatic: Uint8Array,
  ) {}

  /** One protobuf request, one response. A firmware error becomes a `HardwareError` (104: rejected on the device). */
  async query(request: Uint8Array, signal?: AbortSignal): Promise<Response> {
    const ct = this.send.encrypt(new Uint8Array(0), request);
    const framed = new Uint8Array(ct.length + 1);
    framed[0] = OP_NOISE;
    framed.set(ct, 1);
    const r = await this.hww.request(framed, signal);
    if (r.length < 1 || r[0] !== STATUS_SUCCESS) throw new HardwareError('device-error', 'The BitBox02 could not read Trikey’s request (its encrypted channel was reset). Unplug it, plug it in again, and try again.', { kind: KIND });
    const response = parseResponse(this.recv.decrypt(new Uint8Array(0), r.slice(1)));
    if (response.type === 'error') {
      if (response.code === ErrorCode.USER_ABORT) throw new HardwareError('user-rejected', 'You rejected it on the BitBox02.', { kind: KIND });
      throw new HardwareError('device-error', `The BitBox02 refused the request: ${response.message || 'error'} (${response.code}).`, { kind: KIND, detail: response });
    }
    return response;
  }

  close(): Promise<void> {
    return this.hww.close();
  }
}

/** Unlocks the BitBox02, runs the handshake, asks for the pairing code if needed, and returns the encrypted session. */
export async function openSession(hww: BitBoxHww, store: BitBoxPairingStore, hooks: SessionHooks = {}): Promise<BitBoxSession> {
  const { signal } = hooks;
  hooks.onUnlock?.();
  const unlocked = await hww.request(new Uint8Array([OP_UNLOCK]), signal);
  if (unlocked[0] === STATUS_UNINITIALIZED)
    throw new HardwareError('not-supported', 'This BitBox02 has no wallet yet. Set it up with the BitBoxApp first (create or restore its wallet and back it up), then connect it again.', { kind: KIND });
  if (unlocked.length < 1 || unlocked[0] !== STATUS_SUCCESS) throw new HardwareError('device-locked', 'The BitBox02 stayed locked.', { kind: KIND });

  let data = await store.load();
  if (!data.appStaticKey) {
    data = { ...data, appStaticKey: newNoiseKey() };
    await store.save(data);
  }
  const start = await hww.request(new Uint8Array([OP_HANDSHAKE_START]), signal);
  if (start.length !== 1 || start[0] !== STATUS_SUCCESS) throw new HardwareError('device-error', 'The BitBox02 did not start the encrypted channel.', { kind: KIND });
  const xx = new NoiseXX(true, data.appStaticKey!);
  const step = async (message: Uint8Array) => {
    const framed = new Uint8Array(message.length + 1);
    framed[0] = OP_HANDSHAKE;
    framed.set(message, 1);
    const r = await hww.request(framed, signal);
    if (r.length < 1 || r[0] !== STATUS_SUCCESS) throw new HardwareError('device-error', 'The BitBox02 refused the encrypted channel.', { kind: KIND });
    return r.slice(1);
  };
  xx.readMessage(await step(xx.writeMessage()));
  const done = await step(xx.writeMessage());
  const noise = xx.finish();

  const known = data.devices.some((d) => same(d, noise.remoteStatic));
  const deviceWants = done.length === 1 && done[0] === DEVICE_WANTS_PAIRING;
  if (!known || deviceWants) {
    hooks.onPairingCode?.(pairingCode(noise.hash));
    const ok = await hww.request(new Uint8Array([OP_PAIRING_VERIFY]), signal);
    if (ok.length !== 1 || ok[0] !== STATUS_SUCCESS)
      throw new HardwareError('user-rejected', 'The pairing was rejected on the BitBox02. If the codes were different, something between this phone and the BitBox02 changed the connection: do not go on.', { kind: KIND });
    if (!known) await store.save({ ...data, devices: [...data.devices, noise.remoteStatic] });
  }
  return new BitBoxSession(hww, noise.send, noise.recv, noise.remoteStatic);
}
