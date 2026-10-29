import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@trikey/protocol';
import { loadConfig, parseNetwork } from '../src/config.js';
import { parseCancel } from '../src/dm-cancel.js';
import { PAIRING_MAX_FAILURES, PAIRING_TTL_MS, PairingSessions } from '../src/pairing.js';
import { recoveryToWire, refusalCode, refusalData, refusalError, toSeconds } from '../src/nostr/wire.js';
import { formatBtc, formatWhen } from '../src/alerts.js';
import { createLogger } from '../src/log.js';
import type { RecoveryView } from '../src/policy/index.js';

describe('pairing sessions', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('checks the secret, binds to the first phone, expires and burns', () => {
    const p = new PairingSessions();
    const t = 1_000_000;
    expect(p.check('x'.repeat(43), A, t)).toEqual({ ok: false, reason: 'no_session' });
    const s = p.create(t);
    expect(s.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresAt).toBe(t + PAIRING_TTL_MS);
    expect(p.check(s.secret, A, t + 1).ok).toBe(true);
    expect(p.check(s.secret, A, t + 2).ok).toBe(true); // pair.prepare does not use it up
    expect(p.check(s.secret, B, t + 3)).toEqual({ ok: false, reason: 'claimed' });
    p.complete(s.id);
    expect(p.check(s.secret, A, t + 4)).toEqual({ ok: false, reason: 'used' });
    expect(p.get(s.id, t + 5)?.status).toBe('paired');

    const s2 = p.create(t + 10);
    expect(p.get(s.id, t + 10)).toBeUndefined(); // only the latest session exists
    expect(p.check(s2.secret, A, t + 10 + PAIRING_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(p.answering(t + 10 + PAIRING_TTL_MS + 1)).toBe(true);
    expect(p.answering(t + 10 + PAIRING_TTL_MS + 11 * 60_000)).toBe(false);
  });

  it('gives up after a few wrong attempts', () => {
    const p = new PairingSessions();
    const s = p.create(0);
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++) expect(p.check('W'.repeat(43), A, 1)).toEqual({ ok: false, reason: 'wrong_secret' });
    expect(p.check(s.secret, A, 2)).toEqual({ ok: false, reason: 'expired' });
    expect(p.get(s.id, 2)?.status).toBe('expired');
  });

  it('is invalidated by a lock', () => {
    const p = new PairingSessions();
    const s = p.create(0);
    p.invalidate();
    expect(p.check(s.secret, A, 1)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('CANCEL replies', () => {
  it('finds a recovery id in a reply, case-insensitively', () => {
    expect(parseCancel('CANCEL 2-0123456789ab')).toBe('2-0123456789ab');
    expect(parseCancel('  cancel   12-ABCDEF012345 please')).toBe('12-abcdef012345');
    expect(parseCancel('> quoted alert\n\nCancel 3-00000000000f')).toBe('3-00000000000f');
    expect(parseCancel('do not cancel')).toBeUndefined();
    expect(parseCancel('CANCEL everything')).toBeUndefined();
    expect(parseCancel('CANCEL 2-0123')).toBeUndefined();
  });
});

describe('wire conversions', () => {
  it('maps refusals to the PROTOCOL.md codes with JSON-safe data', () => {
    expect(refusalCode({ reason: 'guardian_locked' })).toBe(ErrorCode.GuardianLocked);
    expect(refusalCode({ reason: 'over_daily_limit', limit: 1n, used: 1n, outflow: 1n, wouldUse: 2n })).toBe(ErrorCode.PolicyViolation);
    expect(refusalCode({ reason: 'hardware_approval_required', detail: 'x' })).toBe(ErrorCode.ApprovalRequired);
    expect(refusalCode({ reason: 'no_recovery' })).toBe(ErrorCode.RecoveryNotActive);
    expect(refusalCode({ reason: 'missing_non_witness_utxo', input: 0 })).toBe(ErrorCode.PsbtInvalid);
    expect(refusalCode({ reason: 'already_registered' })).toBe(ErrorCode.AlreadyPaired);
    expect(refusalCode({ reason: 'invalid_rules', detail: 'x' })).toBe(ErrorCode.InvalidParams);
    const data = refusalData({ reason: 'sweep_fee_exceeds_cap', fee: 30_000n, cap: 20_000n });
    expect(data).toEqual({ reason: 'sweep_fee_exceeds_cap', fee: 30_000, cap: 20_000 });
    expect(() => JSON.stringify(refusalError({ reason: 'over_daily_limit', limit: 1n, used: 1n, outflow: 1n, wouldUse: 2n }).toJSON())).not.toThrow();
  });

  it('converts engine milliseconds to wire seconds', () => {
    const view: RecoveryView = {
      id: '1-0123456789ab',
      status: 'pending',
      survivingRole: 'hardware',
      sweepTxid: 'ab'.repeat(32),
      destinationWalletId: '0123456789abcdef',
      amountSats: 500_000n,
      feeSats: 600n,
      delayDays: 7,
      startedAt: 1_800_000_000_999,
      readyAt: 1_800_604_800_999,
    };
    expect(toSeconds(1_800_000_000_999)).toBe(1_800_000_000);
    expect(recoveryToWire(view, view.startedAt)).toMatchObject({ state: 'pending', startedAt: 1_800_000_000, readyAt: 1_800_604_800, amountSats: 500_000 });
    expect(recoveryToWire(view, view.readyAt).state).toBe('ready');
    const cancelled = recoveryToWire({ ...view, status: 'cancelled', cancelledAt: 1_800_000_100_500, cancelledBy: { kind: 'contact', pubkey: 'c'.repeat(64) } }, 0);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelledAt: 1_800_000_100, cancelledBy: 'contact' });
  });

  it('formats amounts and times for people', () => {
    expect(formatBtc(123_456_789n)).toBe('1.23456789 BTC (123,456,789 sats)');
    expect(formatBtc(546)).toBe('0.00000546 BTC (546 sats)');
    expect(formatWhen(Date.UTC(2026, 10, 5, 12, 30, 15))).toBe('2026-11-05 12:30 UTC');
  });
});

describe('config', () => {
  it('maps network names, including Umbrel’s', () => {
    expect(parseNetwork('mainnet')).toBe('bitcoin');
    expect(parseNetwork('MAIN')).toBe('bitcoin');
    expect(parseNetwork(undefined)).toBe('bitcoin');
    expect(parseNetwork('testnet4')).toBe('testnet');
    expect(parseNetwork('signet')).toBe('signet');
    expect(parseNetwork('regtest')).toBe('regtest');
    expect(() => parseNetwork('liquid')).toThrow(/BITCOIN_NETWORK/);
  });

  it('reads the packaging environment', () => {
    const c = loadConfig({
      PORT: '3010',
      TRIKEY_DATA_DIR: '/tmp/x',
      TRIKEY_WEB_DIR: '/app/web',
      ELECTRUM_HOST: '10.21.21.10',
      ELECTRUM_PORT: '50001',
      BITCOIN_RPC_HOST: '10.21.21.8',
      BITCOIN_RPC_USER: 'umbrel',
      BITCOIN_RPC_PASS: 'not-a-real-password',
      BITCOIN_NETWORK: 'mainnet',
    });
    expect(c).toMatchObject({ port: 3010, dataDir: '/tmp/x', webDir: '/app/web', network: 'bitcoin', electrum: { host: '10.21.21.10', port: 50001 } });
    expect(c.bitcoinRpc).toMatchObject({ host: '10.21.21.8', port: 8332, user: 'umbrel' });
    expect(loadConfig({}).electrum).toBeUndefined();
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ BITCOIN_RPC_HOST: 'x' })).toThrow(/BITCOIN_RPC_USER/);
  });
});

describe('logger', () => {
  it('redacts secret-looking fields and keeps one line per event', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), now: () => new Date(0) });
    log.info('test.event', { passphrase: 'hunter2', secretKey: 'abc', pubkey: 'ok', appNostrPubkey: 'ok2', note: 'two\nlines' });
    expect(lines).toEqual(['1970-01-01T00:00:00.000Z INFO test.event passphrase=[redacted] secretKey=[redacted] pubkey=ok appNostrPubkey=ok2 note="two lines"']);
  });
});
