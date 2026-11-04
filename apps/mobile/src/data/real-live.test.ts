/**
 * The live wallet in the app: the real wallet service against the real guardian in-process (regtest, throwaway keys),
 * whose fake Electrs notifies its script subscriptions like a real one.
 *
 * - A payment from another device is in Activity within moments, pending, before any sync finishes (the guardian's
 *   `wallet_tx`), with the balance nudged and the note "Incoming 2,000 sats · unconfirmed"; then confirmed.
 * - The note goes away by itself or with a tap; a replayed (old) alert brings none.
 * - This phone's own payment is one row: "Sending" and the alert agree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { SimplePoolRelayPool, type Alert, type Handlers } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { createRealWalletService, toastText, type RealWalletService } from './real';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;
async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

let rig: GuardianRig;
let svc: RealWalletService;

/** Somebody else's wallet pays `script`: the transaction is in the (fake) mempool. */
function payIn(script: Uint8Array, value: number): string {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  rig.electrs.addUtxo(script, { txid, vout: 0, value, height: 0 }, hex.encode(raw));
  return txid;
}

const row = (txid: string) => {
  const item = svc.getState().activity.find((i) => i.type === 'payment' && i.tx.txid === txid);
  return item && item.type === 'payment' ? item.tx : undefined;
};

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SoftwareHardwareProvider(device)],
    clock: rig.clock,
    relayPool: () => new SimplePoolRelayPool({ resubscribeBackoffMs: [200, 400] }),
    rpcTimeoutMs: 4000,
    syncTimeoutMs: 6000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 300_000n);
  await waitFor(() => rig.guardian.live!.store.state.wallets[svc.wallet!.state.wallet!.walletId], 'the guardian to read the wallet');
  await svc.sync();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

const handlers = () => (rig.guardian.rpc as unknown as { o: { handlers: Handlers } }).o.handlers;

describe('a payment from another device', { timeout: 60_000 }, () => {
  it('is in Activity within moments, pending, with the note, before any sync answers; then confirmed', async () => {
    // Every wallet.sync takes 3 s: what the phone shows first is the alert's doing.
    const h = handlers();
    const realSync = h['wallet.sync']!;
    h['wallet.sync'] = async (params, ctx) => {
      await sleep(3000);
      return realSync(params, ctx);
    };
    try {
      rig.clock.advance(1000);
      const before = svc.getState().balanceSats;
      const started = Date.now();
      const txid = payIn(svc.wallet!.multisig().derive(0, 1).script, 2_000);
      const tx = await waitFor(() => row(txid), 'the payment in Activity');
      const ms = Date.now() - started;
      expect(ms).toBeLessThan(2500);
      expect(tx).toMatchObject({ kind: 'received', status: 'pending', amountSats: 2_000 });
      expect(svc.getState().balanceSats).toBe(before + 2_000);
      expect(svc.getState().toast).toMatchObject({ kind: 'incoming', text: 'Incoming 2,000 sats · unconfirmed' });
      console.log(`\nincoming payment (mempool) to Activity: ${ms} ms, with every wallet.sync taking 3 s`);

      rig.clock.advance(1000);
      await rig.mine(1);
      await waitFor(() => row(txid)?.status === 'confirmed', 'confirmed');
      expect(svc.getState().balanceSats).toBe(before + 2_000);
      // The sync the alert set off lists it: still one row.
      await svc.sync();
      expect(svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.txid === txid)).toHaveLength(1);
    } finally {
      h['wallet.sync'] = realSync;
    }
  });

  it('the note goes away with a tap, or by itself; an old (replayed) alert brings none', async () => {
    rig.clock.advance(1000);
    const txid = payIn(svc.wallet!.multisig().derive(0, 2).script, 5_000);
    await waitFor(() => svc.getState().toast?.text === 'Incoming 5,000 sats · unconfirmed', 'the note');
    svc.dismissToast?.();
    expect(svc.getState().toast).toBeNull();
    await waitFor(() => row(txid), 'the row');
    // A week-old alert, as relays replay them: listed, no note.
    const at = rig.clock.now() - 7 * 86_400_000;
    const old: Alert = { type: 'wallet_tx', txid: 'aa'.repeat(32), direction: 'in', amountSats: 777, confirmations: 3, wallet: 'main', at: Math.floor(at / 1000), atMs: at };
    await (svc.wallet as unknown as { onAlert(a: Alert, m: { id: string; at: number }, from?: string): Promise<void> }).onAlert(old, { id: 'replayed-1', at: old.at }, svc.wallet!.state.guardian!.pubkey);
    expect(svc.getState().toast).toBeNull();
    expect(toastText({ amountSats: 1_234_567, confirmations: 1, wallet: 'savings' })).toBe('Incoming 1,234,567 sats to Savings · confirmed');
  });

  it("this phone's own payment is one row: Sending, and the guardian's alert about it", async () => {
    await svc.sync();
    rig.clock.advance(1000);
    const q = svc.quoteSend({ address: externalAddress(), amountSats: 20_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    const tx = await svc.sendPayment(q.quote);
    await waitFor(() => svc.wallet!.state.liveTxs.some((t) => t.txid === tx.txid), 'the guardian to announce it');
    const rows = svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.txid === tx.txid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tx: { kind: 'sent', status: 'pending', amountSats: 20_000, feeSats: q.quote.feeSats } });
    // An outgoing payment brings no "Incoming" note.
    expect(svc.getState().toast?.text ?? '').not.toMatch(/20,000/);
  });
});
