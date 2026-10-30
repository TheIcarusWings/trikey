/**
 * Security review 2026-10, finding 10a (LOW/INFO): strangers could fill the guardian's caches.
 *
 * - The inbox's seen-wrap set was shared by everyone: a stranger's flood of wraps pushed a paired
 *   phone's wrap ids out, so the same wrap (from another relay) was opened and handled again. Now
 *   strangers' wraps (and wraps that do not open) go to a small set of their own.
 * - `pair` spam during a pairing window cost a durable write each (the replay record) before the
 *   secret was checked. Now a wrong secret is refused first, without touching the disk.
 *
 * The RPC server's replay guard and response cache are split the same way (packages/protocol,
 * test/stranger-cache.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ErrorCode, RpcError, generateMessageId, wrapMessage, type NostrEvent, type RelayPool } from '@trikey/protocol';
import { Inbox } from '../../src/nostr/inbox.js';
import { GuardianRig } from '../support/index.js';
import { nostrKey } from '../helpers.js';
import { callHandler } from './support.js';

describe('security: strangers flooding the guardian (finding 10a)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it("a flood of strangers' wraps does not make a paired phone's wrap be handled twice", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const phoneSk = generateSecretKey();
    const phonePk = getPublicKey(phoneSk);
    let deliver: (e: NostrEvent) => void = () => {};
    const pool = {
      subscribe: (_r: string[], _f: unknown, h: { onevent: (e: NostrEvent) => void; oneose?: () => void }) => {
        deliver = h.onevent;
        h.oneose?.();
        return { close() {} };
      },
      publish: async () => [],
      close() {},
    } as unknown as RelayPool;
    let rpcs = 0;
    const inbox = new Inbox({ pool, relays: ['wss://relay.invalid'], secretKey: sk, pubkey: pk, now: () => Math.floor(Date.now() / 1000), onRpc: () => void rpcs++, onDm: () => {}, isPeer: (s) => s === phonePk });
    await inbox.start();
    const { wrap } = wrapMessage({ id: generateMessageId(), method: 'guardian.status', params: {} }, { senderSecretKey: phoneSk, recipient: pk });
    deliver(wrap);
    await inbox.drain();
    expect(rpcs).toBe(1);
    // 5000 junk wraps with fresh ids (cheap to make, each one "seen").
    for (let i = 0; i < 5000; i++) deliver({ ...wrap, id: i.toString(16).padStart(64, '0'), sig: '00'.repeat(64) });
    await inbox.drain();
    // The phone's wrap arrives again from another relay: not opened again.
    deliver(wrap);
    await inbox.drain();
    expect(rpcs).toBe(1);
    inbox.close();
  });

  it('pair spam with a wrong secret during a pairing window writes nothing', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    rig.pairingUri(); // a pairing window is open
    const before = g.service.get().requests.length;
    for (let i = 0; i < 3; i++) {
      await expect(callHandler(rig, 'pair', { pairingSecret: 'W'.repeat(43) }, nostrKey(60 + i))).rejects.toSatisfy(
        (e: unknown) => e instanceof RpcError && e.code === ErrorCode.PairingRejected,
      );
    }
    expect(g.service.get().requests.length).toBe(before);
  }, 30_000);
});
