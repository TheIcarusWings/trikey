/**
 * Security review 2026-11 (Medium-High): the phone alone could add a wallet and plant its own hardware key and unlock
 * slot. `wallet.add` needed only the first wallet's paired phone and an unlocked box: the new wallet's "hardware wallet",
 * its pairing proof and its rules approval were all the attacker's own key. `unlock.hardware.add` for that wallet then
 * stored a slot that unlocks the whole box (any own wallet's slot does), so a lock by the owner or a contact no longer
 * held against a stolen phone. The planted wallet could not be removed (its retire needs the attacker's device; the first
 * wallet cannot retire while others exist; Reset is refused while an own wallet's recovery runs), and the first wallet's
 * contacts were never told.
 *
 * Now (`add_wallet_approval`): `wallet.add` needs the FIRST wallet's hardware wallet (`addApproval` over the `add-wallet`
 * text naming the new wallet, with the first wallet's sequence); the first wallet's contacts hear of a wallet added and of
 * an unlock slot added on any wallet; and the owner can, in the web page, turn an unlock slot off and remove a wallet after
 * the first without its hardware wallet (behind a typed confirmation), never while a recovery of it runs: the web session
 * gets no power over recoveries, and Reset is still refused while any wallet's recovery runs.
 * Regtest, throwaway keys and the published BIP 39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, buildSweep, type KeyExpression, type Utxo } from '@trikey/core';
import { ErrorCode, RpcClient, RpcError, SimplePoolRelayPool, approvalMessage, decodePairingUri, pairingMessage, unlockKeyMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../../src/policy/index.js';
import { RESET_CONFIRMATION } from '../../src/guardian.js';
import { boxNoticeText } from '../../src/alerts.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, nostrKey, withAddApproval, withRulesApproval } from '../helpers.js';
import { GuardianRig, type FundedOutput } from '../support/index.js';
import { sealedHardwareAdd } from '../support/sealed-phone.js';

const ATTACKER_HW = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';
const OWNER_HW2 = MNEMONICS.hardware2;
const FIRST_CONTACT = nostrKey(41);

async function refusal(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

const pools: SimplePoolRelayPool[] = [];
const clients: RpcClient[] = [];
let rig: GuardianRig;
let rpc: RpcClient;
let phonePub: string;
const alerts: Alert[] = [];
let firstWalletId: string;

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({ fingerprint: k.fingerprint, originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: k.xpub });
const rawPub = (xpub: string) => hex.encode(HDKey.fromExtendedKey(xpub, network.bip32).publicKey!);
const utxoOf = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });
const rules = (alertContacts: string[] = []): Policy => ({ dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts, sweepFeeCapSats: 20_000 });
const notices = () => rig.guardian.store.state?.notices ?? [];

/** What a phone (the thief's, or the owner's) sends to add a wallet at `account` with the device `hw`. */
async function addParams(account: number, hw: string, name: string) {
  const prep = await rpc.call('wallet.add.prepare', { account });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network, account), hardware: await hwSigner(hw).getKey(network), cosigner: toKey(prep.guardianKey) });
  const params = withRulesApproval(
    {
      account,
      name,
      descriptor: wallet.descriptor(),
      hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, hw), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, hw)),
      rules: rules(),
    },
    rig.nowSec() * 1000,
    hwAuthPrivateKey(AUTH_PATH, hw),
  );
  return { wallet, params };
}

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  const key = generateSecretKey();
  phonePub = getPublicKey(key);
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  rpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  rpc.onAlert((a) => alerts.push(a));
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', entropy: 'a1b2'.repeat(16) });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner: toKey(prep.guardianKey) });
  const app = wallet.keys.app;
  const res = await rpc.call(
    'pair',
    withRulesApproval(
      {
        pairingSecret: p.secret,
        deviceName: 'Owner phone',
        network: 'regtest',
        phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
        descriptor: wallet.descriptor(),
        phoneNostrPubkey: phonePub,
        hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
        hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey()),
        rules: rules([FIRST_CONTACT]),
      },
      rig.nowSec() * 1000,
    ),
  );
  firstWalletId = res.walletId;
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  for (const p of pools) p.close();
  await rig?.stop();
});

describe('security: a wallet added with the phone alone', { timeout: 90_000 }, () => {
  it('PoC: the phone adds a wallet whose "hardware wallet" is its own key: refused without the first wallet\'s hardware wallet', async () => {
    const { params } = await addParams(2, ATTACKER_HW, 'Spare');
    // What used to be enough: the phone, its own key as the device, an unlocked box.
    const bare = await refusal(rpc.call('wallet.add', params));
    expect(bare.code).toBe(ErrorCode.InvalidParams);
    expect(bare.data).toMatchObject({ reason: 'app_update_required' });
    expect(bare.message).toMatch(/first wallet's hardware wallet/);
    // An "approval" by the attacker's own key: not the first wallet's hardware wallet.
    const forged = withAddApproval(params, rig.guardian, rig.nowSec() * 1000, hwAuthPrivateKey(AUTH_PATH, ATTACKER_HW));
    expect((await refusal(rpc.call('wallet.add', forged))).code).toBe(ErrorCode.ApprovalInvalid);
    // Nothing was added, no sequence was used, and so no unlock slot can be planted for it.
    expect((await rpc.call('guardian.status', {})).wallets).toBeUndefined();
    expect(rig.guardian.engine.status().nextHardwareSequence).toBe(1);
    expect(rig.guardian.features).toContain('add_wallet_approval');
  });

  it("with the first wallet's approval it is added; the first wallet's contacts are told; the approval is used once", async () => {
    const { wallet, params } = await addParams(2, OWNER_HW2, 'Business');
    const approved = withAddApproval(params, rig.guardian, rig.nowSec() * 1000);
    // The text names both wallets.
    expect(approvalMessage({ action: 'add-wallet', newWalletId: wallet.fingerprint() }, { walletId: firstWalletId, sequence: 1, expiresAt: approved.addApproval.expiresAt })).toMatch(
      new RegExp(`^Trikey add-wallet v1 wallet=${firstWalletId} new=${wallet.fingerprint()} seq=1 expires=`),
    );
    const res = await rpc.call('wallet.add', approved);
    expect(res.walletId).toBe(wallet.fingerprint());
    expect(rig.guardian.engine.status().nextHardwareSequence).toBe(2);
    expect(rig.guardian.engine.activity().some((e) => e.type === 'wallet_add_approved' && e.newWalletId === res.walletId)).toBe(true);
    const told = notices().find((n) => n.kind === 'wallet_added' && n.subjectWalletId === res.walletId)!;
    expect(told).toMatchObject({ recipients: [FIRST_CONTACT], name: 'Business', approved: true });
    expect(boxNoticeText({ ...told, kind: 'wallet_added' }, 'Home vault')).toMatch(/a wallet was added to the guardian "Home vault"/);
    // The same approval again (another wallet): stale.
    const { params: other } = await addParams(4, ATTACKER_HW, 'Again');
    expect((await refusal(rpc.call('wallet.add', { ...other, addApproval: approved.addApproval }))).code).toBe(ErrorCode.StaleSequence);
  });

  it("an unlock slot on any wallet is announced to the first wallet's contacts, and the owner turns it off in the web page", async () => {
    const business = (await rpc.call('guardian.status', {})).wallets!.find((w) => w.name === 'Business')!;
    // The slot id the guardian offers for that wallet (`unlock_slot_offer`).
    const SLOT = (await rpc.call('guardian.status', { walletId: business.walletId })).hardwareUnlockOffer!.slot;
    const signature = signMessage(unlockKeyMessage({ walletId: business.walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot: SLOT }), hwAuthPrivateKey(AUTH_PATH, OWNER_HW2));
    await sealedHardwareAdd(
      { phone: rpc, phonePubkey: phonePub, guardianPubkey: rig.pubkey, nowSec: rig.nowSec() },
      { walletId: business.walletId, slot: SLOT, signature },
    );
    expect(notices().find((n) => n.kind === 'unlock_slot_added' && n.subjectWalletId === business.walletId)).toMatchObject({ recipients: [FIRST_CONTACT] });
    const listed = (await rig.api('GET', '/own-wallets')).body;
    expect(listed.wallets.map((w: { name: string; first: boolean }) => [w.name, w.first])).toEqual([
      ['First wallet', true],
      ['Business', false],
    ]);
    expect(listed.wallets[1].unlockSlot).toBeTruthy();
    const off = await rig.api('DELETE', `/unlock-slots/${business.walletId}`);
    expect(off.status).toBe(200);
    expect(off.body.wallets[1].unlockSlot).toBeUndefined();
    expect(rig.guardian.unlockSlots.get(business.walletId)).toBeUndefined();
    expect((await rig.api('DELETE', `/unlock-slots/${business.walletId}`)).status).toBe(404);
    // Turned off in the web page, it stays off: the old signature cannot make its slot again (the guardian offers a new id).
    // Cleartext is enough: slot-not-offered is checked before the seal requirement.
    const again = await refusal(rpc.call('unlock.hardware.add', { walletId: business.walletId, slot: SLOT, signature }));
    expect(again.data).toMatchObject({ reason: 'unlock_slot_not_offered' });
    expect(rig.guardian.unlockSlots.get(business.walletId)).toBeUndefined();
    expect((await rpc.call('guardian.status', { walletId: business.walletId })).hardwareUnlockOffer!.slot).not.toBe(SLOT);
  });

  it('the owner removes a wallet after the first in the web page, without its hardware wallet, behind a typed confirmation', async () => {
    const business = (await rpc.call('guardian.status', {})).wallets!.find((w) => w.name === 'Business')!;
    expect((await rig.api('POST', `/own-wallets/${business.walletId}/remove`, {})).status).toBe(400);
    expect((await rig.api('POST', `/own-wallets/${firstWalletId}/remove`, { confirm: 'REMOVE WALLET' })).body.error.code).toBe('first_wallet');
    const r = await rig.api('POST', `/own-wallets/${business.walletId}/remove`, { confirm: 'REMOVE WALLET' });
    expect(r.status).toBe(200);
    expect(r.body.wallets.map((w: { name: string }) => w.name)).toEqual(['First wallet']);
    // Retired: nothing is co-signed for it; listed as retired; its phone, the owner and the first wallet's contacts told.
    expect((await rpc.call('guardian.status', {})).wallets!.find((w) => w.walletId === business.walletId)).toMatchObject({ state: 'retired' });
    expect(await refusal(rpc.call('policy.get', { walletId: business.walletId }))).toBeInstanceOf(RpcError);
    expect(notices().find((n) => n.kind === 'wallet_removed' && n.subjectWalletId === business.walletId)).toMatchObject({ recipients: [FIRST_CONTACT] });
    const activity = (await rig.api('GET', '/activity')).body.entries as { summary?: string }[];
    expect(activity.some((e) => e.summary === 'Wallet "Business" removed')).toBe(true);
  });

  it("neither removal nor Reset ends a recovery: both are refused while that wallet's recovery runs", async () => {
    // A wallet being recovered (for all the guardian knows, by its owner who lost a device): the web session must not be
    // able to freeze it, whoever learnt the passphrase.
    const { wallet, params } = await addParams(4, ATTACKER_HW, 'Recovering');
    const added = await rpc.call('wallet.add', withAddApproval(params, rig.guardian, rig.nowSec() * 1000));
    const coin = rig.fund(wallet.derive(0, 0).script, 100_000n);
    const dest = new MultisigWallet(network, { app: wallet.keys.app, hardware: await hwSigner(MNEMONICS.stranger).getKey(network), cosigner: wallet.keys.cosigner });
    const plan = buildSweep({ from: wallet, utxos: [utxoOf(coin, 0, 0)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await rpc.call('recovery.start', { walletId: added.walletId, sweepPsbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)), newDescriptor: dest.descriptor() });
    const recoveryId = started.recovery.recoveryId;
    expect((await rig.api('GET', '/own-wallets')).body.wallets.find((w: { walletId: string }) => w.walletId === added.walletId).recovery).toMatchObject({ id: recoveryId });
    // Remove: refused, the wallet still guarded and its recovery untouched.
    const remove = await rig.api('POST', `/own-wallets/${added.walletId}/remove`, { confirm: 'REMOVE WALLET' });
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('recovery_pending');
    expect(remove.body.error.message).toMatch(/cannot be removed until it completes, or is cancelled/);
    expect((await rpc.call('recovery.status', { recoveryId, walletId: added.walletId })).recovery).toMatchObject({ state: 'pending' });
    expect((await rpc.call('guardian.status', {})).wallets!.find((w) => w.walletId === added.walletId)).toMatchObject({ state: 'active' });
    // Reset: refused as before, and there is no override.
    const body = { passphrase: rig.passphrase, confirm: RESET_CONFIRMATION };
    for (const extra of [{}, { stopOwnRecoveries: 'STOP WALLET RECOVERIES' }]) {
      const reset = await rig.api('POST', '/reset', { ...body, ...extra });
      expect(reset.status).toBe(409);
      expect(reset.body.error.code).toBe('recovery_pending');
    }
    expect(rig.guardian.engine.registration()?.walletId).toBe(firstWalletId);
    expect((await rpc.call('recovery.status', { recoveryId, walletId: added.walletId })).recovery).toMatchObject({ state: 'pending' });
    // Once it is cancelled (here by the phone), the owner may remove the wallet.
    await rpc.call('recovery.cancel', { recoveryId });
    expect((await rig.api('POST', `/own-wallets/${added.walletId}/remove`, { confirm: 'REMOVE WALLET' })).status).toBe(200);
  });
});
