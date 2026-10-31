/**
 * "No daily limit" in the app's state, from the real wallet service against the real guardian in-process (regtest,
 * throwaway keys): the guardian says it can (`dailyLimit.canTurnOff`), turning it off asks the hardware wallet with a
 * text that says `limit=off`, the state says `off` (Home's line, the Settings row, the send pill read it) and the
 * activity has the change; turning it back on works from the phone alone, at the limit it had. A guardian that does
 * not report the feature is not offered it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { LIMIT_OFF_SATS as PROTOCOL_LIMIT_OFF } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { formatDailyLimit } from './format';
import { createRealWalletService, type RealWalletService } from './real';
import { LIMIT_OFF_SATS, canOfferLimitOff, limitIsOff, limitToRestore } from './rules';
import type { DevicePrompt } from './types';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const TO = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true), NETWORKS.regtest.btc).address!;
let rig: GuardianRig;
let svc: RealWalletService;
const prompts: DevicePrompt[] = [];

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [provider],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  svc.prompts.subscribe(() => {
    const p = svc.prompts.getSnapshot();
    if (p) prompts.push(p);
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 900_000n);
  await svc.sync();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

describe('no daily limit in the app', { timeout: 120_000 }, () => {
  it('is the protocol value, and the guardian says it can do it', () => {
    expect(LIMIT_OFF_SATS).toBe(PROTOCOL_LIMIT_OFF);
    const s = svc.getState();
    expect(s.dailyLimit).toMatchObject({ limitSats: 100_000, canTurnOff: true });
    expect(s.dailyLimit.off).toBeUndefined();
    expect(limitIsOff(s)).toBe(false);
    expect(canOfferLimitOff(s)).toBe(true);
    expect(formatDailyLimit(s.dailyLimit)).toBe('100,000 sats');
  });

  it('turns it off with the hardware wallet (the text says limit=off); the state and the activity say so', async () => {
    const signs = device.calls.filter((c) => c.op === 'signMessage').length;
    await svc.turnLimitOff();
    expect(device.calls.filter((c) => c.op === 'signMessage').length).toBe(signs + 1);
    expect(prompts.some((p) => /Trikey policy v2 wallet=[0-9a-f]{16} seq=\d+ limit=off /.test(p.detail ?? ''))).toBe(true);
    expect(rig.guardian.engine.status().dailyLimit).toMatchObject({ off: true, limitBeforeOff: 100_000n });

    const s = svc.getState();
    expect(s.dailyLimit).toMatchObject({ off: true, limitSats: LIMIT_OFF_SATS, limitBeforeOffSats: 100_000 });
    expect(limitIsOff(s)).toBe(true);
    expect(canOfferLimitOff(s)).toBe(false);
    expect(formatDailyLimit(s.dailyLimit)).toBe('No daily limit');
    expect(limitToRestore(s.dailyLimit)).toBe(100_000);
    expect(s.activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'limit-off' }) }));

    // Phone + guardian for more than the old limit.
    const q = svc.quoteSend({ address: TO, amountSats: 300_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
  });

  it('turns it back on from the phone alone, at the limit it had', async () => {
    const signs = device.calls.filter((c) => c.op === 'signMessage').length;
    await svc.setDailyLimit(limitToRestore(svc.getState().dailyLimit));
    expect(device.calls.filter((c) => c.op === 'signMessage').length).toBe(signs);
    const s = svc.getState();
    expect(s.dailyLimit).toMatchObject({ limitSats: 100_000, canTurnOff: true });
    expect(s.dailyLimit.off).toBeUndefined();
    expect(rig.guardian.engine.status().dailyLimit).toMatchObject({ limit: 100_000n });
    expect(s.activity).toContainEqual(expect.objectContaining({ type: 'security', event: expect.objectContaining({ kind: 'limit-on', limitSats: 100_000 }) }));
    const q = svc.quoteSend({ address: TO, amountSats: 300_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'over-limit' } } });
  });

  it('a guardian without the feature is not offered it, and asking anyway asks nothing of the hardware wallet', async () => {
    rig.guardian.features = [];
    try {
      await svc.sync();
      expect(svc.getState().dailyLimit.canTurnOff).toBeUndefined();
      expect(canOfferLimitOff(svc.getState())).toBe(false);
      const signs = device.calls.filter((c) => c.op === 'signMessage').length;
      expect(await failure(svc.turnLimitOff())).toMatchObject({ kind: 'not_available', message: expect.stringMatching(/Update the guardian/) });
      expect(device.calls.filter((c) => c.op === 'signMessage').length).toBe(signs);
      expect(svc.getState().dailyLimit.off).toBeUndefined();
    } finally {
      rig.guardian.features = ['limit_off'];
    }
  });
});
