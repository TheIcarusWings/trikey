/**
 * Security sweep 2, finding 13 (MEDIUM): every state-changing request was written to disk (the durable request record:
 * the whole service state rewritten and fsync'd) before it was checked or rate limited. An alert contact (who may only
 * cancel), a guest phone or a key a guest named as its contact could send `recovery.cancel` for a made-up id as fast as
 * the relays take it: each one a full durable write before the 1300 answer, wearing the box's disk and queueing the
 * owner's own writes (a `LOCK`, a cancel) behind them. A refused `recovery.start` from a sender already over its
 * refusal limit was still written first.
 *
 * Now a request is checked first (a cancel or an update must name the running recovery; the refusal limit), then
 * counted against a per-sender limit of recorded requests (`DEFAULT_REQUEST_WRITE_LIMIT`), and only then recorded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { getPublicKey } from 'nostr-tools/pure';
import { ErrorCode, RpcError, decodeInviteUri } from '@trikey/protocol';
import { DEFAULT_REFUSAL_LIMIT, DEFAULT_REQUEST_WRITE_LIMIT } from '../../src/rate-limit.js';
import { GuardianRig } from '../support/index.js';
import { fakeMap, hostedWallet, withHostedRulesApproval } from '../support/hosted.js';
import { APP_NOSTR, CONTACT_A, CONTACT_B, MNEMONICS } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

const code = (c: number) => (e: unknown) => e instanceof RpcError && e.code === c;

describe('security: state-changing requests are checked before they are written (finding 13)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it("a contact's cancels of a recovery that is not running write nothing", async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    const before = g.service.get().requests.length;
    for (let i = 0; i < 20; i++)
      await expect(callHandler(rig, 'recovery.cancel', { recoveryId: `1-${i.toString(16).padStart(12, '0')}` }, CONTACT_A)).rejects.toSatisfy(code(ErrorCode.RecoveryNotFound));
    expect(g.service.get().requests.length).toBe(before);
  }, 30_000);

  it('a recovery.start from a sender over its refusal limit is refused before it is written', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    for (let i = 0; i < DEFAULT_REFUSAL_LIMIT.max; i++) g.refusalLimiter.take(APP_NOSTR, g.clock.now());
    const before = g.service.get().requests.length;
    await expect(callHandler(rig, 'recovery.start', { sweepPsbt: 'AA==', survivingKey: 'app' })).rejects.toSatisfy(code(ErrorCode.RateLimited));
    expect(g.service.get().requests.length).toBe(before);
  }, 30_000);

  it('each sender has a limit of recorded requests; past it nothing is written', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    for (let i = 0; i < DEFAULT_REQUEST_WRITE_LIMIT.max; i++) await callHandler(rig, 'guardian.lock', {});
    const before = g.service.get().requests.length;
    await expect(callHandler(rig, 'guardian.lock', {})).rejects.toSatisfy(code(ErrorCode.RateLimited));
    expect(g.service.get().requests.length).toBe(before);
    // Per sender: another sender is not held up.
    expect(g.requestWriteLimiter.blocked(CONTACT_B, g.clock.now()).ok).toBe(true);
  }, 60_000);

  it("a guest's (and a guest contact's) cancels of a recovery that is not running write nothing", async () => {
    rig = await GuardianRig.start({ http: true });
    await pairInRig(rig);
    const g = rig.guardian;
    const invite = await rig.api('POST', '/hosting/invites', { name: 'Dad' });
    const secret = decodeInviteUri(invite.body.link, rig.nowSec()).secret;
    const guestKey = new Uint8Array(32).fill(77);
    const guest = getPublicKey(guestKey);
    const prep = await callHandler(rig, 'hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: hex.encode(new Uint8Array(32).map((_, i) => i + 5)) }, guest);
    const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app, hardware: MNEMONICS.hardware2 });
    const rules = { dailyLimitSats: 100_000, recoveryDelayDays: 7 as const, alertContacts: [CONTACT_B], sweepFeeCapSats: 20_000 };
    await callHandler(
      rig,
      'hosted.pair',
      withHostedRulesApproval(
        {
          inviteSecret: secret,
          deviceName: 'Dad phone',
          walletLabel: 'Dad',
          network: 'regtest',
          accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
          hardwareAuth: fx.hardwareAuth,
          hardwareAuthProof: fx.proof,
          rules,
          walletMap: fakeMap(),
          phoneNostrPubkey: guest,
        },
        fx,
        rig.nowSec() * 1000,
      ),
      guest,
    );
    const slotId = g.hosting.liveSlots()[0]!.slot.slotId;
    const before = g.service.get().requests.length;
    for (const sender of [guest, CONTACT_B])
      for (let i = 0; i < 10; i++)
        await expect(callHandler(rig, 'recovery.cancel', { recoveryId: `${slotId}g1-${i.toString(16).padStart(12, '0')}` }, sender)).rejects.toSatisfy(code(ErrorCode.RecoveryNotFound));
    expect(g.service.get().requests.length).toBe(before);
  }, 60_000);
});
