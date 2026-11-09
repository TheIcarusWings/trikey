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
 */
import { getPublicKey } from 'nostr-tools/pure';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, TX_OPTS, ccdtKey, delegatedScripts, finalizePsbt, tweakPrivateKey, tweakToBytes } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodeInviteUri } from '@trikey/protocol';
import type { HostedEngine } from '../../src/hosting/engine.js';
import { MNEMONICS, appSigner, network } from '../helpers.js';
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

describe('security: an unbroadcast co-signature keeps the ledger (sweep 2 #6)', { timeout: 60_000 }, () => {
  let x = '';
  let t0Hex = '';

  it('PoC: a co-signed spend that is never broadcast leaves the coin it spends in the ledger', async () => {
    // T0, broadcast: the guest's coin moves to an off-path output X.
    const u = rig.fund(guest.wallet.derive(0, 0).script, 300_000n);
    const t0 = await offPathPayment(guest, { txid: u.txid, vout: 0, value: u.value, chain: 0, index: 0, prevTxHex: u.rawTx }, 10_000n, 289_000n, externalScript(), guest.app);
    const signed0 = await guestRpc.call('sign', { psbt: Buffer.from(t0.psbt).toString('base64') });
    const final0 = finalizePsbt(Buffer.from(signed0.psbt, 'base64'));
    expect((await guestRpc.call('tx.broadcast', { txHex: final0.txHex })).txid).toBe(final0.txid);
    x = `${final0.txid}:1`;
    t0Hex = final0.txHex;
    expect(engine.ledger().map((l) => `${l.txid}:${l.vout}`)).toEqual([x]);

    // T1, never broadcast: spends X at a fee of 0 to another off-path output.
    const t1 = spendLedgerCoinAtZeroFee(x, final0.txHex);
    expect((await guestRpc.call('sign', { psbt: Buffer.from(t1).toString('base64') })).psbt).toBeTruthy();

    // X is still unspent on chain, and still in the ledger with its tweaks: listed, and in the way of leaving the host.
    expect(engine.ledger().map((l) => `${l.txid}:${l.vout}`)).toContain(x);
    const listed = await guestRpc.call('hosted.coins', {});
    expect(listed.coins.map((c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`)).toContain(x);
    const left = await rig.guardian.hosting.unspentLedger(engine);
    expect(left.coins).toBe(1);
    expect(left.sats).toBe(289_000n);
    // The chain check pruned T1's output, which never reached the chain; X stays.
    expect(engine.ledger().map((l) => `${l.txid}:${l.vout}`)).toEqual([x]);
  });

  it('a full ledger: sign prunes spent coins on chain and tries once more', async () => {
    // Make the ledger look full with T1's unbroadcast output in it again.
    const t1 = spendLedgerCoinAtZeroFee(x, t0Hex);
    await guestRpc.call('sign', { psbt: Buffer.from(t1).toString('base64') });
    expect(engine.ledger()).toHaveLength(2);
    (engine as unknown as { maxLedger: number }).maxLedger = 2;
    const u = rig.fund(guest.wallet.derive(0, 1).script, 50_000n);
    const t2 = await offPathPayment(guest, { txid: u.txid, vout: 0, value: u.value, chain: 0, index: 1, prevTxHex: u.rawTx }, 1_000n, 48_000n, externalScript(), guest.app);
    expect((await guestRpc.call('sign', { psbt: Buffer.from(t2.psbt).toString('base64') })).psbt).toBeTruthy();
    // T1's output (never on chain) was pruned to make room; X stays, T2's change is in.
    const now = engine.ledger().map((l) => `${l.txid}:${l.vout}`);
    expect(now).toHaveLength(2);
    expect(now).toContain(x);
    expect(engine.ledger().some((l) => l.script === hex.encode(t2.changeScript))).toBe(true);
  });
});
