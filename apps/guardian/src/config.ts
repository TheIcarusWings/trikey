/**
 * Runtime configuration from the environment (the packaging contract in
 * packaging/README.md and packaging/docker/Dockerfile):
 *
 *   PORT              HTTP port (default 3000), the only inbound listener
 *   TRIKEY_DATA_DIR   state directory (default /data)
 *   TRIKEY_WEB_DIR    the built web UI (served statically)
 *   ELECTRUM_HOST     the Electrum server (Electrs, Fulcrum): on Umbrel and Start9 the box's own Electrs
 *   ELECTRUM_PORT     default 50001, or 50002 with ELECTRUM_TLS
 *   ELECTRUM_TLS      1 to connect over TLS (a server on another machine). Plain TCP goes only to a loopback,
 *                     private or link-local address (chain/electrum.ts)
 *   ELECTRUM_TLS_CERT_SHA256 optional, with ELECTRUM_TLS: the SHA-256 fingerprint of the server's own
 *                     (self-signed) certificate, accepted instead of a CA-signed one
 *   ELECTRUM_ALLOW_PUBLIC_PLAINTEXT optional: 1 allows plain TCP to an address on the internet (not advised)
 *   BITCOIN_RPC_HOST, BITCOIN_RPC_PORT, BITCOIN_RPC_USER, BITCOIN_RPC_PASS
 *                     optional: Bitcoin Core, for sync status, as a broadcast fallback,
 *                     and for the silent payment scanner (blocks with prevouts)
 *   BITCOIN_NETWORK   bitcoin|testnet|signet|regtest, plus the names Umbrel and
 *                     others use (mainnet, main, testnet3, testnet4, test)
 *   SP_SCAN_THREADS   optional: worker threads for the silent payment scanner (1 to 64;
 *                     default one less than the CPU cores, at least 1). 1 scans in the
 *                     main thread, without workers
 *   TRIKEY_PLATFORM   umbrel, start9 or docker (default). Umbrel and Start9 put their own login in front of the
 *                     web UI; on plain Docker nothing does, so first-run setup asks for a one-time setup code
 *                     that the guardian prints in its log (http/setup-code.ts)
 *   TRIKEY_RELAYS     optional: the relays the first-run screen offers (comma-separated wss:// URLs, 1 to 8),
 *                     instead of the built-in list
 *   TRIKEY_EXTRA_ENTROPY optional: 32 bytes as 64 hex characters (on Umbrel, the app's
 *                     APP_SEED), mixed into every new setup seed (keystore.ts,
 *                     `trikey/guardian-seed/v1`). Any other value is hashed to 32 bytes. Never logged
 */
import { isIP } from 'node:net';
import { availableParallelism } from 'node:os';
import type { NetworkName } from '@trikey/core';
import { checkRelayList } from '@trikey/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { DEFAULT_KDF, SETUP_ENTROPY_BYTES, type KdfParams } from './keystore.js';
import { isLocalAddress, normalizeFingerprint } from './chain/electrum.js';

/**
 * Where the guardian reads the chain. Today one kind: an Electrum server (the box's own Electrs, or one on the
 * owner's network). Shaped so other kinds (a public server, Bitcoin Core alone) can sit next to it.
 */
export interface ElectrumConfig {
  host: string;
  port: number;
  /** TLS (ELECTRUM_TLS). */
  tls?: boolean;
  /** With `tls`: the pinned certificate's SHA-256 fingerprint, `AB:CD:...` (ELECTRUM_TLS_CERT_SHA256). */
  certSha256?: string;
  /** Plain TCP to an address on the internet allowed (ELECTRUM_ALLOW_PUBLIC_PLAINTEXT). */
  allowPublicPlaintext?: boolean;
}

/** Who runs the guardian: a platform with its own login in front of the web UI, or plain Docker (no login before setup). */
export type Platform = 'umbrel' | 'start9' | 'docker';

export interface BitcoinRpcConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface GuardianConfig {
  port: number;
  /** Interface to bind. The container binds all interfaces; the platform's app proxy is the only client. */
  host: string;
  dataDir: string;
  webDir?: string;
  network: NetworkName;
  electrum?: ElectrumConfig;
  bitcoinRpc?: BitcoinRpcConfig;
  /** Argon2id cost for new keystores (existing ones keep the parameters they were made with). */
  kdf: KdfParams;
  /** Relays the first-run screen offers. */
  relayOptions: { url: string; label?: string; defaultSelected: boolean }[];
  /** Worker threads for the silent payment scanner (silent/scan-pool.ts). Unset or 1: the main thread scans. */
  spScanThreads?: number;
  /**
   * TRIKEY_EXTRA_ENTROPY: 32 bytes mixed into every new setup seed (keystore.ts `setupSeedEntropy`).
   * Secret-ish: never logged, never written anywhere.
   */
  extraEntropy?: Uint8Array;
  /**
   * TRIKEY_PLATFORM. `docker` (the default of `loadConfig`): first-run setup needs the setup code from the log.
   * Unset (embedders and tests that build a config by hand): no setup code.
   */
  platform?: Platform;
}

const NETWORK_ALIASES: Record<string, NetworkName> = {
  bitcoin: 'bitcoin',
  mainnet: 'bitcoin',
  main: 'bitcoin',
  testnet: 'testnet',
  testnet3: 'testnet',
  // testnet4 uses testnet3's address and key formats.
  testnet4: 'testnet',
  test: 'testnet',
  signet: 'signet',
  regtest: 'regtest',
};

export function parseNetwork(value: string | undefined): NetworkName {
  const v = (value ?? 'bitcoin').trim().toLowerCase();
  const n = NETWORK_ALIASES[v === '' ? 'bitcoin' : v];
  if (!n) throw new Error(`BITCOIN_NETWORK must be one of bitcoin, testnet, signet or regtest (got "${value}")`);
  return n;
}

function parsePort(name: string, value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d{1,5}$/.test(value.trim())) throw new Error(`${name} must be a port number`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return n;
}

/** SP_SCAN_THREADS, or by default one thread less than the cores Node may use (the main thread fetches the blocks), at least 1. */
export function parseScanThreads(value: string | undefined, cores = availableParallelism()): number {
  if (value === undefined || value.trim() === '') return Math.max(1, cores - 1);
  const n = Number(value.trim());
  if (!/^\d{1,2}$/.test(value.trim()) || n < 1 || n > 64) throw new Error('SP_SCAN_THREADS must be a whole number from 1 to 64');
  return n;
}

/**
 * TRIKEY_EXTRA_ENTROPY: unset or empty means none. 64 hex characters (Umbrel's APP_SEED: the hex HMAC-SHA256 of
 * its seed and the app id) are used as the 32 bytes they spell; any other value is hashed to 32 bytes with
 * SHA-256. It never stops the guardian from starting: the value only adds to the OS randomness (it is mixed in,
 * never in place of it), so a platform that passes it in another format still gets its benefit, and a broken
 * value costs nothing. The value is never echoed.
 */
export function parseExtraEntropy(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (new RegExp(`^[0-9a-fA-F]{${SETUP_ENTROPY_BYTES * 2}}$`).test(v)) return hex.decode(v.toLowerCase());
  return sha256(new TextEncoder().encode(v)).slice(0, SETUP_ENTROPY_BYTES);
}

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)?$/i;

function parseFlag(name: string, value: string | undefined): boolean {
  const v = (value ?? '').trim();
  if (TRUE.test(v)) return true;
  if (FALSE.test(v)) return false;
  throw new Error(`${name} must be 1 or 0 (got "${value}")`);
}

export function parsePlatform(value: string | undefined): Platform {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'docker';
  if (v === 'umbrel' || v === 'start9' || v === 'docker') return v;
  throw new Error(`TRIKEY_PLATFORM must be umbrel, start9 or docker (got "${value}")`);
}

/** ELECTRUM_* (see the file comment). Throws on a combination that cannot work or would be unsafe. */
export function parseElectrum(env: NodeJS.ProcessEnv): ElectrumConfig | undefined {
  const get = (k: string) => {
    const v = env[k];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const host = get('ELECTRUM_HOST');
  const tls = parseFlag('ELECTRUM_TLS', env['ELECTRUM_TLS']);
  const pinText = get('ELECTRUM_TLS_CERT_SHA256');
  const allowPublicPlaintext = parseFlag('ELECTRUM_ALLOW_PUBLIC_PLAINTEXT', env['ELECTRUM_ALLOW_PUBLIC_PLAINTEXT']);
  if (!host) return undefined;
  if (/[\s/]/.test(host) || host.includes('://')) throw new Error('ELECTRUM_HOST must be a host name or an IP address only (no scheme, no port)');
  let certSha256: string | undefined;
  if (pinText) {
    if (!tls) throw new Error('ELECTRUM_TLS_CERT_SHA256 is set, so set ELECTRUM_TLS=1 too');
    if (/^[0-9a-f]{40}$/i.test(pinText.replace(/[\s:]/g, ''))) throw new Error('ELECTRUM_TLS_CERT_SHA256 is a SHA-1 fingerprint: use the SHA-256 one');
    certSha256 = normalizeFingerprint(pinText);
    if (!certSha256) throw new Error('ELECTRUM_TLS_CERT_SHA256 must be the SHA-256 fingerprint of the certificate (64 hex digits, colons allowed)');
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (!tls && !allowPublicPlaintext && isIP(bare) && !isLocalAddress(bare))
    throw new Error(`ELECTRUM_HOST ${host} is on the internet: set ELECTRUM_TLS=1 (plain TCP only goes to this box or your own network)`);
  const port = parsePort('ELECTRUM_PORT', env['ELECTRUM_PORT'], tls ? 50002 : 50001)!;
  return { host, port, ...(tls ? { tls } : {}), ...(certSha256 ? { certSha256 } : {}), ...(allowPublicPlaintext ? { allowPublicPlaintext } : {}) };
}

/** TRIKEY_RELAYS: unset means the built-in list; else 1 to 8 relay URLs, all selected by default. */
export function parseRelayOptions(value: string | undefined): GuardianConfig['relayOptions'] {
  if (value === undefined || value.trim() === '') return DEFAULT_RELAY_OPTIONS;
  const r = checkRelayList(
    value
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean),
  );
  if ('error' in r) throw new Error(`TRIKEY_RELAYS: ${r.error}`);
  return r.relays.map((url) => ({ url, defaultSelected: true }));
}

/**
 * The relays offered at setup, all ticked. `relay.trikey.app` is the project's own relay: it stores only gift wraps
 * (kind 1059) and Nostr Connect events (kind 24133), serves DM inbox lists (kind 10050) read-only and refuses profiles
 * (kind 0), and makes delivery less dependent on public relays.
 * Like every relay it sees only ciphertext and metadata (which keys talk, when, from where), and it is never the only
 * one: the others stay ticked, and the owner can untick any of them.
 */
export const DEFAULT_RELAY_OPTIONS: GuardianConfig['relayOptions'] = [
  { url: 'wss://relay.trikey.app', label: 'Trikey relay', defaultSelected: true },
  { url: 'wss://relay.damus.io', defaultSelected: true },
  { url: 'wss://nos.lol', defaultSelected: true },
  { url: 'wss://relay.primal.net', defaultSelected: true },
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const get = (k: string) => {
    const v = env[k];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const rpcHost = get('BITCOIN_RPC_HOST');
  let bitcoinRpc: BitcoinRpcConfig | undefined;
  if (rpcHost) {
    const user = get('BITCOIN_RPC_USER');
    const pass = env['BITCOIN_RPC_PASS'];
    if (!user || !pass) throw new Error('BITCOIN_RPC_HOST is set, so BITCOIN_RPC_USER and BITCOIN_RPC_PASS are needed too');
    const network = parseNetwork(env['BITCOIN_NETWORK']);
    const defaultRpcPort = { bitcoin: 8332, testnet: 18332, signet: 38332, regtest: 18443 }[network];
    bitcoinRpc = { host: rpcHost, port: parsePort('BITCOIN_RPC_PORT', env['BITCOIN_RPC_PORT'], defaultRpcPort)!, user, pass };
  }
  return {
    port: parsePort('PORT', env['PORT'], 3000)!,
    host: '0.0.0.0',
    dataDir: get('TRIKEY_DATA_DIR') ?? '/data',
    webDir: get('TRIKEY_WEB_DIR'),
    network: parseNetwork(env['BITCOIN_NETWORK']),
    electrum: parseElectrum(env),
    bitcoinRpc,
    kdf: DEFAULT_KDF,
    relayOptions: parseRelayOptions(env['TRIKEY_RELAYS']),
    spScanThreads: parseScanThreads(env['SP_SCAN_THREADS']),
    extraEntropy: parseExtraEntropy(env['TRIKEY_EXTRA_ENTROPY']),
    platform: parsePlatform(env['TRIKEY_PLATFORM']),
  };
}
