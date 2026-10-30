/**
 * Where the regtest stack is (docker-compose.yml publishes both ports on 127.0.0.1) and how the tests are switched on.
 * The credentials are the throwaway ones of the compose file: regtest only, no secret.
 */

export interface E2eConfig {
  bitcoind: { host: string; port: number; user: string; pass: string };
  electrs: { host: string; port: number };
  /** The bitcoind wallet that mines and funds everything. */
  fundingWallet: string;
}

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, got "${value}"`);
  return n;
}

/** The same variables docker-compose.yml reads: E2E_RPC_USER, E2E_RPC_PASS, E2E_RPC_PORT, E2E_ELECTRS_PORT. */
export function loadE2eConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const get = (k: string) => (env[k] === undefined || env[k]!.trim() === '' ? undefined : env[k]!.trim());
  return {
    bitcoind: {
      host: get('E2E_RPC_HOST') ?? '127.0.0.1',
      port: port('E2E_RPC_PORT', env['E2E_RPC_PORT'], 18443),
      user: get('E2E_RPC_USER') ?? 'trikey',
      // Regtest only. The same default as docker-compose.yml.
      pass: env['E2E_RPC_PASS'] === undefined || env['E2E_RPC_PASS'] === '' ? 'trikey-regtest-only' : env['E2E_RPC_PASS'],
    },
    electrs: { host: get('E2E_ELECTRS_HOST') ?? '127.0.0.1', port: port('E2E_ELECTRS_PORT', env['E2E_ELECTRS_PORT'], 50001) },
    fundingWallet: get('E2E_FUNDING_WALLET') ?? 'funding',
  };
}

/**
 * - unset (or `0`): the end-to-end tests skip, so `vitest run` anywhere never needs Docker;
 * - `fake`: the same tests against the guardian's in-process fake Electrs and fake Bitcoin Core (a dry run of the test
 *   code itself; checks that need a real node skip);
 * - anything else (`1`): the real regtest stack from docker-compose.yml.
 */
export type E2eMode = 'regtest' | 'fake';

export function e2eMode(env: NodeJS.ProcessEnv = process.env): E2eMode | undefined {
  const v = env['TRIKEY_E2E']?.trim().toLowerCase();
  if (!v || v === '0' || v === 'false' || v === 'no') return undefined;
  if (v === 'fake' || v === 'dry') return 'fake';
  return 'regtest';
}

export const SKIP_NOTE =
  'end-to-end tests skipped: set TRIKEY_E2E=1 with the Docker stack up (npm run stack:up -w @trikey/e2e), or TRIKEY_E2E=fake for a dry run on fakes';
