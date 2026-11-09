/**
 * Security sweep 2, finding 20 (LOW): strangers could fill the guardian's log. Anyone with the guardian's npub could
 * send DMs reading `CANCEL <id>` (an INFO line each, and each took the wallet's recovery mutex and ran its alerts) or
 * bogus `recovery.access` requests (a WARN line each, once per wallet tried). On plain Docker's default log driver the
 * container log grows without limit, on the node's disk.
 *
 * Now a stranger's CANCEL DM is dropped before the mutex at debug level, and a refused `recovery.access` reaches the log
 * at most 20 times an hour; the next line after that says how many were left out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onContactDm } from '../../src/dm-cancel.js';
import { LogBudget } from '../../src/log.js';
import { GuardianRig } from '../support/index.js';
import { nostrKey } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

const STRANGER = nostrKey(77);

describe('security: strangers cannot fill the log (sweep 2 #20)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it("a stranger's CANCEL DMs leave no INFO line and never take the recovery mutex or run the alerts", async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    const mutex = vi.spyOn(g.recoveryMutex, 'run');
    const alerts = vi.spyOn(g.alerts, 'run');
    rig.logLines.length = 0;
    for (let i = 0; i < 50; i++) await onContactDm(g, { sender: STRANGER, content: `CANCEL 1-${'0'.repeat(12)}`, createdAt: rig.nowSec(), rumorId: `${i}`.padStart(64, 'e') });
    // At debug level only (the default level is INFO, so the container log gets nothing).
    expect(rig.logLines.filter((l) => l.includes('dm.cancel_ignored') && !l.includes(' DEBUG '))).toEqual([]);
    expect(mutex).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  }, 30_000);

  it("a stranger's refused recovery.access requests reach the log at most 20 times an hour, then are counted", async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    rig.logLines.length = 0;
    const bogus = { approval: { kind: 'bip137', expiresAt: rig.nowSec() + 600, signature: 'H'.padEnd(88, 'A') } };
    for (let i = 0; i < 50; i++) await expect(callHandler(rig, 'recovery.access', bogus, STRANGER)).rejects.toThrow();
    const lines = () => rig.logLines.filter((l) => l.includes('recovery.access_refused'));
    expect(lines()).toHaveLength(20);
    rig.clock.advance(3_600_001);
    await expect(callHandler(rig, 'recovery.access', bogus, STRANGER)).rejects.toThrow();
    expect(lines()).toHaveLength(21);
    expect(lines()[20]).toMatch(/suppressed=30/);
  }, 30_000);

  it('LogBudget: max lines per window and event, then a count on the next line', () => {
    let now = 1_000;
    const b = new LogBudget({ max: 2, windowMs: 100 }, () => now);
    expect(b.take('a', { x: 1 })).toEqual({ x: 1 });
    expect(b.take('a')).toEqual({});
    expect(b.take('a')).toBeUndefined();
    expect(b.take('b')).toEqual({}); // each event its own
    expect(b.take('a')).toBeUndefined();
    now += 101;
    expect(b.take('a', { x: 2 })).toEqual({ x: 2, suppressed: 2 });
    expect(b.take('a')).toEqual({});
  });
});
