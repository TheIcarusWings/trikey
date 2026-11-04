/**
 * "Speed up" of a Spending payment in the app, from the real wallet service against the real guardian in-process
 * (regtest, throwaway keys; DESIGN.md, "Speed up"): a payment waiting to confirm is offered for it in Activity, the quote
 * has the three speeds with the old and new fee, this phone and the guardian sign within the limit ("Signed. Sending…"
 * as for any payment), Activity shows one row (also when the guardian's `wallet_tx` for the replacement comes), a locked
 * guardian's refusal is offered to the hardware wallet instead (never a silent switch), and what cannot be sped up says why.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { WalletServiceError } from './errors';
import { createRealWalletService, type RealWalletService } from './real';
import type { Transaction } from './types';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Simulated device' });

class SimDevice implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];
  async isAvailable() {
    return true;
  }
  async connect(): Promise<HardwareSigner> {
    return device;
  }
}

const TO = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
let rig: GuardianRig;
let svc: RealWalletService;
const payments = () => svc.getState().activity.flatMap((i) => (i.type === 'payment' ? [i.tx] : []));
const rowsOf = (...txids: string[]) => payments().filter((t) => txids.includes(t.txid));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  const passkey = new MemoryPasskeyPrf();
  passkey.supported = false;
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SimDevice()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0, // every sync() asks the guardian again
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 400_000n);
  rig.fund(svc.wallet!.multisig().derive(0, 1).script, 300_000n);
  await svc.sync();
}, 60_000);

afterAll(async () => {
  await svc?.idle();
  await svc?.close();
  await rig?.stop();
});

describe('Speed up in the app (guardian mode)', { timeout: 120_000 }, () => {
  let sent: Transaction;
  let faster: Transaction;

  it('a payment waiting to confirm is offered for a speed-up; the quote has three speeds, the amount unchanged', async () => {
    const q = svc.quoteSend({ address: TO, amountSats: 25_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    sent = await svc.sendPayment(q.quote);
    expect(rowsOf(sent.txid)).toEqual([expect.objectContaining({ kind: 'sent', status: 'pending', canSpeedUp: true, amountSats: 25_000 })]);
    const o = await svc.speedUp!.quote(sent.txid);
    if (!o.ok) throw new Error(o.message);
    const f = o.quotes.fast!;
    expect(f).toMatchObject({ txid: sent.txid, address: TO, amountSats: 25_000, oldFeeSats: sent.feeSats, plan: { signer: 'phone+guardian' }, speed: 'fast' });
    expect(f.feeRate).toBeCloseTo(20, 0);
    expect(f.oldFeeRate).toBeCloseTo(10, 0);
    expect(f.limitSats).toBe(f.extraFeeSats);
    expect(o.quotes.normal!.feeSats).toBeLessThan(f.feeSats);
    expect(o.quotes.slow!.alreadyAtRate).toBe(true);
  });

  it('this phone and the guardian sign it; "Sending…" ends when it is out; one row, the replacement', async () => {
    const o = await svc.speedUp!.quote(sent.txid);
    if (!o.ok) throw new Error(o.message);
    const used = svc.getState().dailyLimit.usedSats;
    let sawSending = false;
    const off = svc.subscribe(() => {
      if (svc.getState().paymentSending) sawSending = true;
    });
    try {
      faster = await svc.speedUp!.send(o.quotes.fast!);
    } finally {
      off();
    }
    expect(sawSending).toBe(true);
    expect(svc.getState().paymentSending).toBe(false);
    expect(faster).toMatchObject({ kind: 'sent', amountSats: 25_000, feeSats: o.quotes.fast!.feeSats, signedBy: 'phone+guardian', spedUp: true });
    expect(rig.electrs.replaced).toContain(sent.txid);
    expect(rowsOf(sent.txid, faster.txid)).toEqual([expect.objectContaining({ txid: faster.txid, status: 'pending', spedUp: true, canSpeedUp: true, address: TO, amountSats: 25_000 })]);
    // Only the extra fee counts toward the limit.
    await svc.sync();
    expect(svc.getState().dailyLimit.usedSats - used).toBe(o.quotes.fast!.extraFeeSats);
  });

  it("the guardian's wallet_tx for the replacement updates the row, and adds none", async () => {
    await waitFor(() => svc.wallet!.state.liveTxs.find((t) => t.txid === faster.txid && t.replaces === sent.txid) || rig.guardian.live!.store.state.wallets[svc.wallet!.state.wallet!.walletId]?.seen[faster.txid], 'the guardian to see the replacement');
    await sleep(300);
    expect(rowsOf(sent.txid, faster.txid).map((t) => t.txid)).toEqual([faster.txid]);
    await svc.sync();
    expect(rowsOf(sent.txid, faster.txid).map((t) => t.txid)).toEqual([faster.txid]);
  });

  it('a locked guardian: its refusal offers the hardware wallet (no silent switch); quoted for it, the hardware wallet signs', async () => {
    const o = await svc.speedUp!.quote(faster.txid);
    if (!o.ok) throw new Error(o.message);
    expect(o.quotes.fast!.plan).toEqual({ signer: 'phone+guardian' });
    await rig.lock();
    const signs = device.calls.filter((c) => c.op === 'signPsbt').length;
    const err = await svc.speedUp!.send(o.quotes.fast!).catch((e) => e);
    expect(err).toBeInstanceOf(WalletServiceError);
    expect(err).toMatchObject({ suggestsHardware: true });
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs);
    const hw = await svc.speedUp!.quote(faster.txid, { signer: 'hardware' });
    if (!hw.ok) throw new Error(hw.message);
    expect(hw.quotes.fast!.plan.signer).toBe('hardware');
    const done = await svc.speedUp!.send(hw.quotes.fast!);
    expect(done).toMatchObject({ signedBy: 'phone+hardware', spedUp: true });
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs + 1);
    expect(rowsOf(sent.txid, faster.txid, done.txid).map((t) => t.txid)).toEqual([done.txid]);
    await rig.unlock();
  });

  it('says why when it cannot: incoming, confirmed', async () => {
    const script = svc.wallet!.multisig().derive(0, 4).script;
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd }],
      outputs: [{ script, amount: 9_000n }],
      lockTime: 0,
    });
    const incoming = hex.encode(sha256(sha256(raw)).reverse());
    rig.electrs.addUtxo(script, { txid: incoming, vout: 0, value: 9_000, height: 0 }, hex.encode(raw));
    await svc.sync();
    expect(rowsOf(incoming)[0]!.canSpeedUp).toBeUndefined();
    expect(await svc.speedUp!.quote(incoming)).toMatchObject({ ok: false, message: expect.stringMatching(/payment out of this wallet/) });
    await rig.mine();
    await svc.sync();
    const last = payments().find((t) => t.kind === 'sent')!;
    expect(last.status).toBe('confirmed');
    expect(last.canSpeedUp).toBeUndefined();
    expect(await svc.speedUp!.quote(last.txid)).toMatchObject({ ok: false, message: expect.stringMatching(/confirmed already/) });
  });
});
