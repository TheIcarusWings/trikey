/**
 * Security sweep 2, protocol finding 4 (LOW): a contact's kind-10050 list could name loopback or LAN hosts over
 * wss. The comment claimed wss alone blocked the LAN; it did the opposite of the private-host check that only
 * applied to ws. Now only public wss hosts are kept.
 */
import { describe, expect, it } from 'vitest';
import { isPublicDmRelay } from '../../src/nostr/dm.js';

describe('security: kind-10050 inbox relays reject loopback and LAN (sweep 2 protocol #4)', () => {
  it('keeps public wss relays', () => {
    expect(isPublicDmRelay('wss://relay.example/')).toBe(true);
    expect(isPublicDmRelay('wss://inbox.damus.io')).toBe(true);
  });

  it('drops loopback, private IPs and local names', () => {
    const bad = [
      'wss://127.0.0.1:7777',
      'wss://' + '[::1]',
      'wss://10.0.0.5',
      'wss://192.168.1.10',
      'wss://172.16.0.2',
      'wss://umbrel.local',
      'wss://guardian.lan',
      'wss://localhost',
      'ws://relay.example',
      // The guardian has no Tor: a .onion name would only leak to the DNS resolver (sweep 2 #18).
      'wss://inboxrelayexampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion',
      'wss://inbox.onion.',
    ];
    for (const u of bad) expect(isPublicDmRelay(u), u).toBe(false);
  });
});
