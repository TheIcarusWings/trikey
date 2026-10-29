/** The Esplora client against the fake server, and the simulated chain's consensus and policy rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { TX_OPTS } from '@trikey/core';
import { DEFAULT_ESPLORA_URLS, EsploraChainSource, EsploraClient, PUBLIC_SERVER_PRIVACY_NOTE, rejectReason, scanAccount } from '../src/esplora.js';
import { SimChain, simFetch } from '../src/testing/index.js';
import { startFakeEsplora, type FakeEsplora } from '../src/testing/esplora-server.js';
import { SPENDING_RECEIVE, SpendingAccount, buildCpfpChild, buildSpendingPayment, finalizeSpending, signSpendingPsbt, type SpendingCoin } from '../src/spending.js';
import { deriveKey2 } from '../src/keys.js';
import { MNEMONICS, externalAddress, fixtureKeys, network, rejects } from './helpers.js';

const account = new SpendingAccount(network, deriveKey2(MNEMONICS.phone, network).spending);

function coinAt(chain: SimChain, txid: string, vout: number, index: number): SpendingCoin {
  const t = chain.getTx(txid)!;
  return { txid, vout, value: BigInt(t.json.vout[vout]!.value), chain: SPENDING_RECEIVE, index, height: t.status.confirmed ? (t.status as { block_height: number }).block_height : 0, prevTxHex: t.hex };
}

function pay(coins: SpendingCoin[], amount: bigint, feeRate: number, edit?: (tx: btc.Transaction) => void, changeIndex = 900): { txid: string; txHex: string; fee: bigint; vsize: number } {
  const plan = buildSpendingPayment({ account, coins, address: externalAddress(), amount, feeRate, changeIndex });
  let psbt = plan.psbt;
  if (edit) {
    const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
    edit(tx);
    psbt = tx.toPSBT();
  }
  return finalizeSpending(signSpendingPsbt(psbt, MNEMONICS.phone, network));
}

describe('Esplora client over HTTP', () => {
  let srv: FakeEsplora;
  let client: EsploraClient;
  beforeAll(async () => {
    srv = await startFakeEsplora(new SimChain({ height: 150 }));
    client = new EsploraClient({ baseUrl: `${srv.url}/` });
  });
  afterAll(() => srv.close());

  it('reads the tip, addresses, transactions, statuses, spends and fee estimates', async () => {
    const chain = srv.chain;
    expect(await client.tipHeight()).toBe(150);
    expect(await client.tipHash()).toMatch(/^[0-9a-f]{64}$/);
    const a = account.derive(0, 0).address;
    const { txid } = chain.fund(a, 50_000n);
    expect((await client.txStatus(txid))!.confirmed).toBe(false);
    expect((await client.addressUtxos(a))[0]).toMatchObject({ txid, vout: 0, value: 50_000, status: { confirmed: false } });
    chain.mine(1);
    expect(await client.txStatus(txid)).toMatchObject({ confirmed: true, block_height: 151 });
    expect((await client.addressTxs(a)).map((t) => t.txid)).toEqual([txid]);
    expect(await client.txHex(txid)).toBe(chain.getTx(txid)!.hex);
    expect(await client.txStatus('00'.repeat(32))).toBeUndefined();
    expect(await client.tx('00'.repeat(32))).toBeUndefined();
    expect(await client.outspend(txid, 0)).toEqual({ spent: false });
    expect((await client.feeEstimates())[6]).toBe(1.5);

    const spend = pay([coinAt(chain, txid, 0, 0)], 20_000n, 2);
    expect(await client.broadcast(spend.txHex)).toBe(spend.txid);
    // Broadcasting again is not an error.
    expect(await client.broadcast(spend.txHex)).toBe(spend.txid);
    expect(await client.outspend(txid, 0)).toMatchObject({ spent: true, txid: spend.txid, vin: 0 });
    expect((await client.addressTxs(a)).map((t) => t.txid)).toEqual([spend.txid, txid]);
  });

  it('pages through more than 25 confirmed transactions of an address', async () => {
    const chain = srv.chain;
    const a = account.derive(0, 5).address;
    for (let i = 0; i < 60; i++) chain.fund(a, 10_000n + BigInt(i));
    chain.mine(1);
    expect(await client.addressTxs(a)).toHaveLength(60);
  });

  it('reports refusals with Bitcoin Core’s reason, and refuses answers that do not check out', async () => {
    const chain = srv.chain;
    const a = account.derive(0, 1).address;
    const { txid } = chain.fund(a, 50_000n);
    chain.mine(1);
    const c = coinAt(chain, txid, 0, 1);
    const spend = pay([c], 20_000n, 2);
    await client.broadcast(spend.txHex);
    chain.mine(1);
    const e = await rejects(client.broadcast(pay([c], 21_000n, 2).txHex));
    expect(e.code).toBe('broadcast_rejected');
    expect(e.detail?.reason).toBe('bad-txns-inputs-missingorspent');
    expect(rejectReason('sendrawtransaction RPC error: {"code":-26,"message":"non-BIP68-final"}')).toBe('non-BIP68-final');

    srv.hooks.intercept = (_m, path) => (path.endsWith('/hex') ? { status: 200, body: chain.getTx(spend.txid)!.hex, type: 'text' } : undefined);
    expect((await rejects(client.txHex(txid))).code).toBe('chain_source');
    srv.hooks.intercept = (_m, path) => (path.includes('/utxo') ? { status: 200, body: '{"not": "a list"}', type: 'json' } : undefined);
    expect((await rejects(client.addressUtxos(a))).code).toBe('chain_source');
    srv.hooks.intercept = () => ({ status: 503, body: 'busy', type: 'text' });
    expect((await rejects(client.tipHeight())).code).toBe('chain_source');
    srv.hooks.intercept = undefined;
    const dead = new EsploraClient({ baseUrl: 'http://127.0.0.1:1' });
    expect((await rejects(dead.tipHeight())).code).toBe('chain_source');
  });

  it('defaults to a public server per network, and says what it learns', () => {
    expect(EsploraClient.forNetwork('signet').baseUrl).toBe(DEFAULT_ESPLORA_URLS.signet);
    expect(EsploraClient.forNetwork('regtest', { baseUrl: 'http://umbrel.local:3006/api' }).baseUrl).toBe('http://umbrel.local:3006/api');
    expect(PUBLIC_SERVER_PRIVACY_NOTE).toMatch(/cannot move or freeze/);
  });
});

describe('simulated chain rules', () => {
  function setup() {
    const chain = new SimChain({ height: 200 });
    const client = new EsploraClient({ baseUrl: 'sim://esplora', fetch: simFetch(chain) });
    const fund = (value: bigint, index = 0) => {
      const { txid } = chain.fund(account.derive(0, index).address, value);
      chain.mine(1);
      return coinAt(chain, txid, 0, index);
    };
    return { chain, client, fund };
  }

  it('enforces BIP 68 relative locks by height, counting from the coin’s block', async () => {
    const { chain, client, fund } = setup();
    const c = fund(100_000n); // confirmed at 201
    const locked = pay([c], 50_000n, 2, (tx) => tx.updateInput(0, { sequence: 5 }));
    for (let tip = 201; tip < 205; tip++) {
      expect((await rejects(client.broadcast(locked.txHex))).detail?.reason).toBe('non-BIP68-final');
      chain.mine(1);
    }
    // Tip 205: the next block is 206 = 201 + 5.
    expect(await client.broadcast(locked.txHex)).toBe(locked.txid);
    // Version 1 ignores the lock.
    const c2 = fund(100_000n, 1);
    const v1 = pay([c2], 50_000n, 2, (tx) => {
      tx.updateInput(0, { sequence: 500 });
      (tx as unknown as { global: { txVersion: number } }).global.txVersion = 1;
    });
    expect(await client.broadcast(v1.txHex)).toBe(v1.txid);
  });

  it('refuses a relative lock on an unconfirmed parent, and a future nLockTime', async () => {
    const { chain, client, fund } = setup();
    const parent = pay([fund(100_000n)], 60_000n, 2, undefined, 7);
    await client.broadcast(parent.txHex);
    const change = { txid: parent.txid, vout: 1, value: BigInt(chain.getTx(parent.txid)!.json.vout[1]!.value), chain: 1, index: 7, height: 0, prevTxHex: parent.txHex };
    const child = pay([change], 10_000n, 2, (tx) => tx.updateInput(0, { sequence: 1 }), 8);
    expect((await rejects(client.broadcast(child.txHex))).detail?.reason).toBe('non-BIP68-final');
    const c = fund(100_000n, 2);
    const future = pay([c], 10_000n, 2, (tx) => ((tx as unknown as { global: { fallbackLocktime: number } }).global.fallbackLocktime = chain.height + 5));
    expect((await rejects(client.broadcast(future.txHex))).detail?.reason).toBe('non-final');
  });

  it('checks signatures and amounts, and applies BIP 125 replacement rules', async () => {
    const { chain, client, fund } = setup();
    const c = fund(100_000n);
    const good = pay([c], 50_000n, 2);
    const raw = btc.RawTx.decode(hex.decode(good.txHex));
    raw.witnesses![0]![0]![10]! ^= 1;
    expect((await rejects(client.broadcast(hex.encode(btc.RawTx.encode(raw))))).detail?.reason).toMatch(/^mandatory-script-verify-flag-failed/);
    await client.broadcast(good.txHex);
    const cheaper = pay([c], 50_000n, 1);
    expect((await rejects(client.broadcast(cheaper.txHex))).detail?.reason).toMatch(/insufficient fee/);
    const better = pay([c], 50_000n, 10);
    expect(await client.broadcast(better.txHex)).toBe(better.txid);
    expect(chain.inMempool(good.txid)).toBe(false);
    expect(chain.inMempool(better.txid)).toBe(true);
    chain.mine(1);
    expect(chain.isConfirmed(better.txid)).toBe(true);
  });

  it('mines a low-fee parent once a CPFP child lifts the package', async () => {
    const { chain, client, fund } = setup();
    chain.minMiningFeeRate = 10;
    const parent = pay([fund(300_000n)], 100_000n, 2, undefined, 3);
    await client.broadcast(parent.txHex);
    chain.mine(3);
    expect(chain.inMempool(parent.txid)).toBe(true);
    const out = { txid: parent.txid, vout: 1, value: BigInt(chain.getTx(parent.txid)!.json.vout[1]!.value), chain: 1, index: 3, height: 0, prevTxHex: parent.txHex };
    const plan = buildCpfpChild({ account, parentOutput: out, parentVsize: parent.vsize, parentFee: parent.fee, targetRate: 12, changeIndex: 4 });
    const child = finalizeSpending(signSpendingPsbt(plan.psbt, MNEMONICS.phone, network));
    await client.broadcast(child.txHex);
    chain.mine(1);
    expect(chain.isConfirmed(parent.txid)).toBe(true);
    expect(chain.isConfirmed(child.txid)).toBe(true);
  });
});

describe('account scanning and the ChainSource adapter', () => {
  it('scans with a gap limit and reserved indices, and syncs the vault as a ChainSnapshot', async () => {
    const chain = new SimChain({ height: 300 });
    const client = new EsploraClient({ baseUrl: 'sim://x', fetch: simFetch(chain) });
    const { vault } = await fixtureKeys();
    chain.fund(vault.derive(0, 0).address, 1_000_000n);
    chain.fund(vault.derive(0, 15).address, 2_000_000n);
    chain.fund(vault.derive(1, 30).address, 3_000n);
    chain.mine(2);
    chain.fund(vault.derive(0, 2).address, 5_000n);
    const derive = (c: number, i: number) => ({ chain: c, index: i, address: vault.derive(c, i).address, script: vault.derive(c, i).script });
    const plain = await scanAccount(client, derive, { gapLimit: 20 });
    expect(plain.nextIndex).toEqual({ 0: 16, 1: 0 });
    expect(plain.unspent.reduce((s, c) => s + c.value, 0n)).toBe(3_005_000n);
    const reserved = await scanAccount(client, derive, { gapLimit: 20, minIndex: { 1: 31 } });
    expect(reserved.nextIndex[1]).toBe(31);

    const src = new EsploraChainSource(client, vault, { minIndex: { 1: 31 } });
    const snap = await src.sync();
    expect(snap.tipHeight).toBe(302);
    expect(snap.balance).toEqual({ confirmedSats: 3_003_000, unconfirmedSats: 5_000 });
    expect(snap.utxos.find((u) => u.index === 15)).toMatchObject({ chain: 0, valueSats: 2_000_000, confirmations: 2 });
    expect(snap.history[0]!.height).toBe(0);
    expect(snap.nextReceiveIndex).toBe(16);
    expect((await src.estimateFees([2, 5])).estimates).toEqual([{ target: 2, satPerVb: 2 }, { target: 5, satPerVb: 1.5 }]);
  });
});
