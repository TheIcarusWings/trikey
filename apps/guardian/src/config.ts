/**
 * Runtime configuration from the environment (the packaging contract in
 * packaging/README.md and packaging/docker/Dockerfile):
 *
 *   PORT              HTTP port (default 3000), the only inbound listener
 *   TRIKEY_DATA_DIR   state directory (default /data)
 *   TRIKEY_WEB_DIR    the built web UI (served statically)
 *   ELECTRUM_HOST     Electrs, TCP (no TLS: it runs on the same box)
 *   ELECTRUM_PORT     default 50001
 *   BITCOIN_RPC_HOST, BITCOIN_RPC_PORT, BITCOIN_RPC_USER, BITCOIN_RPC_PASS
 *                     optional: Bitcoin Core, for sync status, as a broadcast fallback,
 *                     and for the silent payment scanner (blocks with prevouts)
 *   BITCOIN_NETWORK   bitcoin|testnet|signet|regtest, plus the names Umbrel and
 *                     others use (mainnet, main, testnet3, testnet4, test)
 *   SP_SCAN_THREADS   optional: worker threads for the silent payment scanner (1 to 64;
 *                     default one less than the CPU cores, at least 1). 1 scans in the
 *                     main thread, without workers
 *   TRIKEY_EXTRA_ENTROPY optional: 32 bytes as 64 hex characters (on Umbrel, the app's
 *                     APP_SEED), mixed into every new setup seed (keystore.ts,
 *                     `trikey/guardian-seed/v1`). Any other value is hashed to 32 bytes. Never logged
 */
import { availableParallelism } from 'node:os';
import type { NetworkName } from '@trikey/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { DEFAULT_KDF, SETUP_ENTROPY_BYTES, type KdfParams } from './keystore.js';

export interface ElectrumConfig {
  host: string;
  port: number;
}

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

export const DEFAULT_RELAY_OPTIONS: GuardianConfig['relayOptions'] = [
  { url: 'wss://relay.damus.io', defaultSelected: true },
  { url: 'wss://nos.lol', defaultSelected: true },
  { url: 'wss://relay.primal.net', defaultSelected: true },
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const get = (k: string) => {
    const v = env[k];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const electrumHost = get('ELECTRUM_HOST');
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
    electrum: electrumHost ? { host: electrumHost, port: parsePort('ELECTRUM_PORT', env['ELECTRUM_PORT'], 50001)! } : undefined,
    bitcoinRpc,
    kdf: DEFAULT_KDF,
    relayOptions: DEFAULT_RELAY_OPTIONS,
    spScanThreads: parseScanThreads(env['SP_SCAN_THREADS']),
    extraEntropy: parseExtraEntropy(env['TRIKEY_EXTRA_ENTROPY']),
  };
}
