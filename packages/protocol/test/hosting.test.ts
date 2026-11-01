/**
 * Family hosting (docs/design/family-hosting.md): the invite URI, the `hosted.*` methods, the optional members added to
 * `recovery.start`, `recovery.update`, `hardware.confirm` and `recovery.access`, the `hosting_ending` alert and the
 * `family_hosting` feature. The host's own methods keep exactly their old shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  Alert,
  GUARDIAN_FEATURES,
  MAX_ABANDON,
  MAX_LEDGER_PAGE,
  MAX_PAIRING_TTL_SEC,
  MAX_WALLET_MAP_BYTES,
  PairingUriError,
  RecoveryAccessResult,
  decodeInviteUri,
  decodeTrikeyUri,
  encodeInviteUri,
  encodePairingUri,
  generatePairingSecret,
  methods,
} from '../src/index.js';
import { fakePsbt, hardwareAuth, keyOrigin, keypair, pairParams, policy } from './helpers.js';

const NOW = 1_800_000_000;
const { pubkey } = keypair();

function invite(over: Partial<Parameters<typeof encodeInviteUri>[0]> = {}) {
  return {
    guardianPubkey: pubkey,
    relays: ['wss://relay.example.com', 'wss://nos.example.org/path'],
    secret: generatePairingSecret(),
    expiresAt: NOW + 3600,
    network: 'signet' as const,
    ...over,
  };
}

describe('invite URI', () => {
  it('round-trips, with and without a label', () => {
    const p = invite({ label: 'Maria' });
    const uri = encodeInviteUri(p, NOW);
    expect(uri.startsWith('trikey://invite?v=1&')).toBe(true);
    expect(decodeInviteUri(uri, NOW)).toEqual(p);
    const bare = invite();
    expect(decodeInviteUri(encodeInviteUri(bare, NOW), NOW)).toEqual(bare);
  });

  it('carries the network, and decodeTrikeyUri tells it from a pairing code', () => {
    const uri = encodeInviteUri(invite({ network: 'bitcoin' }), NOW);
    const code = decodeTrikeyUri(uri, NOW);
    expect(code.kind).toBe('invite');
    expect(code.kind === 'invite' && code.payload.network).toBe('bitcoin');
    const pairing = encodePairingUri({ guardianPubkey: pubkey, relays: ['wss://relay.example.com'], secret: generatePairingSecret(), expiresAt: NOW + 60 }, NOW);
    expect(() => decodeInviteUri(pairing, NOW)).toThrow(/pairing code, not an invite/);
  });

  it('keeps the pairing URI rules: 24 hours at most, expiry checked, 1..8 relays', () => {
    expect(() => encodeInviteUri(invite({ expiresAt: NOW + MAX_PAIRING_TTL_SEC + 1 }), NOW)).toThrow(PairingUriError);
    const uri = encodeInviteUri(invite({ expiresAt: NOW + 60 }), NOW);
    expect(() => decodeInviteUri(uri, NOW + 61)).toThrow(/expired/);
    expect(() => encodeInviteUri(invite({ relays: [] }), NOW)).toThrow(PairingUriError);
  });

  it('needs the full 32-byte secret and a known network', () => {
    expect(() => encodeInviteUri(invite({ secret: 'A'.repeat(22) }), NOW)).toThrow(/32 bytes/);
    const uri = encodeInviteUri(invite(), NOW);
    expect(() => decodeInviteUri(uri.replace('net=signet', 'net=litecoin'), NOW)).toThrow(/network/);
    expect(() => decodeInviteUri(uri.replace(/&net=signet/, ''), NOW)).toThrow(/network/);
    expect(() => decodeInviteUri(uri.replace('v=1', 'v=2'), NOW)).toThrow(/version/);
  });
});

describe('hosted.* schemas', () => {
  const pair = {
    inviteSecret: 'A'.repeat(43),
    deviceName: 'Ana phone',
    walletLabel: 'Ana',
    network: 'signet',
    accountPubkeys: { app: `02${'11'.repeat(32)}`, hardware: `03${'22'.repeat(32)}` },
    hardwareAuth: { pubkey: `02${'33'.repeat(32)}`, path: "m/48'/1'/0'/2'/0/0", tweak: '44'.repeat(32) },
    hardwareAuthProof: pairParams.hardwareAuthProof,
    rules: policy,
    walletMap: 'AbC-_9'.repeat(10),
    phoneNostrPubkey: 'ee'.repeat(32),
  };

  it('hosted.prepare requires the phone entropy (a guest never gets the guardian own key)', () => {
    const p = methods['hosted.prepare'].params;
    expect(p.safeParse({ inviteSecret: 'A'.repeat(43), network: 'signet', entropy: 'ab'.repeat(32) }).success).toBe(true);
    expect(p.safeParse({ inviteSecret: 'A'.repeat(43), network: 'signet' }).success).toBe(false);
    expect(p.safeParse({ inviteSecret: 'A'.repeat(22), network: 'signet', entropy: 'ab'.repeat(32) }).success).toBe(false);
  });

  it('hosted.prepare answers an account pubkey, never an xpub', () => {
    const r = methods['hosted.prepare'].result;
    expect(r.safeParse({ cosignerAccountPubkey: `02${'aa'.repeat(32)}`, guardianVersion: '0.2.0', features: ['family_hosting'] }).success).toBe(true);
    expect(r.safeParse({ cosignerAccountPubkey: 'tpubDC...', guardianVersion: '0.2.0' }).success).toBe(false);
  });

  it('hosted.pair: strict, needs the tweak and the wallet map, refuses a descriptor', () => {
    const p = methods['hosted.pair'].params;
    expect(p.safeParse(pair).success).toBe(true);
    expect(p.safeParse({ ...pair, descriptor: 'wsh(sortedmulti(2,A,B,C))' }).success).toBe(false);
    const { walletMap: _m, ...noMap } = pair;
    expect(p.safeParse(noMap).success).toBe(false);
    expect(p.safeParse({ ...pair, hardwareAuth: { pubkey: pair.hardwareAuth.pubkey, path: pair.hardwareAuth.path } }).success).toBe(false);
    expect(p.safeParse({ ...pair, walletMap: 'not base64url!' }).success).toBe(false);
    expect(p.safeParse({ ...pair, walletMap: 'A'.repeat(Math.ceil((MAX_WALLET_MAP_BYTES * 4) / 3) + 5) }).success).toBe(false);
  });

  it('hosted.coins pages at most MAX_LEDGER_PAGE coins', () => {
    const p = methods['hosted.coins'].params;
    expect(p.safeParse({}).success).toBe(true);
    expect(p.safeParse({ limit: MAX_LEDGER_PAGE + 1 }).success).toBe(false);
    const coin = { txid: 'ab'.repeat(32), vout: 1, valueSats: 1000, script: `0020${'cd'.repeat(32)}`, tweaks: { app: '01'.repeat(32), hardware: '02'.repeat(32), cosigner: '03'.repeat(32) }, at: NOW };
    expect(methods['hosted.coins'].result.safeParse({ walletId: '0123456789abcdef', coins: [coin], total: 1 }).success).toBe(true);
    expect(methods['hosted.coins'].result.safeParse({ walletId: '0123456789abcdef', coins: [{ ...coin, script: `0014${'cd'.repeat(20)}` }], total: 1 }).success).toBe(false);
  });

  it('hosted.map.get answers the map or null', () => {
    expect(methods['hosted.map.get'].result.safeParse({ walletId: '0123456789abcdef', map: null }).success).toBe(true);
    expect(methods['hosted.map.get'].result.safeParse({ walletId: '0123456789abcdef', map: 'AbC' }).success).toBe(true);
  });
});

describe('optional members for hosted wallets; the host forms unchanged', () => {
  const keys = { app: `02${'11'.repeat(32)}`, hardware: `03${'22'.repeat(32)}`, cosigner: `02${'33'.repeat(32)}` };

  it('recovery.start: the descriptor form, or the hosted form, never a mix', () => {
    const p = methods['recovery.start'].params;
    expect(p.safeParse({ sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' }).success).toBe(true);
    expect(p.safeParse({ sweepPsbt: fakePsbt(2), destinationKeys: keys, destinationMap: 'AbC', abandon: [`${'ab'.repeat(32)}:0`] }).success).toBe(true);
    expect(p.safeParse({ sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))', abandon: [] }).success).toBe(false);
    expect(p.safeParse({ sweepPsbt: fakePsbt(2), destinationKeys: keys }).success).toBe(false);
    const many = Array.from({ length: MAX_ABANDON + 1 }, (_, i) => `${'ab'.repeat(32)}:${i}`);
    expect(p.safeParse({ sweepPsbt: fakePsbt(2), destinationKeys: keys, destinationMap: 'AbC', abandon: many }).success).toBe(false);
  });

  it('recovery.update: optional abandon', () => {
    const p = methods['recovery.update'].params;
    expect(p.safeParse({ recoveryId: '1-abcdefabcdef', sweepPsbt: fakePsbt(3) }).success).toBe(true);
    expect(p.safeParse({ recoveryId: '1-abcdefabcdef', sweepPsbt: fakePsbt(3), abandon: ['nope'] }).success).toBe(false);
  });

  it('hardware.confirm: an optional tweak', () => {
    const p = methods['hardware.confirm'].params;
    expect(p.safeParse({ hardwareAuth, hardwareAuthProof: pairParams.hardwareAuthProof }).success).toBe(true);
    expect(p.safeParse({ hardwareAuth: { ...hardwareAuth, tweak: '55'.repeat(32) }, hardwareAuthProof: pairParams.hardwareAuthProof }).success).toBe(true);
    expect(p.safeParse({ hardwareAuth: { ...hardwareAuth, extra: 1 }, hardwareAuthProof: pairParams.hardwareAuthProof }).success).toBe(false);
  });

  it('pair keeps its strict shape (no hosted members)', () => {
    expect(methods.pair.params.safeParse(pairParams).success).toBe(true);
    expect(methods.pair.params.safeParse({ ...pairParams, walletMap: 'AbC' }).success).toBe(false);
  });

  it('recovery.access: a hosted answer carries account pubkeys instead of a descriptor', () => {
    const base = {
      walletId: '0123456789abcdef',
      network: 'signet',
      hardwareAuth,
      policy,
      nextHardwareSequence: 1,
      phoneSpending: 'enabled',
      activeRecoveryId: null,
      accessExpiresAt: NOW,
    };
    expect(RecoveryAccessResult.safeParse({ ...base, hosted: { accountPubkeys: keys } }).success).toBe(true);
    expect(RecoveryAccessResult.safeParse({ ...base, descriptor: 'wsh(sortedmulti(2,A,B,C))', guardianKey: keyOrigin }).success).toBe(true);
  });
});

describe('alerts and features', () => {
  it('hosting_ending parses; wallet_retired knows hosting_ended', () => {
    expect(Alert.safeParse({ type: 'hosting_ending', at: NOW, walletId: '0123456789abcdef', endsAt: NOW + 30 * 86400 }).success).toBe(true);
    expect(Alert.safeParse({ type: 'wallet_retired', at: NOW, walletId: '0123456789abcdef', reason: 'hosting_ended' }).success).toBe(true);
  });

  it('family_hosting is a feature name', () => {
    expect(GUARDIAN_FEATURES.familyHosting).toBe('family_hosting');
  });

  it('guardian.status may carry the hosting state for a guest', () => {
    const st = { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.2.0', time: NOW };
    expect(methods['guardian.status'].result.safeParse({ ...st, hosting: { state: 'leaving', endsAt: NOW + 86400 } }).success).toBe(true);
    expect(methods['guardian.status'].result.safeParse({ ...st, hosting: { state: 'gone' } }).success).toBe(false);
  });
});
