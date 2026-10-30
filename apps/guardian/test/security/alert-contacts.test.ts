/**
 * Security review 2026-10, finding 5 (MEDIUM, design): with no alert contact, a recovery's alerts go
 * only to the paired phone, so a phone-only thief can sweep the whole vault to a wallet of its own and
 * the only one told is the thief.
 *
 * Now: on mainnet the guardian refuses a pairing without an alert contact, and any rule change that
 * removes the last one (even with a hardware approval); on test networks it allows it and says so
 * (`warnings: ['no_alert_contacts']` in `policy.get`, `guardian.status` and the web API's status).
 * Regression tests from the reviewer's poc-engine.test.ts ("no alert contacts").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { MultisigWallet, NETWORKS, RECEIVE, buildSweep, cosignerKeyExpression } from '@trikey/core';
import {
  ClockChain,
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  approvalMessage,
  pairingMessage,
  signMessage,
  type Rules,
} from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { APP_NOSTR, CONTACT_A, COSIGNER_PRIV, DAY, DEFAULT_RULES, MNEMONICS, OTHER_COSIGNER_PRIV, T0, appSigner, fund, hwSigner, makeWallet, network, setup } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

const main = NETWORKS.bitcoin;
const MAIN_AUTH_PATH = "m/48'/0'/0'/2'/0/0";

/** A mainnet engine and wallet built from the published test mnemonics (throwaway keys; nothing is ever broadcast). */
async function mainnet() {
  const clock = new ManualClock(T0);
  const signer = new SoftwareCosignerSigner(COSIGNER_PRIV);
  const engine = await PolicyEngine.open({ store: new MemoryStore(), clock, signer, chain: new ClockChain(clock) });
  const wallet = new MultisigWallet(main, {
    app: await appSigner().getKey(main),
    hardware: await hwSigner().getKey(main),
    cosigner: cosignerKeyExpression(secp256k1.getPublicKey(COSIGNER_PRIV, true), randomBytes(32), main),
  });
  const authPriv = hwSigner().master(main).derive(MAIN_AUTH_PATH).privateKey!;
  const cosigner = hex.encode(signer.accountPubkey);
  const register = (rules: Rules) =>
    engine.register({
      network: 'bitcoin',
      descriptor: wallet.descriptor(),
      cosignerAccountPubkey: cosigner,
      rules,
      hardwareAuth: { kind: 'bip137', pubkey: hex.encode(secp256k1.getPublicKey(authPriv, true)), path: MAIN_AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), authPriv),
      appNostrPubkey: APP_NOSTR,
    });
  return { clock, engine, wallet, authPriv, register };
}

describe('security: alert contacts (finding 5)', () => {
  it('PoC on mainnet: a pairing with no alert contact is refused', async () => {
    const m = await mainnet();
    expect(await m.register({ ...DEFAULT_RULES, alertContacts: [] })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/at least one alert contact/) },
    });
    expect(await m.register(DEFAULT_RULES)).toMatchObject({ ok: true });
    expect(m.engine.status().warnings).toEqual([]);
  });

  it('on mainnet, removing the last contact is refused, from the phone or with a hardware approval', async () => {
    const m = await mainnet();
    expect((await m.register(DEFAULT_RULES)).ok).toBe(true);
    const none = { ...DEFAULT_RULES, alertContacts: [] };
    expect(await m.engine.changeRules(none, { authenticatedBy: 'app' })).toMatchObject({ ok: false, refusal: { reason: 'invalid_rules' } });
    const expiresAt = Math.floor(m.clock.now() / 1000) + 600;
    const approval = (rules: Rules) => ({
      kind: 'bip137',
      sequence: 1,
      expiresAt,
      signature: signMessage(approvalMessage({ action: 'policy', rules }, { walletId: m.wallet.fingerprint(), sequence: 1, expiresAt }), m.authPriv),
    });
    expect(await m.engine.changeRules(none, { authenticatedBy: 'hardware', approval: approval(none) })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_rules', detail: expect.stringMatching(/alert contact/) },
    });
    // Replacing the contact is fine.
    const other = { ...DEFAULT_RULES, alertContacts: [APP_NOSTR.replace(/^./, 'f')] };
    expect(await m.engine.changeRules(other, { authenticatedBy: 'hardware', approval: approval(other) })).toMatchObject({ ok: true });
  });

  it('PoC on regtest: allowed, but the status says alerts reach only the paired phone', async () => {
    const ctx = await setup({ rules: { alertContacts: [] } });
    expect(ctx.engine.status().warnings).toEqual(['no_alert_contacts']);
    // The reviewer's scenario still runs on a test network (by design), with that warning in front of the user.
    const dest = await makeWallet({ hardware: MNEMONICS.hardware2, cosignerPriv: OTHER_COSIGNER_PRIV });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 0, 5_000_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    expect(await ctx.engine.startRecovery({ psbt: await appSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR })).toMatchObject({ ok: true });
    expect(ctx.engine.dueAlerts().flatMap((a) => a.recipients)).toEqual([APP_NOSTR]);
    ctx.clock.advance(7 * DAY);
    // With a contact, the contact hears of it.
    const withContact = await setup();
    expect(withContact.engine.status().warnings).toEqual([]);
  });
});

describe('security: alert contacts (finding 5), protocol and web API', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('policy.get, guardian.status and GET /api/status carry the warning', async () => {
    rig = await GuardianRig.start({ http: true });
    await pairInRig(rig, { alertContacts: [] });
    expect(await callHandler(rig, 'policy.get', {})).toMatchObject({ warnings: ['no_alert_contacts'] });
    expect(await callHandler(rig, 'guardian.status', {})).toMatchObject({ warnings: ['no_alert_contacts'] });
    const status = await rig.api('GET', '/status');
    expect(status.body.warnings).toEqual(['no_alert_contacts']);
  }, 30_000);

  it('a wallet with a contact gets no warning', async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig, { alertContacts: [CONTACT_A] });
    expect(await callHandler(rig, 'policy.get', {})).not.toHaveProperty('warnings');
  }, 30_000);
});
