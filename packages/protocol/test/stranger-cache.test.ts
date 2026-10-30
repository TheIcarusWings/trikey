/**
 * Security review 2026-10, finding 10a: strangers allowed to call a method (`recovery.access`, `pair`
 * during a pairing window) filled the replay guard and the response cache shared with the paired
 * phone, evicting its entries (so a relay re-delivering a phone's request could have it run again).
 * Strangers now get their own small, separately bounded guard and cache.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ReplayGuard, RpcServer, generateMessageId, openGiftWrap, wrapMessage, type Handlers, type RelayPool } from '../src/index.js';

const guardianSk = generateSecretKey();
const guardianPk = getPublicKey(guardianSk);
const phoneSk = generateSecretKey();
const phonePk = getPublicKey(phoneSk);

const pool = { subscribe: () => ({ close() {} }), publish: async () => [], close() {} } as unknown as RelayPool;
const open = (sk: Uint8Array, id: string) =>
  openGiftWrap(wrapMessage({ id, method: 'policy.get', params: {} }, { senderSecretKey: sk, recipient: guardianPk }).wrap, { recipientSecretKey: guardianSk });

function server() {
  let calls = 0;
  const handlers: Handlers = {
    'policy.get': () => {
      calls++;
      return { policy: { dailyLimitSats: 1, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 1 }, nextHardwareSequence: 1, policyHash: 'ab'.repeat(32) };
    },
  };
  const s = new RpcServer({
    pool,
    relays: ['wss://relay.invalid'],
    secretKey: guardianSk,
    handlers,
    authorize: () => true, // everyone may call it, like `recovery.access`
    isPeer: (sender) => sender === phonePk,
    guard: new ReplayGuard({ maxEntries: 50 }),
    strangerCacheSize: { guard: 20, responses: 5 },
    listen: false,
  });
  return { s, calls: () => calls };
}

describe('security: strangers have their own replay cache (finding 10a)', () => {
  it("a stranger's flood does not evict the paired phone's entries", async () => {
    const { s, calls } = server();
    const phoneId = generateMessageId();
    const phoneWrap = open(phoneSk, phoneId);
    await s.handleOpened(phoneWrap);
    expect(calls()).toBe(1);
    const stranger = generateSecretKey();
    for (let i = 0; i < 80; i++) await s.handleOpened(open(stranger, generateMessageId()));
    expect(s.guardSizes).toEqual({ peers: 1, strangers: 20 });
    // The phone's request re-delivered (another relay, a replay): still a duplicate, not run again.
    await s.handleOpened(phoneWrap);
    expect(calls()).toBe(81);
  });

  it('a request first seen from a stranger is still a duplicate once the sender became a peer', async () => {
    let peer = false;
    let calls = 0;
    const s = new RpcServer({
      pool,
      relays: ['wss://relay.invalid'],
      secretKey: guardianSk,
      handlers: { 'policy.get': () => (calls++, { policy: { dailyLimitSats: 1, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 1 }, nextHardwareSequence: 1, policyHash: 'ab'.repeat(32) }) },
      authorize: () => true,
      isPeer: () => peer,
      listen: false,
    });
    const wrap = open(phoneSk, generateMessageId());
    await s.handleOpened(wrap);
    peer = true; // e.g. the phone that just paired, retrying its `pair`
    await s.handleOpened(wrap);
    expect(calls).toBe(1);
  });
});
