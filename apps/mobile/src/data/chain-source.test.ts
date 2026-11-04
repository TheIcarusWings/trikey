import { describe, expect, it } from 'vitest';
import { PUBLIC_SERVER_WARNING, chainDataLabel } from './chain-source';

describe("Settings > Guardian: where the guardian reads the chain", () => {
  it('says "Your node" for the owner\'s own server, and for guardians that do not say (they use the box\'s node)', () => {
    expect(chainDataLabel(undefined)).toBe('Your node');
    expect(chainDataLabel({ kind: 'own', backend: 'electrum', host: '10.21.21.10' })).toBe('Your node');
    expect(chainDataLabel({ kind: 'own', backend: 'core', host: '192.168.1.5' })).toBe('Your node (Bitcoin Core)');
  });

  it('names a public server, with the warning', () => {
    expect(chainDataLabel({ kind: 'public', backend: 'electrum', host: 'mempool.space' })).toBe('Public server: mempool.space');
    expect(PUBLIC_SERVER_WARNING).toMatch(/sees your wallet's addresses/);
    expect(PUBLIC_SERVER_WARNING).toMatch(/cannot spend or change your rules/);
    expect(PUBLIC_SERVER_WARNING).toMatch(/Use your own node/);
  });
});
