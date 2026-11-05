/**
 * BIP 329 ("Wallet Labels Export Format"): the labels file other wallets read and write (Sparrow, Nunchuk, Bitcoin
 * Safe, ...). JSON Lines, UTF-8, one record per line: `type`, `ref`, and optional `label`, `origin`, `spendable`, plus
 * the BIP's optional "Additional Fields" (`height`, `time`, `fee`, `value`, `rate`, `keypath`, `fmv`, `heights`).
 *
 * How Trikey maps onto it (DESIGN.md, "Next: coin control"):
 * - a coin's label: an `output` record, ref `txid:vout`;
 * - a frozen coin: that `output` record with `spendable: false` (unfrozen: `true`, or no `spendable` at all);
 * - a payment's label (the send log's, or one set on a received payment): a `tx` record, ref the txid;
 * - `origin`: the wallet's descriptor without its keys, child paths or checksum (`bip329Origin`), so a file holding
 *   several wallets (Spending, Savings, own wallets) puts each label back on the right one.
 *
 * Everything else (`addr`, `pubkey`, `input`, `xpub`, `spscan`, and types this BIP does not define) is validated as far
 * as its type is known and kept as read, so an export from Trikey gives back what another wallet put in.
 *
 * Strict, line by line: a line that breaks the format is reported (`errors`, with its line number) and skipped; the
 * rest of the file still counts, as JSON Lines intends. A file that cannot be read at all (too large, not UTF-8, too
 * many records) throws `labels_invalid`. Labels are cut to `MAX_LABEL_CHARS` (the BIP's suggested 255) and counted in
 * `truncated`, so the app can say so.
 *
 * Pure: no storage, no network. `labels-store.ts` keeps the records; `coins.ts` shows them.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { NETWORKS, parseSortedMultiDescriptor } from '@trikey/core';
import { WalletError } from './errors.js';

/** The record types BIP 329 defines. Any other type is kept as read. */
export const BIP329_TYPES = ['tx', 'addr', 'pubkey', 'input', 'output', 'xpub', 'spscan'] as const;
export type Bip329Type = (typeof BIP329_TYPES)[number];

/** Largest file read (bytes). A wallet's labels are a few hundred kB at most; this leaves room without risking the phone. */
export const MAX_BIP329_BYTES = 8 * 1024 * 1024;
/** Largest line (bytes, UTF-8): a record with every additional field is well under 1 kB. */
export const MAX_BIP329_LINE_BYTES = 16 * 1024;
/** Most records read from one file. */
export const MAX_BIP329_RECORDS = 100_000;
/** Labels are cut to this many characters (code points): the BIP's suggested maximum. */
export const MAX_LABEL_CHARS = 255;
/** Longest `origin` kept: a 3-of-3 origin is about 120 characters. */
export const MAX_ORIGIN_CHARS = 1024;
/** Longest `ref` of a type this BIP does not define. */
export const MAX_UNKNOWN_REF_CHARS = 1024;
/** Most lines reported in `errors` (the rest are only counted in `errorCount`). */
export const MAX_REPORTED_ERRORS = 100;

/** One BIP 329 record. `type` is one of `BIP329_TYPES`, or another wallet's own type (kept as read). */
export interface Bip329Record {
  type: string;
  ref: string;
  label?: string;
  origin?: string;
  /** `output` records only: false is a frozen coin. */
  spendable?: boolean;
  /** The BIP's additional fields and any other field the record carried, in the order read: written back after the others. */
  extra?: Record<string, unknown>;
}

export interface Bip329LineError {
  /** 1-based line number in the file. */
  line: number;
  message: string;
}

export interface Bip329Parse {
  records: Bip329Record[];
  /** The first `MAX_REPORTED_ERRORS` lines that were skipped, and why. */
  errors: Bip329LineError[];
  /** Every line skipped. */
  errorCount: number;
  /** Labels cut to `MAX_LABEL_CHARS`. */
  truncated: number;
}

const CORE_KEYS = new Set(['type', 'ref', 'label', 'origin', 'spendable']);
/** Keys that must never be copied into an object (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HEX64 = /^[0-9a-fA-F]{64}$/;
const OUTPOINT = /^([0-9a-fA-F]{64}):(0|[1-9][0-9]{0,9})$/;
const TYPE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const SP_SCAN = /^t?spscan1[02-9ac-hj-np-z]{8,1000}$/;

const b58check = createBase58check(sha256);

class LineError extends Error {}

/** `txid:vout`, as BIP 329 writes an output (and Trikey keys a coin). */
export function outpointRef(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/** The txid (lowercase) and index of a `txid:vout` reference, or undefined when it is not one. */
export function parseOutpoint(ref: string): { txid: string; vout: number } | undefined {
  const m = OUTPOINT.exec(ref);
  if (!m) return undefined;
  const vout = Number(m[2]);
  return vout <= 0xffffffff ? { txid: m[1]!.toLowerCase(), vout } : undefined;
}

/**
 * The BIP 329 `origin` of a Trikey wallet: its `wsh(sortedmulti(2, ...))` descriptor with every key reduced to its key
 * origin (`[fingerprint/48'/0'/0'/2']`), no xpub, no `/<0;1>/*`, no checksum. Hardened steps are written `'`, as in the
 * BIP's examples.
 */
export function bip329Origin(descriptor: string): string {
  const keys = parseSortedMultiDescriptor(descriptor);
  const origin = (k: (typeof keys)[number]) => `[${k.fingerprint}${k.originPath ? `/${k.originPath.replace(/h/g, "'")}` : ''}]`;
  return `wsh(sortedmulti(2,${keys.map(origin).join(',')}))`;
}

/**
 * The comparable form of an `origin`: no white space, hardened steps as `'`, fingerprints lowercase, and the keys of a
 * `sortedmulti` in sorted order (their order does not change the wallet).
 */
export function normalizeOrigin(origin: string): string {
  const flat = origin.replace(/\s+/g, '').replace(/\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\]/g, (_, fp: string, path: string) => `[${fp.toLowerCase()}${path.replace(/[hH]/g, "'")}]`);
  return flat.replace(/sortedmulti\((\d+),([^()]*)\)/g, (_, k: string, list: string) => `sortedmulti(${k},${list.split(',').sort().join(',')})`);
}

/** Do two `origin`s name the same wallet? */
export function sameOrigin(a: string, b: string): boolean {
  return normalizeOrigin(a) === normalizeOrigin(b);
}

function isAddress(ref: string): boolean {
  for (const n of [NETWORKS.bitcoin, NETWORKS.testnet, NETWORKS.regtest]) {
    try {
      btc.Address(n.btc).decode(ref);
      return true;
    } catch {
      // try the next network
    }
  }
  return false;
}

/** A public extended key: base58check, 78 bytes, key data a compressed public key (an xprv's starts with 0x00). */
function isXpub(ref: string): boolean {
  let raw: Uint8Array;
  try {
    raw = b58check.decode(ref);
  } catch {
    return false;
  }
  return raw.length === 78 && (raw[45] === 0x02 || raw[45] === 0x03);
}

function isPubkey(ref: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(ref)) return false;
  const p = ref.slice(0, 2);
  if (ref.length === 64) return true; // x-only
  if (ref.length === 66) return p === '02' || p === '03';
  if (ref.length === 130) return p === '04';
  return false;
}

/** Validates and normalizes `ref` for a known type (lowercase hex where the BIP uses hex). */
function checkRef(type: string, ref: string): string {
  switch (type) {
    case 'tx':
      if (!HEX64.test(ref)) throw new LineError('a tx ref must be a 64-character hex txid');
      return ref.toLowerCase();
    case 'input':
    case 'output': {
      const o = parseOutpoint(ref);
      if (!o) throw new LineError(`an ${type} ref must be txid:index`);
      return outpointRef(o.txid, o.vout);
    }
    case 'addr':
      if (ref.length > 90 || !isAddress(ref)) throw new LineError('an addr ref must be a bitcoin address');
      return ref;
    case 'pubkey':
      if (!isPubkey(ref)) throw new LineError('a pubkey ref must be a 32, 33 or 65 byte public key in hex');
      return ref.toLowerCase();
    case 'xpub':
      if (ref.length > 120 || !isXpub(ref)) throw new LineError('an xpub ref must be an extended public key (never a private one)');
      return ref;
    case 'spscan':
      if (!SP_SCAN.test(ref.toLowerCase())) throw new LineError('an spscan ref must be a silent payments scan key expression');
      return ref;
    default:
      if (!ref.length || ref.length > MAX_UNKNOWN_REF_CHARS) throw new LineError(`a ref must be 1 to ${MAX_UNKNOWN_REF_CHARS} characters`);
      return ref;
  }
}

const isNonNegInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isAmountMap = (v: unknown) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).length <= 32 && Object.entries(v).every(([k, x]) => k.length <= 16 && typeof x === 'number' && Number.isFinite(x));

/** The BIP's additional fields: when present, they must have the BIP's type. */
function checkAdditional(key: string, v: unknown): void {
  const bad = (what: string) => {
    throw new LineError(`${key} must be ${what}`);
  };
  switch (key) {
    case 'height':
    case 'fee':
      if (!isNonNegInt(v)) bad('a non-negative integer');
      return;
    case 'value':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) bad('an integer (sats)');
      return;
    case 'time':
      if (typeof v !== 'string' || !ISO_8601.test(v)) bad('an ISO-8601 timestamp');
      return;
    case 'rate':
    case 'fmv':
      if (!isAmountMap(v)) bad('a map of currency codes to numbers');
      return;
    case 'keypath':
      if (typeof v !== 'string' || !v.length || v.length > MAX_ORIGIN_CHARS) bad('a key path or descriptor');
      return;
    case 'heights':
      if (!Array.isArray(v) || v.length > 10_000 || !v.every(isNonNegInt)) bad('a list of block heights');
      return;
  }
}

/** Cuts `s` to `max` code points (never in the middle of a surrogate pair). */
function cut(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  const cps = Array.from(s);
  return cps.length <= max ? { text: s, cut: false } : { text: cps.slice(0, max).join(''), cut: true };
}

/** One parsed JSON value as a record; throws `LineError`. `truncated` reports a label cut to `MAX_LABEL_CHARS`. */
function toRecord(o: unknown): { record: Bip329Record; truncated: boolean } {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new LineError('not a JSON object');
  const obj = o as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (UNSAFE_KEYS.has(k)) throw new LineError(`field ${k} is not allowed`);
  const { type, ref, label, origin, spendable } = obj;
  if (typeof type !== 'string' || !TYPE_NAME.test(type)) throw new LineError('type must be a short lowercase name (tx, addr, pubkey, input, output, xpub, spscan)');
  if (typeof ref !== 'string') throw new LineError('ref must be a string');
  const known = (BIP329_TYPES as readonly string[]).includes(type);
  const record: Bip329Record = { type, ref: checkRef(type, ref) };
  let truncated = false;
  if (label !== undefined) {
    if (typeof label !== 'string') throw new LineError('label must be a string');
    const c = cut(label, MAX_LABEL_CHARS);
    record.label = c.text;
    truncated = c.cut;
  }
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !origin.length || origin.length > MAX_ORIGIN_CHARS) throw new LineError('origin must be a descriptor of key origins');
    if (!/^[a-z][a-z0-9_]*\(.*\)$/.test(origin) || origin.includes('#')) throw new LineError('origin must be an abbreviated descriptor: key origins only, without a checksum');
    record.origin = origin;
  }
  if (spendable !== undefined) {
    // The BIP warns about "false" with quotes: a string is not a boolean, so it is refused rather than guessed.
    if (typeof spendable !== 'boolean') throw new LineError('spendable must be true or false (a JSON boolean, not a string)');
    if (known && type !== 'output') throw new LineError('spendable belongs to output records only');
    record.spendable = spendable;
  }
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const [k, v] of Object.entries(obj)) {
    if (CORE_KEYS.has(k)) continue;
    checkAdditional(k, v);
    extra[k] = v;
    hasExtra = true;
  }
  if (hasExtra) record.extra = extra;
  return { record, truncated };
}

/** Throws `labels_invalid` unless `input` is UTF-8 text within `MAX_BIP329_BYTES`. */
function asText(input: string | Uint8Array): string {
  if (typeof input === 'string') {
    // UTF-8 is at most 3 bytes per UTF-16 unit: only long strings need the exact count.
    if (input.length * 3 > MAX_BIP329_BYTES && new TextEncoder().encode(input).length > MAX_BIP329_BYTES) throw tooLarge();
    return input;
  }
  if (input.length > MAX_BIP329_BYTES) throw tooLarge();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (e) {
    throw new WalletError('labels_invalid', 'This labels file is not UTF-8 text.', { cause: e });
  }
}

const tooLarge = () => new WalletError('labels_invalid', `This labels file is larger than ${MAX_BIP329_BYTES / (1024 * 1024)} MB.`);

/**
 * Reads a BIP 329 file. Blank lines, a leading byte order mark and `\r\n` line ends are accepted; every other line must
 * be one valid record, or it is skipped and reported. Throws `labels_invalid` for a file too large, not UTF-8, or with
 * more than `MAX_BIP329_RECORDS` records.
 */
export function parseBip329(input: string | Uint8Array): Bip329Parse {
  const text = asText(input).replace(/^﻿/, '');
  const records: Bip329Record[] = [];
  const errors: Bip329LineError[] = [];
  let errorCount = 0;
  let truncated = 0;
  const lines = text.split('\n');
  const enc = new TextEncoder();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!;
    if (!line.trim()) continue;
    try {
      if (line.length * 3 > MAX_BIP329_LINE_BYTES && enc.encode(line).length > MAX_BIP329_LINE_BYTES) throw new LineError(`longer than ${MAX_BIP329_LINE_BYTES} bytes`);
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new LineError('not valid JSON');
      }
      const r = toRecord(json);
      if (records.length >= MAX_BIP329_RECORDS) throw new WalletError('labels_invalid', `This labels file has more than ${MAX_BIP329_RECORDS} records.`);
      records.push(r.record);
      if (r.truncated) truncated++;
    } catch (e) {
      if (!(e instanceof LineError)) throw e;
      errorCount++;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ line: i + 1, message: e.message });
    }
  }
  return { records, errors, errorCount, truncated };
}

/**
 * Checks a record before it is written: the same rules as reading, so Trikey never writes a line it would refuse (and a
 * label longer than `MAX_LABEL_CHARS` is an error here, not cut). Returns it normalized; throws `labels_invalid`.
 */
export function checkBip329Record(r: Bip329Record): Bip329Record {
  try {
    const { record, truncated } = toRecord(toJson(r));
    if (truncated) throw new LineError(`label longer than ${MAX_LABEL_CHARS} characters`);
    return record;
  } catch (e) {
    if (e instanceof LineError) throw new WalletError('labels_invalid', `Invalid ${r.type} record ${r.ref}: ${e.message}.`);
    throw e;
  }
}

/** The JSON object of a record: `type`, `ref`, `label`, `origin`, `spendable`, then its other fields in their order. */
function toJson(r: Bip329Record): Record<string, unknown> {
  const o: Record<string, unknown> = { type: r.type, ref: r.ref };
  if (r.label !== undefined) o['label'] = r.label;
  if (r.origin !== undefined) o['origin'] = r.origin;
  if (r.spendable !== undefined) o['spendable'] = r.spendable;
  for (const [k, v] of Object.entries(r.extra ?? {})) if (!CORE_KEYS.has(k) && !UNSAFE_KEYS.has(k)) o[k] = v;
  return o;
}

/** Writes records as a BIP 329 file: one JSON object per line, each line ending in `\n`. Each record is checked first. */
export function serializeBip329(records: Iterable<Bip329Record>): string {
  let out = '';
  for (const r of records) out += `${JSON.stringify(toJson(checkBip329Record(r)))}\n`;
  return out;
}
