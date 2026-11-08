/**
 * Security sweep 2 follow-up: a guardian that lists `sealed_unlock` refuses a cleartext `guardian.unlock` and
 * `unlock.hardware.add`. Up to 0.1.22 those were accepted and marked in the Activity; a thief with the disk and
 * archived wraps could then read the passphrase or slot signature from those wraps.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, RpcError } from '@trikey/protocol';
import { GuardianRig } from '../support/index.js';
import { callHandler, pairInRig } from './support.js';

describe('security: unsealed unlock and add are refused (sweep 2 follow-up)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('guardian.unlock with a passphrase in the clear is app_update_required', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    await rig.lock();
    await expect(callHandler(rig, 'guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError && e.code === ErrorCode.UnlockFailed && (e.data as { reason?: string })?.reason === 'app_update_required',
    );
    expect(rig.guardian.locked).toBe(true);
    expect(rig.logLines.some((l) => l.includes('guardian.unlock_unsealed') && l.includes('refused'))).toBe(true);
  }, 30_000);

  it('web unlock still works (never over the relays)', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    await rig.lock();
    await rig.unlock();
    expect(rig.guardian.locked).toBe(false);
  }, 30_000);
});
