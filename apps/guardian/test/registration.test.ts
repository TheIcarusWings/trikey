import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet } from '@trikey/core';
import {
  LIMIT_OFF_THRESHOLD_SATS,
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  pairingMessage,
  pairingRulesMessage,
  signMessage,
  RULES_APPROVAL_MISSING,
  type RegisterInput,
  type Rules,
} from '../src/policy/index.js';
import {
  APP_NOSTR,
  AUTH_PATH,
  COSIGNER_PRIV,
  DEFAULT_RULES,
  OTHER_COSIGNER_PRIV,
  T0,
  approve,
  approveRules,
  hwAuthPrivateKey,
  hwAuthPubkey,
  makeWallet,
  network,
  setup,
} from './helpers.js';

async function input(over: Partial<RegisterInput> = {}, authPath = AUTH_PATH): Promise<RegisterInput> {
  const wallet = await makeWallet();
  const cosignerHex = hex.encode(secp256k1.getPublicKey(COSIGNER_PRIV, true));
  const walletId = wallet.fingerprint();
  return {
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: cosignerHex,
    rules: DEFAULT_RULES,
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(authPath), path: authPath },
    hardwareAuthProof: signMessage(pairingMessage(walletId, cosignerHex), hwAuthPrivateKey(authPath)),
    rulesApproval: approveRules(walletId, over.rules ?? DEFAULT_RULES, T0, { privateKey: hwAuthPrivateKey(authPath) }),
    appNostrPubkey: APP_NOSTR,
    ...over,
  };
}

const walletIdOf = (i: RegisterInput) => MultisigWallet.fromDescriptor(i.descriptor, network).fingerprint();

const fresh = () =>
  PolicyEngine.open({ store: new MemoryStore(), clock: new ManualClock(T0), signer: new SoftwareCosignerSigner(COSIGNER_PRIV) });

describe('registration', () => {
  it('registers once and exposes the wallet id and rules', async () => {
    const ctx = await setup();
    expect(ctx.engine.status()).toMatchObject({ registered: true, walletId: ctx.walletId, network: 'regtest', phoneSpending: 'enabled' });
    expect(ctx.engine.registration()!.hardwareAuth!.path).toBe(AUTH_PATH);
    expect(await ctx.engine.register(await input())).toMatchObject({ ok: false, refusal: { reason: 'already_registered' } });
  });

  it('refuses a descriptor without the guardian key in the cosigner slot', async () => {
    const engine = await fresh();
    const other = hex.encode(secp256k1.getPublicKey(OTHER_COSIGNER_PRIV, true));
    expect(await engine.register(await input({ cosignerAccountPubkey: other }))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/cosigner slot/) },
    });
    expect(await engine.register(await input({ descriptor: 'wsh(multi(2,a,b))' }))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration' },
    });
    // A mainnet engine must not accept a testnet descriptor.
    expect(await engine.register(await input({ network: 'bitcoin' }))).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration' } });
  });

  it('refuses a pairing proof from the wrong key or over the wrong message', async () => {
    const engine = await fresh();
    const base = await input();
    const wrongKey = signMessage(pairingMessage(walletIdOf(base), base.cosignerAccountPubkey), secp256k1.utils.randomSecretKey());
    expect(await engine.register({ ...base, hardwareAuthProof: wrongKey })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/pairing proof/) },
    });
    const wrongMsg = signMessage('hello', hwAuthPrivateKey());
    expect(await engine.register({ ...base, hardwareAuthProof: wrongMsg })).toMatchObject({ ok: false });
    expect(await engine.register({ ...base, hardwareAuth: { kind: 'bip137', pubkey: '02zz', path: AUTH_PATH } })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/hardwareAuth/) },
    });
    expect(await engine.register({ ...base, appNostrPubkey: 'npub1xyz' })).toMatchObject({ ok: false });
    expect(engine.status().registered).toBe(false);
  });

  it('checks an authorization key below the hardware xpub against the descriptor', async () => {
    // Non-hardened child of the hardware wallet's BIP48 account: the guardian can derive it itself.
    const path = "m/48'/1'/0'/2'/7/0";
    const engine = await fresh();
    expect((await engine.register(await input({}, path))).ok).toBe(true);

    // A key that claims that path but is really some other key is refused.
    const engine2 = await fresh();
    const bogus = await input({}, path);
    const otherPriv = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).derive(path).privateKey!;
    const otherPub = hex.encode(secp256k1.getPublicKey(otherPriv, true));
    const res = await engine2.register({
      ...bogus,
      hardwareAuth: { kind: 'bip137', pubkey: otherPub, path },
      hardwareAuthProof: signMessage(pairingMessage(walletIdOf(bogus), bogus.cosignerAccountPubkey), otherPriv),
    });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/does not derive/) } });
  });
});

// Security review 2026-11 (pairing rules not hardware-approved): the hardware wallet signed only the pairing proof, which
// names no rule, and the guardian refused only "limit off" at pairing. A malicious app could pair with a limit just below
// "off" (or a huge fee cap, its own alert contact) and drain Spending with phone + guardian at once. The rules a wallet
// starts with now need the hardware wallet's signature over exactly those rules (rule 4), like any loosening.
describe('registration: the rules the wallet starts with are hardware-approved', () => {
  const MAX = 2_100_000_000_000_000n;
  // Just below "off" (1,000 BTC and more is off for every purpose, and refused at pairing whatever is approved).
  const DRAIN: Rules = { ...DEFAULT_RULES, dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS - 1n, sweepFeeCapSats: MAX };

  it('refuses a drain-everything limit without the approval (the attack), and stores nothing', async () => {
    const engine = await fresh();
    const { rulesApproval: _none, ...unapproved } = await input({ rules: DRAIN });
    const res = await engine.register(unapproved);
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: RULES_APPROVAL_MISSING } });
    expect(engine.status().registered).toBe(false);
  });

  it('refuses an approval over other rules: the device showed the reasonable ones, the app sent the drain', async () => {
    const engine = await fresh();
    const shown = await input();
    const res = await engine.register({ ...shown, rules: DRAIN });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    // Each rule the text or the hash covers: the limit, the delay, the fee cap, the contacts, the contact lock.
    for (const r of [
      { ...DEFAULT_RULES, dailyLimitSats: DEFAULT_RULES.dailyLimitSats + 1n },
      { ...DEFAULT_RULES, recoveryDelayDays: 30 as const },
      { ...DEFAULT_RULES, sweepFeeCapSats: DEFAULT_RULES.sweepFeeCapSats + 1n },
      { ...DEFAULT_RULES, alertContacts: [...DEFAULT_RULES.alertContacts, 'ee'.repeat(32)] },
      { ...DEFAULT_RULES, contactLock: true },
    ])
      expect(await engine.register({ ...shown, rules: r })).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(engine.status().registered).toBe(false);
  });

  it('refuses an approval by another key, for another wallet, as a later approval (seq 1), expired or too far ahead', async () => {
    const engine = await fresh();
    const base = await input();
    const walletId = walletIdOf(base);
    const other = await engine.register({ ...base, rulesApproval: approveRules(walletId, DEFAULT_RULES, T0, { privateKey: secp256k1.utils.randomSecretKey() }) });
    expect(other).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    const otherWallet = await engine.register({ ...base, rulesApproval: approveRules('0123456789abcdef', DEFAULT_RULES, T0) });
    expect(otherWallet).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    // A policy approval of a later change (seq=1) is not the pairing text (seq=0).
    const later = approve({ clock: new ManualClock(T0), walletId }, { action: 'policy', rules: DEFAULT_RULES }, 1);
    expect(await engine.register({ ...base, rulesApproval: { kind: 'bip137', expiresAt: later.expiresAt, signature: later.signature } })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_invalid_signature' },
    });
    expect(await engine.register({ ...base, rulesApproval: approveRules(walletId, DEFAULT_RULES, T0, { expiresInSec: 0 }) })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_expired' },
    });
    expect(await engine.register({ ...base, rulesApproval: approveRules(walletId, DEFAULT_RULES, T0, { expiresInSec: 24 * 3600 + 60 }) })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_expiry_too_far' },
    });
    expect(await engine.register({ ...base, rulesApproval: { ...base.rulesApproval!, kind: 'psbt' } })).toMatchObject({ ok: false, refusal: { reason: 'unsupported_approval' } });
    expect(engine.status().registered).toBe(false);
  });

  it('accepts hardware-approved rules, even loose ones, and stores exactly the rules the device signed', async () => {
    const engine = await fresh();
    const rules: Rules = { ...DRAIN, alertContacts: [DEFAULT_RULES.alertContacts[0]!.toUpperCase(), 'ee'.repeat(32)], recoveryDelayDays: 14 };
    const res = await engine.register(await input({ rules }));
    expect(res.ok).toBe(true);
    const stored = engine.status().rules!;
    expect(stored).toEqual({ ...DRAIN, recoveryDelayDays: 14, alertContacts: [DEFAULT_RULES.alertContacts[0]!.toLowerCase(), 'ee'.repeat(32)].sort() });
    // The text the device showed is the one the guardian rebuilds from what it stores.
    const base = await input({ rules });
    expect(pairingRulesMessage(stored, { walletId: walletIdOf(base), expiresAt: base.rulesApproval!.expiresAt })).toMatch(/^Trikey policy v1 wallet=[0-9a-f]{16} seq=0 limit=99999999999 /);
  });

  it('still refuses "no daily limit" at pairing, even hardware-approved', async () => {
    const engine = await fresh();
    const res = await engine.register(await input({ rules: { ...DEFAULT_RULES, dailyLimitSats: MAX } }));
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/daily limit off/) } });
  });

  it('never lets the pairing approval count later: no sequence is consumed, and seq 0 is below every later approval', async () => {
    const ctx = await setup();
    expect(ctx.engine.status().nextHardwareSequence).toBe(1);
    // The same signature replayed as a policy change, at sequence 0 (stale) or any later one (another text).
    const pairing = approveRules(ctx.walletId, DRAIN, ctx.clock.now());
    for (const sequence of [0, 1, 2]) {
      const res = await ctx.engine.changeRules(DRAIN, { authenticatedBy: 'hardware', approval: { kind: 'bip137', sequence, expiresAt: pairing.expiresAt, signature: pairing.signature } });
      expect(res).toMatchObject({ ok: false, refusal: { reason: sequence === 0 ? 'approval_stale_sequence' : 'approval_invalid_signature' } });
    }
    expect(ctx.engine.status().rules!.dailyLimitSats).toBe(DEFAULT_RULES.dailyLimitSats);
  });

  it('with legacyUnapprovedRules (a service that does not report pairing_rules_approval, tests only) accepts rules as before', async () => {
    const engine = await fresh();
    const { rulesApproval: _none, ...unapproved } = await input();
    expect((await engine.register({ ...unapproved, legacyUnapprovedRules: true })).ok).toBe(true);
  });
});
