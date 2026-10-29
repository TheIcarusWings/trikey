import { describe, expect, it } from 'vitest';
import {
  PairingUriError,
  decodePairingUri,
  encodePairingUri,
  generatePairingSecret,
  normalizeRelayUrl,
} from '../src/index.js';
import { keypair } from './helpers.js';

const NOW = 1_800_000_000;
const { pubkey } = keypair();

function payload(over: Partial<Parameters<typeof encodePairingUri>[0]> = {}) {
  return {
    guardianPubkey: pubkey,
    relays: ['wss://relay.example.com', 'wss://nos.example.org/path'],
    secret: generatePairingSecret(),
    expiresAt: NOW + 600,
    ...over,
  };
}

describe('pairing URI', () => {
  it('round-trips', () => {
    const p = payload({ label: 'Umbrel at home' });
    const uri = encodePairingUri(p, NOW);
    expect(uri.startsWith('trikey://pair?')).toBe(true);
    expect(decodePairingUri(uri, NOW)).toEqual(p);
  });

  it('accepts the opaque form trikey:pair?...', () => {
    const uri = encodePairingUri(payload(), NOW).replace('trikey://pair', 'trikey:pair');
    expect(decodePairingUri(uri, NOW).relays).toHaveLength(2);
  });

  it('generates url-safe 256-bit secrets', () => {
    const s = generatePairingSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generatePairingSecret()).not.toBe(s);
  });

  it('rejects expired and far-future codes', () => {
    const uri = encodePairingUri(payload(), NOW);
    expect(() => decodePairingUri(uri, NOW + 601)).toThrow(/expired/);
    expect(() => encodePairingUri(payload({ expiresAt: NOW + 10 * 86400 }), NOW)).toThrow(PairingUriError);
  });

  it('rejects bad schemes, actions, versions, npubs and secrets', () => {
    const good = encodePairingUri(payload(), NOW);
    expect(() => decodePairingUri(good.replace('trikey:', 'bitcoin:'), NOW)).toThrow(/not a trikey/);
    expect(() => decodePairingUri(good.replace('//pair', '//other'), NOW)).toThrow(/action/);
    expect(() => decodePairingUri(good.replace('v=1', 'v=2'), NOW)).toThrow(/version/);
    expect(() => decodePairingUri(good.replace(/npub=npub1/, 'npub=nsec1'), NOW)).toThrow();
    expect(() => decodePairingUri(good.replace(/secret=[^&]+/, 'secret=short'), NOW)).toThrow(/secret/);
    expect(() => decodePairingUri(good.replace(/&exp=\d+/, ''), NOW)).toThrow(/expiry/);
    expect(() => decodePairingUri('trikey://pair', NOW)).toThrow();
  });

  it('requires between 1 and 8 relays', () => {
    expect(() => encodePairingUri(payload({ relays: [] }), NOW)).toThrow(/relays/);
    const many = Array.from({ length: 9 }, (_, i) => `wss://r${i}.example.com`);
    expect(() => encodePairingUri(payload({ relays: many }), NOW)).toThrow(/relays/);
  });

  it('only allows plaintext ws:// for local or onion hosts', () => {
    expect(normalizeRelayUrl('ws://umbrel.local:4848')).toBe('ws://umbrel.local:4848');
    expect(normalizeRelayUrl('ws://192.168.1.20:7777')).toBe('ws://192.168.1.20:7777');
    expect(normalizeRelayUrl('ws://abcdef.onion')).toBe('ws://abcdef.onion');
    expect(() => normalizeRelayUrl('ws://relay.example.com')).toThrow(/insecure/);
    expect(() => normalizeRelayUrl('https://relay.example.com')).toThrow(/ws\(s\)/);
    expect(() => normalizeRelayUrl('wss://user:pw@relay.example.com')).toThrow(/credentials/);
    expect(() => normalizeRelayUrl('not a url')).toThrow(PairingUriError);
  });
});
