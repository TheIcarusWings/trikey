/**
 * Security sweep 2, finding 6 (MEDIUM, hosted guests only): a co-signature erased a coin's tweaks from the ledger.
 *
 * In family hosting a guest's change can sit at any tweak (BIP 89 style, no derivation path): only the phone key plus
 * key 3 can spend such a coin, and the slot's ledger is the guardian's only record of its tweaks. The ledger dropped a
 * coin as soon as a co-signed PSBT spent it, broadcast or not. A thief with the guest's phone could:
 *   1. co-sign and broadcast T0, moving the guest's coins to one off-path output X (the ledger now holds X);
 *   2. co-sign T1, spending X to another off-path output at a fee of 0, and never broadcast it.
 * X stayed unspent on chain but left the ledger: `hosted.coins` no longer listed it, a recovery's coverage check no
 * longer asked for it to be swept or abandoned (no alert named it), and leaving the host (`wallet.retire`) passed and
 * deleted key 3, the only other key that can sign X.
 *
 * Now a co-signature only adds to the ledger; a coin leaves it only when a chain check finds it spent. When the ledger
 * is full, `sign` prunes spent coins on chain and tries once more.
 *
 * Security sweep 3, finding 2 (MEDIUM-HIGH): that chain check still dropped every coin the chain did not list as
 * unspent: T1's own output (not broadcast yet, so a thief could broadcast it once the guest had left and key 3 was
 * gone), and every coin at once when the server answered something other than a list. It ran in `wallet.retire` before
 * the hardware approval was looked at, so a phone alone could trigger it. Now a coin leaves only once settled (its
 * transaction can add it no more: the coin it spends is gone too), a malformed answer is an error, and `wallet.retire`
 * checks the approval first and prunes nothing.
 */
import { getPublicKey } from 'nostr-tools/pure';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, TX_OPTS, ccdtKey, delegatedScripts, finalizePsbt, tweakPrivateKey, tweakToBytes } from '@trikey/core';
import { ErrorCode, RpcClient, SimplePoolRelayPool, approvalMessage, decodeInviteUri, type RpcError } from '@trikey/protocol';
import type { HostedEngine } from '../../src/hosting/engine.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, network } from '../helpers.js';
import { signMessage } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { externalScript, fakeMap, hostedWallet, offPathPayment, type HostedFixture, withHostedRulesApproval } from '../support/hosted.js';
import { pairInRig } from './support.js';

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
let guestRpc: RpcClient;
const guestKey = new Uint8Array(32).fill(83);
const guestPub = getPublicKey(guestKey);
let guest: HostedFixture;
let engine: HostedEngine;

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  await pairInRig(rig);
  const inv = await rig.api('POST', '/hosting/invites', { name: 'Granny' });
  const secret = decodeInviteUri(inv.body.link, rig.nowSec()).secret;
  guestRpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: guestKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  const prep = await guestRpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: '6b'.repeat(31) + '0e' });
  guest = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware2 });
  await guestRpc.call(
    'hosted.pair',
    withHostedRulesApproval(
      {
        inviteSecret: secret,
        deviceName: 'Guest phone',
        walletLabel: 'Granny wallet',
        network: 'regtest',
        accountPubkeys: { app: guest.accountPubkeys.app, hardware: guest.accountPubkeys.hardware },
        hardwareAuth: guest.hardwareAuth,
        hardwareAuthProof: guest.proof,
        rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
        walletMap: fakeMap(),
        phoneNostrPubkey: guestPub,
      },
      guest,
      rig.nowSec() * 1000,
    ),
  );
  engine = rig.guardian.hosting.liveSlots()[0]!.engine;
}, 60_000);

afterAll(async () => {
  guestRpc?.close();
  pool.close();
  await rig?.stop();
});

/** The guest phone's account private key (key 2), which signs ledger coins by their tweaks. */
function appAccountKey(): Uint8Array {
  return appSigner(guest.app).master(network).derive(`m/${guest.wallet.keys.app.originPath.replace(/h/g, "'")}`).privateKey!;
}

/**
 * A spend of the ledger coin at `outpoint` to a fresh off-path output of the same wallet, at a fee of 0, signed by key 2
 * at the coin's tweak (what the app's hosted sweep does: packages/wallet/src/hosted.ts `ledgerInput`, `signByTweaks`).
 */
function spendLedgerCoinAtZeroFee(outpoint: string, prevTxHex: string): Uint8Array {
  const coin = engine.ledger().find((l) => `${l.txid}:${l.vout}` === outpoint)!;
  const acct = guest.wallet.accountPubkeys();
  const big = (h: string) => BigInt(`0x${h}`);
  const at = { app: big(coin.tweaks.app), hardware: big(coin.tweaks.hardware), cosigner: big(coin.tweaks.cosigner) };
  const d = delegatedScripts(acct, at, network);
  expect(hex.encode(d.script)).toBe(coin.script);
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({
    txid: coin.txid,
    index: coin.vout,
    sequence: 0xfffffffd,
    witnessUtxo: { script: d.script, amount: coin.valueSats },
    nonWitnessUtxo: hex.decode(prevTxHex),
    sighashType: btc.SigHash.ALL,
    witnessScript: d.witnessScript,
    proprietary: ROLES.map((r) => [ccdtKey(acct[r]), tweakToBytes(at[r])] as [Uint8Array, Uint8Array]),
  });
  const next = { app: 11n, hardware: 12n, cosigner: 13n };
  const out = delegatedScripts(acct, next, network);
  tx.addOutput({ script: out.script, amount: coin.valueSats, proprietary: ROLES.map((r) => [ccdtKey(acct[r]), tweakToBytes(next[r])] as [Uint8Array, Uint8Array]) });
  tx.signIdx(tweakPrivateKey(appAccountKey(), at.app), 0, [btc.SigHash.ALL]);
  return tx.toPSBT();
}

describe('security: an unbroadcast co-signature keeps the ledger (sweep 2 #6, sweep 3 #2)', { timeout: 60_000 }, () => {
  let x = '';
  let t0Hex = '';
  let t1Hex = '';
  let y = '';
  const ledgerOps = () => engine.ledger().map((l) => `${l.txid}:${l.vout}`);
  const retire = async (approval: unknown) => {
    try {
      await guestRpc.call('wallet.retire', { approval } as never);
      return undefined;
    } catch (e) {
      return e as RpcError;
    }
  };
  const approveRetire = async (sequence?: number) => {
    const seq = sequence ?? (await guestRpc.call('guardian.status', {})).nextHardwareSequence;
    const expiresAt = rig.nowSec() + 600;
    const text = approvalMessage({ action: 'retire-wallet' }, { walletId: guest.walletId, sequence: seq, expiresAt });
    return { kind: 'bip137' as const, sequence: seq, expiresAt, signature: signMessage(text, hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2)) };
  };

  it('PoC: a co-signed spend that is never broadcast leaves the coin it spends in the ledger, and its own output too', async () => {
    // T0, broadcast: the guest's coin moves to an off-path output X.
    const u = rig.fund(guest.wallet.derive(0, 0).script, 300_000n);
    const t0 = await offPathPayment(guest, { txid: u.txid, vout: 0, value: u.value, chain: 0, index: 0, prevTxHex: u.rawTx }, 10_000n, 289_000n, externalScript(), guest.app);
    const signed0 = await guestRpc.call('sign', { psbt: Buffer.from(t0.psbt).toString('base64') });
    const final0 = finalizePsbt(Buffer.from(signed0.psbt, 'base64'));
    expect((await guestRpc.call('tx.broadcast', { txHex: final0.txHex })).txid).toBe(final0.txid);
    x = `${final0.txid}:1`;
    t0Hex = final0.txHex;
    expect(ledgerOps()).toEqual([x]);

    // T1, never broadcast: spends X at a fee of 0 to another off-path output Y.
    const t1 = spendLedgerCoinAtZeroFee(x, final0.txHex);
    const signed1 = await guestRpc.call('sign', { psbt: Buffer.from(t1).toString('base64') });
    const final1 = finalizePsbt(Buffer.from(signed1.psbt, 'base64'));
    t1Hex = final1.txHex;
    y = `${final1.txid}:0`;

    // X is still unspent on chain, and still in the ledger with its tweaks: listed, and in the way of leaving the host.
    expect(ledgerOps()).toContain(x);
    const listed = await guestRpc.call('hosted.coins', {});
    expect(listed.coins.map((c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`)).toContain(x);
    // Y is not on the chain, but T1 could still be broadcast (X is unspent): it stays too (sweep 3: it was pruned).
    const left = await rig.guardian.hosting.settleLedger(engine);
    expect(left).toEqual({ coins: 2, sats: 578_000n });
    expect(ledgerOps()).toEqual([x, y]);
  });

  it('PoC (sweep 3 #2): wallet.retire with a bad approval prunes nothing, and with a good one is refused while T1 could still be broadcast', async () => {
    const bad = await approveRetire();
    bad.signature = (await approveRetire(bad.sequence + 1)).signature; // signed for another sequence
    const e = await retire(bad);
    expect(e?.code).toBe(ErrorCode.ApprovalInvalid);
    // Before the fix, the retire's chain check pruned Y here, before it looked at the approval.
    expect(ledgerOps()).toEqual([x, y]);
    const e2 = await retire(await approveRetire());
    expect(e2?.code).toBe(ErrorCode.PolicyViolation);
    expect(e2?.data).toMatchObject({ reason: 'ledger_unspent', coins: 2, unconfirmed: 1 });
    expect(ledgerOps()).toEqual([x, y]);
  });

  it('PoC (sweep 3 #2): a listunspent answer that is not a list refuses, and prunes nothing', async () => {
    rig.electrs.malformedUnspent = null;
    try {
      const e = await retire(await approveRetire());
      expect(e?.code).toBe(ErrorCode.Unavailable);
      await expect(rig.guardian.hosting.settleLedger(engine)).rejects.toThrow();
      expect(ledgerOps()).toEqual([x, y]);
    } finally {
      rig.electrs.malformedUnspent = undefined;
    }
  });

  it('a full ledger: sign checks the chain and tries once more, but never drops a coin the chain has not settled', async () => {
    (engine as unknown as { maxLedger: number }).maxLedger = 2;
    const u = rig.fund(guest.wallet.derive(0, 1).script, 50_000n);
    const t2 = await offPathPayment(guest, { txid: u.txid, vout: 0, value: u.value, chain: 0, index: 1, prevTxHex: u.rawTx }, 1_000n, 48_000n, externalScript(), guest.app);
    let err: RpcError | undefined;
    try {
      await guestRpc.call('sign', { psbt: Buffer.from(t2.psbt).toString('base64') });
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.data).toMatchObject({ reason: 'ledger_full' });
    expect(ledgerOps()).toEqual([x, y]);
  });

  it('a coin really spent on chain is still pruned: T1 confirms, X goes, Y stays (unspent)', async () => {
    expect(rig.electrs.applyTransaction(t1Hex, rig.electrs.height)).toBeUndefined();
    const left = await rig.guardian.hosting.settleLedger(engine);
    expect(ledgerOps()).toEqual([y]);
    expect(left).toEqual({ coins: 1, sats: 289_000n });
    // Room again: the payment the full ledger refused goes through.
    const u = rig.fund(guest.wallet.derive(0, 2).script, 50_000n);
    const t2 = await offPathPayment(guest, { txid: u.txid, vout: 0, value: u.value, chain: 0, index: 2, prevTxHex: u.rawTx }, 1_000n, 48_000n, externalScript(), guest.app);
    expect((await guestRpc.call('sign', { psbt: Buffer.from(t2.psbt).toString('base64') })).psbt).toBeTruthy();
    expect(engine.ledger().some((l) => l.script === hex.encode(t2.changeScript))).toBe(true);
    expect(t0Hex).toBeTruthy();
  });
});
