/**
 * The rules a wallet starts with, approved on the hardware wallet (security review 2026-11; DESIGN.md, rule 4), from the
 * phone's side, against the real guardian service in-process with a software hardware wallet (regtest, throwaway keys):
 *
 * - with a guardian that reports `pairing_rules_approval`, pairing asks the device for one more signature: the policy text
 *   with `seq=0` over the rules the owner chose, which the device shows, and the guardian stores exactly those rules;
 * - with a guardian from before (simulated), the phone sends no approval (its strict schema would refuse the member) and
 *   pairs as before;
 * - the approval is no later approval: the next hardware approval still uses sequence 1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUARDIAN_FEATURES, policyHash, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone } from './helpers.js';

const CONTACT = 'a1'.repeat(32);
const RULES: Policy = { dailyLimitSats: 150_000, recoveryDelayDays: 14, alertContacts: [CONTACT], sweepFeeCapSats: 25_000 };

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const rigs: GuardianRig[] = [];
const wallets: TrikeyWallet[] = [];
afterAll(async () => {
  for (const w of wallets) await w.close().catch(() => undefined);
  for (const r of rigs) await r.stop();
});

const ruleSigns = (d: SoftwareHardwareSigner) => d.calls.flatMap((c) => (c.op === 'signMessage' && c.context?.purpose === 'rules' ? [c.message] : []));

describe('pairing: the device approves the rules the wallet starts with', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  beforeAll(async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
  }, 30_000);

  it('signs the policy text with seq=0 over exactly the chosen rules; the guardian keeps them', async () => {
    const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
    const w = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps, { deviceName: 'Rules phone' });
    wallets.push(w);
    const events: WalletEvent[] = [];
    w.on((e) => events.push(e));
    await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    const walletId = w.state.wallet!.walletId;
    const texts = ruleSigns(device);
    expect(texts).toEqual([
      `Trikey policy v1 wallet=${walletId} seq=0 limit=150000 delay=14d feecap=25000 contacts=1 hash=${policyHash(RULES)} expires=${texts[0]!.match(/expires=(\S+)$/)![1]}`,
    ]);
    // The phone shows it too (the hardware prompt), and the device is asked for it as "rules".
    expect(events.some((e) => e.type === 'hardware_prompt' && e.purpose === 'rules' && e.text === texts[0])).toBe(true);
    expect(rig.guardian.engine.status().rules).toEqual({ ...RULES, dailyLimitSats: 150_000n, sweepFeeCapSats: 25_000n });
    // The next hardware approval is still the first: pairing consumed no sequence.
    expect((await w.refreshStatus()).nextHardwareSequence).toBe(1);
  });
});

describe('pairing with a guardian from before pairing_rules_approval (simulated)', { timeout: 60_000 }, () => {
  it('sends no approval and pairs as before', async () => {
    const rig = await GuardianRig.start();
    rigs.push(rig);
    rig.guardian.features = rig.guardian.features.filter((f) => f !== GUARDIAN_FEATURES.pairingRulesApproval);
    const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
    const w = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps, { deviceName: 'Old guardian phone' });
    wallets.push(w);
    await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    expect(ruleSigns(device)).toEqual([]);
    expect(device.calls.filter((c) => c.op === 'signMessage').map((c) => (c.op === 'signMessage' ? c.context?.purpose : undefined))).toEqual(['pairing']);
    expect(rig.guardian.engine.status().rules!.dailyLimitSats).toBe(150_000n);
  });
});
