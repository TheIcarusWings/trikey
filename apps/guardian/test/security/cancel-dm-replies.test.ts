/**
 * Security sweep 2, finding 16 (LOW-MEDIUM): answers to `CANCEL` DMs were sent while the wallet's recovery mutex was
 * held, with no rate limit, and "fresh" had no upper bound. A contact (or a key a guest named as its contact) whose
 * kind-10050 relays answer slowly could send one `CANCEL <made-up id>` a second, dated in the future, and each answer
 * held the mutex for the publish: the wallet's recoveries (cancels, updates, completion) and, through the shared
 * mutex, the host's queued up behind them. Now the answer is decided under the mutex and sent after it, at most
 * `DEFAULT_CONTACT_REPLY_LIMIT` answers go to one sender, and only a message dated within 10 minutes of the guardian's
 * clock, either way, gets one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { onContactDm } from '../../src/dm-cancel.js';
import { DEFAULT_CONTACT_REPLY_LIMIT } from '../../src/rate-limit.js';
import { GuardianRig } from '../support/index.js';
import { CONTACT_A } from '../helpers.js';
import { pairInRig } from './support.js';

const FAKE_ID = '1-000000000000';

describe('security: CANCEL DM answers (finding 16)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('a slow answer does not hold the recovery mutex', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    let release!: () => void;
    const hanging = new Promise<void>((r) => (release = r));
    let sends = 0;
    g.dm!.send = async (_to, text) => {
      if (!text.includes('no running recovery')) return []; // other DMs (the pairing's notices to the contacts)
      sends++;
      await hanging; // a relay the contact chose that takes its time
      return [];
    };
    const handled = onContactDm(g, { sender: CONTACT_A, content: `CANCEL ${FAKE_ID}`, createdAt: rig.nowSec(), rumorId: 'a'.repeat(64) });
    // Wait until the answer is being sent.
    for (let i = 0; i < 100 && sends === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sends).toBe(1);
    // The mutex is free while it is: another recovery operation runs at once.
    const ran = await Promise.race([g.recoveryMutex.run(async () => 'ran'), new Promise((r) => setTimeout(() => r('blocked'), 500))]);
    expect(ran).toBe('ran');
    release();
    await handled;
  }, 30_000);

  it('answers to one sender are rate limited, and a message dated in the future gets none', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    const replies: string[] = [];
    g.dm!.send = async (to, text) => {
      if (to === CONTACT_A && text.includes(FAKE_ID)) replies.push(text);
      return [];
    };
    // Dated 30 days ahead: not "fresh", so no answer (it used to be fresh for ever).
    await onContactDm(g, { sender: CONTACT_A, content: `CANCEL ${FAKE_ID}`, createdAt: rig.nowSec() + 30 * 86_400, rumorId: 'b'.repeat(64) });
    expect(replies).toHaveLength(0);
    for (let i = 0; i < DEFAULT_CONTACT_REPLY_LIMIT.max + 20; i++)
      await onContactDm(g, { sender: CONTACT_A, content: `CANCEL ${FAKE_ID}`, createdAt: rig.nowSec(), rumorId: `${i}`.padStart(64, 'c') });
    expect(replies).toHaveLength(DEFAULT_CONTACT_REPLY_LIMIT.max);
    expect(replies[0]).toContain('there is no running recovery');
    // An hour later it answers again.
    rig.clock.advance(DEFAULT_CONTACT_REPLY_LIMIT.windowMs + 1);
    await onContactDm(g, { sender: CONTACT_A, content: `CANCEL ${FAKE_ID}`, createdAt: rig.nowSec(), rumorId: 'd'.repeat(64) });
    expect(replies).toHaveLength(DEFAULT_CONTACT_REPLY_LIMIT.max + 1);
  }, 30_000);
});
