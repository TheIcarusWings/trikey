/**
 * Sealed unlock from the phone (PROTOCOL.md, "Sealed unlock"), end to end against the real guardian service in-process
 * (`@trikey/guardian/testing`), a software hardware wallet over in-memory relays, regtest, throwaway keys:
 *
 * - to a guardian with `sealed_unlock` the passphrase and the hardware signature go sealed: the relays' wraps, opened
 *   with the guardian's nostr key (what a thief with its disk could do), do not show them;
 * - a stale unlock key (the guardian locked again between the phone's read and its send) is read again and the unlock
 *   sent once more, without asking the hardware wallet again; stale twice comes back as a refusal;
 * - a wrong passphrase is a refusal as before, and the next try works (the key the guardian replaced is read again);
 * - to a guardian without the feature the phone sends in the clear, as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { GuardianRig } from '@trikey/guardian/testing';
import { GUARDIAN_FEATURES, openGiftWrap, unlockKeyMessage, type Policy } from '@trikey/protocol';
import { TrikeyWallet } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
let rig: GuardianRig;
let p: Phone;
let A: TrikeyWallet;
const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;

/** Every wrap to the guardian on the relays, opened with its nostr key: what its disk plus a relay's archive reveal. */
function archive(): string {
  const out: string[] = [];
  for (const relay of rig.relays)
    for (const ev of relay.events.values()) {
      try {
        out.push(JSON.stringify(openGiftWrap(ev, { recipientSecretKey: rig.guardian.identity!.secretKey, conversationKeys: null })));
      } catch {
        // not to the guardian
      }
    }
  return out.join('\n');
}

/** The hardware wallet's signature of the current slot's text (deterministic: the device makes the same one again). */
async function slotSignature(): Promise<string> {
  const slot = A.state.guardianStatus!.hardwareUnlock!.slot;
  const n = device.calls.length;
  const sig = await device.signMessage(A.state.hardware!.auth.path, unlockKeyMessage({ walletId: A.state.wallet!.walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot }));
  device.calls.splice(n);
  return sig;
}

beforeAll(async () => {
  rig = await GuardianRig.start({ passphrase: 'wallet test passphrase 7' });
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  A = await TrikeyWallet.create(p.deps, { deviceName: 'Sealed unlock phone' });
  await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  await A.refreshStatus();
  await A.enableHardwareUnlock();
}, 30_000);

afterAll(async () => {
  await A?.close().catch(() => undefined);
  await rig?.stop();
});

describe('sealed unlock from the phone', { timeout: 60_000 }, () => {
  it('the passphrase goes sealed: unlocked, and nowhere in the archive', async () => {
    expect(A.state.guardianStatus!.features).toContain(GUARDIAN_FEATURES.sealedUnlock);
    await A.lockGuardian();
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(rig.guardian.service.get().activity.at(-1)).toEqual(expect.objectContaining({ type: 'unlocked', via: 'phone' }));
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');
    expect(archive()).toContain('\\"kind\\":\\"sealed\\"');
    expect(archive()).not.toContain(rig.passphrase);
    // The phone keeps no unlock key either (it changes at every lock).
    expect(JSON.stringify(A.state.guardianStatus)).not.toContain('unlockKey');
  });

  it('after a restart: the hardware signature goes sealed, one device confirmation, nowhere in an unlock wrap', async () => {
    await rig.restart();
    const before = signs();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    expect(signs() - before).toBe(1);
    expect(rig.guardian.service.get().activity.at(-1)).toMatchObject({ type: 'unlocked', method: 'hardware' });
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');
    const sig = await slotSignature();
    // Only `unlock.hardware.add` (sent while unlocked, when there is no unlock key) carries it: DESIGN.md, what remains.
    for (const line of archive().split('\n').filter((l) => l.includes(sig))) expect(line).toContain('unlock.hardware.add');
    expect(archive().split('\n').filter((l) => l.includes('guardian.unlock')).some((l) => l.includes(sig))).toBe(false);
  });

  it('a stale unlock key is read again and the unlock sent once more, without asking the device again', async () => {
    await A.lockGuardian();
    const g = rig.guardian;
    const real = g.currentUnlockKey.bind(g);
    // The first status read shows a key the guardian does not hold, as if it locked again right after answering.
    let reads = 0;
    g.currentUnlockKey = () => (reads++ === 0 ? getPublicKey(generateSecretKey()) : real());
    try {
      const before = signs();
      expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
      expect(signs() - before).toBe(1);
      expect(reads).toBeGreaterThan(1);
      expect(g.phoneThrottle.failures).toBe(0);
      expect(rig.logLines.filter((l) => l.includes('guardian.unlock_key_stale')).length).toBe(1);
    } finally {
      g.currentUnlockKey = real;
    }
  });

  it('stale twice: a refusal (not counted), and the passphrase works on the next try', async () => {
    await A.lockGuardian();
    const g = rig.guardian;
    const real = g.currentUnlockKey.bind(g);
    g.currentUnlockKey = () => getPublicKey(generateSecretKey());
    try {
      expect(await A.unlockGuardian(rig.passphrase)).toMatchObject({ ok: false, refusal: { kind: 'unlock_failed', reason: 'unlock_key_stale' } });
      expect(g.phoneThrottle.failures).toBe(0);
      expect(g.locked).toBe(true);
    } finally {
      g.currentUnlockKey = real;
    }
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
  });

  it('a wrong passphrase is refused as before; the guardian replaces its key, and the next try reads the new one', async () => {
    await A.lockGuardian();
    const key = rig.guardian.unlockKey.pubkey;
    expect(await A.unlockGuardian('not the passphrase')).toMatchObject({ ok: false, refusal: { kind: 'unlock_failed' } });
    expect(rig.guardian.phoneThrottle.failures).toBe(1);
    expect(rig.guardian.unlockKey.pubkey).not.toBe(key);
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.phoneThrottle.failures).toBe(0);
    expect(archive()).not.toContain('not the passphrase');
  });

  it('a guardian without sealed_unlock gets the passphrase in the clear, as before', async () => {
    const features = rig.guardian.features;
    rig.guardian.features = features.filter((f) => f !== GUARDIAN_FEATURES.sealedUnlock);
    try {
      await A.lockGuardian();
      expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
      expect(archive()).toContain(rig.passphrase);
    } finally {
      rig.guardian.features = features;
    }
  });
});
