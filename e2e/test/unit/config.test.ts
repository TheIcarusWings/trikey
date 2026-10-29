import { describe, expect, it } from 'vitest';
import { e2eMode, loadE2eConfig } from '../../src/config.js';

describe('loadE2eConfig', () => {
  it('defaults to the compose file\'s published ports and throwaway credentials', () => {
    expect(loadE2eConfig({})).toEqual({
      bitcoind: { host: '127.0.0.1', port: 18443, user: 'trikey', pass: 'trikey-regtest-only' },
      electrs: { host: '127.0.0.1', port: 50001 },
      fundingWallet: 'funding',
    });
  });

  it('reads the same variables docker-compose.yml reads', () => {
    const c = loadE2eConfig({ E2E_RPC_USER: 'u', E2E_RPC_PASS: 'p w', E2E_RPC_PORT: '28443', E2E_ELECTRS_PORT: '50002', E2E_RPC_HOST: 'node', E2E_FUNDING_WALLET: 'w' });
    expect(c).toEqual({ bitcoind: { host: 'node', port: 28443, user: 'u', pass: 'p w' }, electrs: { host: '127.0.0.1', port: 50002 }, fundingWallet: 'w' });
  });

  it('refuses a port that is not one', () => {
    expect(() => loadE2eConfig({ E2E_RPC_PORT: 'abc' })).toThrow(/E2E_RPC_PORT/);
    expect(() => loadE2eConfig({ E2E_ELECTRS_PORT: '70000' })).toThrow(/E2E_ELECTRS_PORT/);
  });
});

describe('e2eMode', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['0', undefined],
    ['false', undefined],
    ['1', 'regtest'],
    ['true', 'regtest'],
    ['regtest', 'regtest'],
    ['fake', 'fake'],
    ['DRY', 'fake'],
  ])('TRIKEY_E2E=%s is %s', (value, mode) => {
    expect(e2eMode(value === undefined ? {} : { TRIKEY_E2E: value })).toBe(mode);
  });
});
