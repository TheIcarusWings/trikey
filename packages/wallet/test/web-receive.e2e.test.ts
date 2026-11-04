/**
 * The guardian's web Wallet page and the phone's Receive screen show the same address (apps/guardian/src/http/wallet.ts):
 * the first unused receive address after the highest used one, from the same chain read rule, derived from the same
 * descriptor. The real phone wallet (TrikeyWallet) against the real guardian service in-process (`@trikey/guardian/testing`,
 * a fake Electrs), a software hardware wallet; regtest, throwaway keys and published BIP 39 test mnemonics only.
 *
 * - They agree on a fresh wallet, after a payment, across a gap of unused addresses, and with a payment still unconfirmed.
 * - Neither moves the index on by looking: visits to the page change nothing on the phone, and the other way round.
 * - The phone's own payment pays change to the change chain: the receive address stays, on both.
 * - The hardware wallet shows the address the page shows (what the page asks the owner to check for a large amount).
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';
import { TrikeyWallet } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
let box: GuardianRig;
let W: TrikeyWallet;

/** A payment from somebody else's wallet to receive index `index` (mempool unless `confirmed`). */
function payIn(index: number, value: number, confirmed = true): string {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: W.multisig().derive(0, index).script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  box.electrs.addUtxo(W.multisig().derive(0, index).script, { txid, vout: 0, value, height: confirmed ? box.electrs.height : 0 }, hex.encode(raw));
  return txid;
}

/** The page's receive address once the live wallet has read `payments` payments. */
async function page(payments: number): Promise<{ address: string; index: number }> {
  return waitFor(async () => {
    const r = await box.api('GET', '/wallet');
    return r.status === 200 && r.body.payments?.length === payments ? (r.body.receive as { address: string; index: number }) : undefined;
  }, `the page with ${payments} payments`);
}

/** The phone's Receive address after a sync (the Receive screen syncs when it opens). */
async function phoneReceive(): Promise<string> {
  clock.advance(1_000);
  await W.sync();
  return (await W.receiveAddress()).address;
}

describe('the web Wallet page and the phone agree on the receive address', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });

  beforeAll(async () => {
    box = await GuardianRig.start({ clock, http: true });
    W = await TrikeyWallet.create(phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf(), rpcTimeoutMs: 8000 }).deps, { deviceName: 'Receive phone' });
    await W.onboard({ pairingUri: box.pairingUri(), rules: RULES });
    await box.guardian.tick();
    await waitFor(() => box.guardian.live!.lastRead.has(W.state.wallet!.walletId), 'the live read');
  }, 30_000);

  afterAll(async () => {
    await W?.close();
    await box?.stop();
  });

  it('a fresh wallet: index 0 on both', async () => {
    const web = await page(0);
    expect(web.index).toBe(0);
    expect(await phoneReceive()).toBe(web.address);
  });

  it('after a payment, across a gap, with a payment unconfirmed: the same address, one past the highest used', async () => {
    payIn(0, 150_000);
    let web = await page(1);
    expect(web.index).toBe(1);
    expect(await phoneReceive()).toBe(web.address);

    payIn(3, 20_000);
    web = await page(2);
    expect(web.index).toBe(4);
    expect(await phoneReceive()).toBe(web.address);

    payIn(4, 5_000, false);
    web = await page(3);
    expect(web.index).toBe(5);
    expect(await phoneReceive()).toBe(web.address);
  });

  it('looking moves nothing on: page visits leave the phone where it was, and the other way round', async () => {
    const before = await phoneReceive();
    for (let i = 0; i < 5; i++) expect((await page(3)).address).toBe(before);
    for (let i = 0; i < 3; i++) expect(await phoneReceive()).toBe(before);
    expect((await page(3)).address).toBe(before);
  });

  it("the phone's own payment: change goes to the change chain, the receive address stays on both", async () => {
    await box.mine(1);
    clock.advance(1_000);
    await W.sync();
    const before = (await W.receiveAddress()).address;
    const sent = await W.send({ address: externalAddress(), amountSats: 10_000 });
    if (!sent.ok) throw new Error('the payment was refused');
    const web = await page(4);
    expect(web.address).toBe(before);
    expect(await phoneReceive()).toBe(before);
    // The page's limit is the phone's: what the guardian counted for this payment.
    const limit = (await box.api('GET', '/wallet')).body.dailyLimit;
    expect(limit.usedSats).toBe(W.state.guardianStatus?.dailyLimit?.usedSats ?? limit.usedSats);
    expect(limit.usedSats).toBeGreaterThanOrEqual(10_000);
  });

  it('the hardware wallet shows the address the page shows', async () => {
    const web = await page(4);
    const r = await W.receiveAddress({ verifyOnDevice: true });
    expect(r).toMatchObject({ address: web.address, verifiedOnDevice: true });
  });
});
