/**
 * The chain source on the wire (PROTOCOL.md, "Chain data", "Chain source"): `guardian.status.chainSource` and the
 * `chain_source_changed` alert. Read-only for the phone; older guardians send neither, older phones drop both.
 */
import { describe, expect, it } from 'vitest';
import { Alert, methods } from '../src/index.js';

const status = { state: 'unlocked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.8', time: 1_900_000_000 };

describe('chain source: guardian.status', () => {
  it('may say own or public, Electrum or Bitcoin Core, and the host; older answers without it still parse', () => {
    const r = methods['guardian.status'].result;
    expect(r.safeParse({ ...status, chainSource: { kind: 'public', backend: 'electrum', host: 'mempool.space' } }).success).toBe(true);
    expect(r.safeParse({ ...status, chainSource: { kind: 'own', backend: 'core', host: '192.168.1.5' } }).success).toBe(true);
    expect(r.safeParse(status).success).toBe(true);
    expect(r.safeParse({ ...status, chainSource: { kind: 'someone', backend: 'electrum', host: 'x' } }).success).toBe(false);
    expect(r.safeParse({ ...status, chainSource: { kind: 'own', backend: 'esplora', host: 'x' } }).success).toBe(false);
    expect(r.safeParse({ ...status, chainSource: { kind: 'own', backend: 'electrum', host: 'x'.repeat(256) } }).success).toBe(false);
  });
});

describe('chain source: the alert', () => {
  it('chain_source_changed carries the kind, the backend and the host', () => {
    const a = { type: 'chain_source_changed', kind: 'public', backend: 'electrum', host: 'mempool.space', at: 1_900_000_000, atMs: 1_900_000_000_100, message: 'Your guardian now reads the blockchain from the public server mempool.space:60602.' };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(Alert.safeParse({ ...a, host: undefined }).success).toBe(false);
    expect(Alert.safeParse({ ...a, kind: 'other' }).success).toBe(false);
  });
});
