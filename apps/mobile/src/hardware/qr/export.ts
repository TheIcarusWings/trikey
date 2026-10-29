/**
 * Reads the public keys an air-gapped device exports as QR codes, and returns the master fingerprint plus the keys with
 * their derivation paths. Formats:
 *
 * - UR `crypto-hdkey`, `crypto-account`, `crypto-multi-accounts`, `crypto-output` (Keystone, Passport, Jade, SeedSigner);
 * - Coldcard's JSON exports (multisig xpub export `p2wsh_deriv`/`p2wsh`, generic export `bip48_2`...), as plain text or BBQr `J`;
 * - descriptor text, `[fingerprint/48h/1h/0h/2h]xpub`.
 *
 * SLIP-132 keys (zpub, Zpub, vpub...) are converted to standard xpub/tpub.
 */
import '../common/buffer';
import { CryptoAccount, CryptoHDKey, CryptoMultiAccounts, CryptoOutput } from '@keystonehq/bc-ur-registry';
import { HardwareError } from '../errors';
import { HARDENED, parsePath } from '../common/path';
import { TPUB_VERSION, XPUB_VERSION, encodeXpub, normalizeXpub } from '../common/xpub';
import type { QrPayload } from './types';

export interface ExportedKey {
  /** Derivation path of the exported (account) key from the master key. */
  path: number[];
  /** Standard xpub or tpub. */
  xpub: string;
}

export interface DeviceKeyExport {
  /** Master fingerprint, 8 lowercase hex characters. */
  fingerprint: string;
  keys: ExportedKey[];
}

const bad = (message: string, detail?: unknown) => new HardwareError('invalid-response', message, { detail });

const hex8 = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function normalizeFingerprint(fp: string): string {
  const clean = fp.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{8}$/.test(clean)) throw bad(`"${fp}" is not a master key fingerprint.`);
  return clean;
}

// ----------------------------------------------------------------------------------------------- UR

/** The standard xpub or tpub of a `crypto-hdkey`, with its path and (if the key carries it) the master fingerprint. */
export function describeHdKey(hd: CryptoHDKey): { fingerprint?: string; key: ExportedKey } | undefined {
  if (hd.isMaster() || hd.isPrivateKey()) return undefined;
  const origin = hd.getOrigin();
  if (!origin) return undefined;
  const components = origin.getComponents();
  if (components.length === 0) return undefined;
  const path = components.map((c) => c.getIndex() + (c.isHardened() ? HARDENED : 0));
  const source = origin.getSourceFingerprint();
  const parent = hd.getParentFingerprint();
  // The key does not say which network it is for unless it carries use-info; the coin type in the path does too
  // (48'/1'/... is a test network).
  const coinType = path[1] !== undefined && path[1] >= HARDENED ? path[1] - HARDENED : undefined;
  const info = hd.getUseInfo();
  const testnet = coinType !== undefined ? coinType !== 0 : info?.getNetwork() === 1;
  const xpub = encodeXpub({
    version: testnet ? TPUB_VERSION : XPUB_VERSION,
    depth: path.length,
    parentFingerprint: parent && parent.length === 4 ? parent.readUInt32BE(0) : 0,
    childNumber: path[path.length - 1]!,
    chainCode: new Uint8Array(hd.getChainCode()),
    key: new Uint8Array(hd.getKey()),
  });
  return { fingerprint: source && source.length === 4 ? hex8(source) : undefined, key: { path, xpub } };
}

function exportFromHdKeys(keys: CryptoHDKey[], masterFingerprint?: Uint8Array): DeviceKeyExport {
  const found: ExportedKey[] = [];
  const fingerprints = new Set<string>();
  for (const hd of keys) {
    const k = describeHdKey(hd);
    if (!k) continue;
    if (k.fingerprint) fingerprints.add(k.fingerprint);
    found.push(k.key);
  }
  if (masterFingerprint) fingerprints.add(hex8(masterFingerprint));
  if (found.length === 0) throw bad('The QR holds no account public key with a derivation path.');
  if (fingerprints.size === 0) throw bad('The QR does not say which master key it belongs to (no master fingerprint).');
  if (fingerprints.size !== 1) throw bad('The QR holds keys of more than one device.');
  return { fingerprint: [...fingerprints][0]!, keys: found };
}

function exportFromUr(urType: string, cbor: Uint8Array): DeviceKeyExport {
  const buf = Buffer.from(cbor);
  try {
    switch (urType) {
      case 'crypto-hdkey':
        return exportFromHdKeys([CryptoHDKey.fromCBOR(buf)]);
      case 'crypto-account': {
        const account = CryptoAccount.fromCBOR(buf);
        const keys = account
          .getOutputDescriptors()
          .map((o) => o.getCryptoKey())
          .filter((k): k is CryptoHDKey => k instanceof CryptoHDKey);
        return exportFromHdKeys(keys, new Uint8Array(account.getMasterFingerprint()));
      }
      case 'crypto-multi-accounts': {
        const multi = CryptoMultiAccounts.fromCBOR(buf);
        return exportFromHdKeys(multi.getKeys(), new Uint8Array(multi.getMasterFingerprint()));
      }
      case 'crypto-output': {
        const key = CryptoOutput.fromCBOR(buf).getCryptoKey();
        if (key instanceof CryptoHDKey) return exportFromHdKeys([key]);
        break;
      }
      default:
        throw bad(`That QR is a ${urType}, not a public key export.`);
    }
  } catch (e) {
    if (e instanceof HardwareError) throw e;
    throw bad('The QR could not be read as a public key export.', e);
  }
  throw bad('The QR holds no extended public key.');
}

// ----------------------------------------------------------------------------------------------- JSON

type Json = { [k: string]: unknown };

const XPUB_LIKE = /^[xyztuvXYZTUV]pub[1-9A-HJ-NP-Za-km-z]{100,}$/;

function exportFromJson(root: Json): DeviceKeyExport {
  const keys: ExportedKey[] = [];
  const fingerprints = new Set<string>();
  const topFp = typeof root.xfp === 'string' ? root.xfp : undefined;
  if (topFp) fingerprints.add(normalizeFingerprint(topFp));

  const add = (deriv: unknown, xpub: unknown) => {
    if (typeof deriv !== 'string' || typeof xpub !== 'string' || !XPUB_LIKE.test(xpub)) return;
    let path: number[];
    try {
      path = parsePath(deriv);
    } catch {
      return;
    }
    if (path.length === 0) return;
    keys.push({ path, xpub: normalizeXpub(xpub) });
  };

  const walk = (node: unknown, depth: number) => {
    if (typeof node !== 'object' || node === null || depth > 4) return;
    const obj = node as Json;
    // { "p2wsh_deriv": "m/48'/1'/0'/2'", "p2wsh": "Vpub..." }
    for (const name of Object.keys(obj)) {
      if (name.endsWith('_deriv')) add(obj[name], obj[name.slice(0, -'_deriv'.length)]);
    }
    // { "deriv": "m/48'/1'/0'/2'", "xpub": "tpub...", "xfp": "..." }
    if (typeof obj.deriv === 'string') {
      add(obj.deriv, obj.xpub);
      if (typeof obj.xfp === 'string') fingerprints.add(normalizeFingerprint(obj.xfp));
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(root, 0);

  if (!topFp && fingerprints.size === 0) throw bad('The export does not say which master key it belongs to (no "xfp").');
  if (fingerprints.size !== 1) throw bad('The export holds keys of more than one device.');
  if (keys.length === 0) throw bad('The export holds no account public key with a derivation path.');
  return { fingerprint: [...fingerprints][0]!, keys };
}

// ----------------------------------------------------------------------------------------------- descriptor text

const KEY_EXPRESSION = /\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\]([xyztuvXYZTUV]pub[1-9A-HJ-NP-Za-km-z]{100,})/g;

function exportFromText(text: string): DeviceKeyExport {
  const keys: ExportedKey[] = [];
  const fingerprints = new Set<string>();
  for (const m of text.matchAll(KEY_EXPRESSION)) {
    const path = m[2] ? parsePath(`m${m[2]}`) : [];
    if (path.length === 0) continue;
    fingerprints.add(m[1]!.toLowerCase());
    keys.push({ path, xpub: normalizeXpub(m[3]!) });
  }
  if (keys.length === 0) {
    if (XPUB_LIKE.test(text.trim())) throw bad('That is a bare extended public key. Export the account key with its master fingerprint and derivation path ([fingerprint/48h/...]xpub).');
    throw bad('That QR is not a public key export.');
  }
  if (fingerprints.size !== 1) throw bad('The export holds keys of more than one device.');
  return { fingerprint: [...fingerprints][0]!, keys };
}

// ----------------------------------------------------------------------------------------------- entry point

/** Reads a device's key export from a scanned payload. Throws a `HardwareError('invalid-response')` with a message fit to show. */
export function parseDeviceExport(payload: QrPayload): DeviceKeyExport {
  switch (payload.type) {
    case 'ur':
      return exportFromUr(payload.urType, payload.cbor);
    case 'bbqr': {
      if (payload.fileType !== 'J' && payload.fileType !== 'U') throw bad(`That QR is not a key export (BBQr type ${payload.fileType}).`);
      return parseText(new TextDecoder().decode(payload.data));
    }
    case 'text':
      return parseText(payload.text);
  }
}

function parseText(text: string): DeviceKeyExport {
  const t = text.trim();
  if (t.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      throw bad('The key export is not valid JSON.');
    }
    return exportFromJson(json as Json);
  }
  return exportFromText(t);
}

/** The exported key for `path`, or a message listing what the export does hold. */
export function findExportedKey(exp: DeviceKeyExport, path: readonly number[]): ExportedKey {
  const found = exp.keys.find((k) => k.path.length === path.length && k.path.every((n, i) => n === path[i]));
  if (found) return found;
  throw bad(`The export does not include the key for this path. It holds: ${exp.keys.map((k) => formatKeyPath(k.path)).join(', ')}.`);
}

function formatKeyPath(path: readonly number[]): string {
  return `m/${path.map((n) => (n >= HARDENED ? `${n - HARDENED}'` : String(n))).join('/')}`;
}

