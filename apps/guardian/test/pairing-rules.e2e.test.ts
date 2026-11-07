/**
 * Security review 2026-11, "pairing rules are not hardware-approved", end to end over nostr with the real guardian.
 *
 * The hardware wallet used to sign only the pairing proof (`Trikey pair v1 wallet=<id> guardian=<hex>`), which names no
 * rule, and the guardian refused only "no daily limit" at pairing. A malicious app build could pair (`pair`), add a wallet
 * (`wallet.add`) or accept an invite (`hosted.pair`) with a daily limit of `LIMIT_OFF_SATS - 1`, a huge fee cap or its own
 * alert contact, then drain the wallet with phone + guardian at once: rule 4 (loosening needs the hardware wallet) did not
 * cover the rules a wallet starts with. Now the device also signs those rules (`pairingRulesMessage`, the policy text with
 * `seq=0`), and a guardian with `pairing_rules_approval` refuses rules without that signature over exactly them.
 * Regtest, throwaway keys and the published BIP 39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  GUARDIAN_FEATURES,
  LIMIT_OFF_SATS,
  LIMIT_OFF_THRESHOLD_SATS,
  RpcClient,
  RpcError,
  SimplePoolRelayPool,
  decodeInviteUri,
  decodePairingUri,
  pairingMessage,
  pairingRulesMessage,
  type Policy,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, appSigner, approveRules, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { fakeMap, hostedWallet } from './support/hosted.js';
import { GuardianRig } from './support/index.js';

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

const CONTACT = getPublicKey(new Uint8Array(32).fill(61));
const ATTACKER_CONTACT = getPublicKey(new Uint8Array(32).fill(66));
/** What the owner chose and the device showed. */
const SHOWN: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [CONTACT], sweepFeeCapSats: 20_000 };
/** What a malicious app sends instead: everything but "off", a huge fee cap, the shortest delay, its own contact. */
// Just below "off" (1,000 BTC and more is off for every purpose, and refused at pairing whatever is approved).
const DRAIN: Policy = { dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS - 1, recoveryDelayDays: 7, alertContacts: [ATTACKER_CONTACT], sweepFeeCapSats: LIMIT_OFF_SATS };

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({ fingerprint: k.fingerprint, originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: k.xpub });
const rawPub = (xpub: string) => hex.encode(HDKey.fromExtendedKey(xpub, network.bip32).publicKey!);

const rigs: GuardianRig[] = [];
const pool = new SimplePoolRelayPool();
const clients: RpcClient[] = [];
afterAll(async () => {
  for (const c of clients) c.close();
  pool.close();
  for (const r of rigs) await r.stop();
});

function phoneOn(rig: GuardianRig, key = generateSecretKey()) {
  const rpc = new RpcClient({ pool, relays: rig.guardian.service.get().relays, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  return { key, pubkey: getPublicKey(key), rpc };
}
type Phone = ReturnType<typeof phoneOn>;

/** `pair` params for this phone's wallet with the guardian's key 3, the pairing proof signed, no rules approval yet. */
async function pairParams(rig: GuardianRig, phone: Phone, rules: Policy, opts: { feature?: boolean } = {}) {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  if (opts.feature === false) expect(prep.features).not.toContain(GUARDIAN_FEATURES.pairingRulesApproval);
  else expect(prep.features).toContain(GUARDIAN_FEATURES.pairingRulesApproval);
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner: toKey(prep.guardianKey) });
  const app = wallet.keys.app;
  const walletId = wallet.fingerprint();
  return {
    walletId,
    params: {
      pairingSecret: p.secret,
      deviceName: 'Test phone',
      network: 'regtest' as const,
      phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
      descriptor: wallet.descriptor(),
      phoneNostrPubkey: phone.pubkey,
      hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(walletId, rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey()),
      rules,
    },
  };
}

describe('pair: the rules a wallet starts with need the hardware wallet', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;

  beforeAll(async () => {
    rig = await GuardianRig.start({ http: true });
    rigs.push(rig);
    phone = phoneOn(rig);
  }, 30_000);

  it('an app from before (no rulesApproval) is told to update, and nothing is paired', async () => {
    const { params } = await pairParams(rig, phone, SHOWN);
    const e = await rpcError(phone.rpc.call('pair', params));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.data).toEqual({ reason: 'app_update_required' });
    expect(e.message).toMatch(/Update the Trikey app/);
    expect(rig.guardian.engine.registration()).toBeUndefined();
  });

  it('the attack: a drain-everything policy with no approval, or with the approval of the rules the device showed, is refused', async () => {
    const { params, walletId } = await pairParams(rig, phone, DRAIN);
    expect((await rpcError(phone.rpc.call('pair', params))).data).toEqual({ reason: 'app_update_required' });
    const shown = approveRules(walletId, SHOWN, rig.clock.now());
    const e = await rpcError(phone.rpc.call('pair', { ...params, rulesApproval: shown }));
    expect(e.code).toBe(ErrorCode.ApprovalInvalid);
    expect(rig.guardian.engine.registration()).toBeUndefined();
    // Nor does a signature of the drain over another wallet id, or by another key.
    const otherWallet = approveRules('0123456789abcdef', DRAIN, rig.clock.now());
    expect((await rpcError(phone.rpc.call('pair', { ...params, rulesApproval: otherWallet }))).code).toBe(ErrorCode.ApprovalInvalid);
    const otherKey = approveRules(walletId, DRAIN, rig.clock.now(), { privateKey: hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2) });
    expect((await rpcError(phone.rpc.call('pair', { ...params, rulesApproval: otherKey }))).code).toBe(ErrorCode.ApprovalInvalid);
    expect(rig.guardian.engine.registration()).toBeUndefined();
  });

  it('pairs with the approved rules, stores exactly them, and the approval is worth nothing afterwards', async () => {
    const { params, walletId } = await pairParams(rig, phone, SHOWN);
    const approval = approveRules(walletId, SHOWN, rig.clock.now());
    // What the device signed: the policy text with seq=0.
    expect(pairingRulesMessage(SHOWN, { walletId, expiresAt: approval.expiresAt })).toMatch(new RegExp(`^Trikey policy v1 wallet=${walletId} seq=0 limit=100000 delay=7d feecap=20000 contacts=1 hash=`));
    const res = await phone.rpc.call('pair', { ...params, rulesApproval: approval });
    expect(res.walletId).toBe(walletId);
    const got = await phone.rpc.call('policy.get', {});
    expect(got.policy).toEqual(SHOWN);
    expect(got.nextHardwareSequence).toBe(1);
    // Replayed as a later approval: sequence 0 is not a valid approval at all (the schema), and at 1 the text differs.
    await expect(phone.rpc.call('policy.update', { policy: SHOWN, approval: { ...approval, sequence: 0 } } as never)).rejects.toThrow();
    const e = await rpcError(phone.rpc.call('policy.update', { policy: SHOWN, approval: { ...approval, sequence: 1 } }));
    expect(e.code).toBe(ErrorCode.ApprovalInvalid);
    expect((await phone.rpc.call('policy.get', {})).nextHardwareSequence).toBe(1);
  });

  it('wallet.add: the same, for the new wallet and its own hardware wallet', async () => {
    const HW2 = MNEMONICS.hardware2;
    const prep = await phone.rpc.call('wallet.add.prepare', { account: 2 });
    const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network, 2), hardware: await hwSigner(HW2).getKey(network), cosigner: toKey(prep.guardianKey) });
    const walletId = wallet.fingerprint();
    const params = {
      account: 2,
      name: 'Business',
      descriptor: wallet.descriptor(),
      hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, HW2), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(walletId, rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, HW2)),
      rules: DRAIN,
    };
    const old = await rpcError(phone.rpc.call('wallet.add', params));
    expect(old.code).toBe(ErrorCode.InvalidParams);
    expect(old.data).toEqual({ reason: 'app_update_required' });
    const shown = approveRules(walletId, SHOWN, rig.clock.now(), { privateKey: hwAuthPrivateKey(AUTH_PATH, HW2) });
    expect((await rpcError(phone.rpc.call('wallet.add', { ...params, rulesApproval: shown }))).code).toBe(ErrorCode.ApprovalInvalid);
    // The first wallet's hardware wallet cannot approve the new wallet's rules.
    const firstDevice = approveRules(walletId, DRAIN, rig.clock.now());
    expect((await rpcError(phone.rpc.call('wallet.add', { ...params, rulesApproval: firstDevice }))).code).toBe(ErrorCode.ApprovalInvalid);
    expect((await phone.rpc.call('guardian.status', {})).wallets).toBeUndefined();
    const res = await phone.rpc.call('wallet.add', { ...params, rules: SHOWN, rulesApproval: shown });
    expect(res.walletId).toBe(walletId);
    expect((await phone.rpc.call('policy.get', { walletId })).policy).toEqual(SHOWN);
  });
});

describe('hosted.pair: a guest\'s rules need the guest\'s hardware wallet', { timeout: 60_000 }, () => {
  it('refuses no approval (update the app) and an approval of other rules; accepts the approved rules', async () => {
    const rig = await GuardianRig.start({ http: true });
    rigs.push(rig);
    // The host pairs its own wallet first.
    const host = phoneOn(rig);
    const { params, walletId } = await pairParams(rig, host, SHOWN);
    await host.rpc.call('pair', { ...params, rulesApproval: approveRules(walletId, SHOWN, rig.clock.now()) });

    const r = await rig.api('POST', '/hosting/invites', { name: 'Dad' });
    expect(r.status).toBe(201);
    const secret = decodeInviteUri(r.body.link, rig.nowSec()).secret;
    const guest = phoneOn(rig, new Uint8Array(32).fill(71));
    const prep = await guest.rpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: 'ab'.repeat(31) + 'cd' });
    expect(prep.features).toContain(GUARDIAN_FEATURES.pairingRulesApproval);
    const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware });
    const pair = {
      inviteSecret: secret,
      deviceName: 'Guest phone',
      walletLabel: 'Family wallet',
      network: 'regtest' as const,
      accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
      hardwareAuth: fx.hardwareAuth,
      hardwareAuthProof: fx.proof,
      rules: DRAIN,
      walletMap: fakeMap(),
      phoneNostrPubkey: guest.pubkey,
    };
    const old = await rpcError(guest.rpc.call('hosted.pair', pair));
    expect(old.code).toBe(ErrorCode.InvalidParams);
    expect(old.data).toEqual({ reason: 'app_update_required' });
    const mismatch = await rpcError(guest.rpc.call('hosted.pair', { ...pair, rulesApproval: fx.approveRules(SHOWN, rig.clock.now()) }));
    expect(mismatch.code).toBe(ErrorCode.ApprovalInvalid);
    expect(mismatch.data).toMatchObject({ reason: 'approval_invalid_signature' });
    const res = await guest.rpc.call('hosted.pair', { ...pair, rules: SHOWN, rulesApproval: fx.approveRules(SHOWN, rig.clock.now()) });
    expect(res.walletId).toBe(fx.walletId);
    expect((await guest.rpc.call('policy.get', {})).policy).toEqual(SHOWN);
  });
});

describe('a guardian from before pairing_rules_approval (simulated)', { timeout: 60_000 }, () => {
  it('pairs without the approval, as before: what a new app does with an old guardian', async () => {
    const rig = await GuardianRig.start({ http: true });
    rigs.push(rig);
    rig.guardian.features = rig.guardian.features.filter((f) => f !== GUARDIAN_FEATURES.pairingRulesApproval);
    const phone = phoneOn(rig);
    const { params, walletId } = await pairParams(rig, phone, SHOWN, { feature: false });
    const res = await phone.rpc.call('pair', params);
    expect(res.walletId).toBe(walletId);
  });
});
