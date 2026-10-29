/** The guardian-backed single-key chain and scanner, against a scripted guardian client. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { NETWORKS } from '@trikey/core';
import { ErrorCode, RpcError, type MethodName, type Params, type Result } from '@trikey/protocol';
import { GuardianSilentPaymentScanner, GuardianSingleKeyChain, WalletError, refusalFromError, txidOfRaw, type RpcLike } from '../src/index.js';

const network = NETWORKS.regtest;
const account = HDKey.fromMasterSeed(new Uint8Array(32).fill(7), network.bip32).derive("m/84'/1'/1'");
const helperScript = (chain: number, index: number) => hex.encode(btc.p2wpkh(account.deriveChild(chain).deriveChild(index).publicKey!).script);

const txid = (n: number) => n.toString(16).padStart(64, '0');
const sync = (over: Partial<Result<'wallet.sync'>> = {}): Result<'wallet.sync'> => ({
  tipHeight: 100,
  tipHash: '00'.repeat(32),
  utxos: [{ txid: txid(1), vout: 0, valueSats: 20_000, height: 90, confirmations: 11, chain: 0, index: 2, script: helperScript(0, 2) }],
  utxosTruncated: false,
  balance: { confirmedSats: 20_000, unconfirmedSats: 0 },
  history: [],
  historyTruncated: false,
  nextReceiveIndex: 3,
  nextChangeIndex: 1,
  gapLimit: 20,
  coins: [{ script: `5120${'ab'.repeat(32)}`, txid: txid(2), vout: 1, valueSats: 50_000, height: 95, confirmations: 6 }],
  ...over,
});

function fakeRpc(answer: (method: string, params: unknown) => unknown): RpcLike & { calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
      calls.push({ method, params });
      const r = answer(method, params);
      if (r instanceof Error) throw r;
      return r as Result<M>;
    },
  };
}

const helper = () => ({ xpub: account.publicExtendedKey, versions: network.bip32 });

describe('GuardianSingleKeyChain', () => {
  it('serves the helper coins and the registered coins by script, from one wallet.sync until refreshed', async () => {
    const rpc = fakeRpc(() => sync());
    const chain = new GuardianSingleKeyChain(() => rpc, helper);
    const mine = await chain.unspent([helperScript(0, 2), `5120${'ab'.repeat(32)}`, helperScript(0, 9)]);
    expect(mine).toEqual([
      { script: helperScript(0, 2), txid: txid(1), vout: 0, valueSats: 20_000, height: 90, confirmations: 11 },
      { script: `5120${'ab'.repeat(32)}`, txid: txid(2), vout: 1, valueSats: 50_000, height: 95, confirmations: 6 },
    ]);
    expect(await chain.tipHeight()).toBe(100);
    expect(rpc.calls.map((c) => c.method)).toEqual(['wallet.sync']);
    expect(rpc.calls[0]!.params).toEqual({ wallet: 'helper', historyLimit: 1 });
    chain.refresh();
    await chain.tipHeight();
    expect(rpc.calls).toHaveLength(2);
  });

  it('says which helper scripts were used: those below the guardian\'s next unused index on each chain', async () => {
    const chain = new GuardianSingleKeyChain(() => fakeRpc(() => sync()), helper);
    const scripts = [helperScript(0, 0), helperScript(0, 2), helperScript(0, 3), helperScript(1, 0), helperScript(1, 1)];
    expect(await chain.used(scripts)).toEqual([helperScript(0, 0), helperScript(0, 2), helperScript(1, 0)]);
    // Without the helper's key nothing can be said.
    expect(await new GuardianSingleKeyChain(() => fakeRpc(() => sync())).used(scripts)).toEqual([]);
  });

  it('never keeps a failed answer', async () => {
    let n = 0;
    const rpc = fakeRpc(() => (n++ === 0 ? new RpcError(ErrorCode.WalletNotWatched) : sync()));
    const chain = new GuardianSingleKeyChain(() => rpc, helper);
    await expect(chain.tipHeight()).rejects.toBeInstanceOf(WalletError);
    expect(await chain.tipHeight()).toBe(100);
  });

  it('checks that tx.get and tx.broadcast answer for the transaction asked about', async () => {
    const raw = btc.RawTx.encode({ version: 2, segwitFlag: false, inputs: [{ txid: new Uint8Array(32).fill(1), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }], outputs: [{ script: new Uint8Array([0x51]), amount: 1000n }], lockTime: 0 });
    const txHex = hex.encode(raw);
    const id = txidOfRaw(txHex);
    const good = new GuardianSingleKeyChain(() => fakeRpc((m) => (m === 'tx.get' ? { txHex } : { txid: id })));
    expect(await good.getTransaction(id)).toBe(txHex);
    expect(await good.broadcast(txHex)).toBe(id);
    const lying = new GuardianSingleKeyChain(() => fakeRpc((m) => (m === 'tx.get' ? { txHex } : { txid: txid(9) })));
    await expect(lying.getTransaction(txid(9))).rejects.toMatchObject({ code: 'guardian_mismatch' });
    await expect(lying.broadcast(txHex)).rejects.toMatchObject({ code: 'guardian_mismatch' });
  });

  it('turns the guardian\'s refusals into typed ones (a sweep it will not relay)', async () => {
    const chain = new GuardianSingleKeyChain(() => fakeRpc(() => new RpcError(ErrorCode.ForeignTransaction, undefined, { reason: 'output_not_to_wallet' })));
    const e = await chain.broadcast('00').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).refusal).toMatchObject({ kind: 'foreign_transaction', reason: 'output_not_to_wallet' });
  });
});

describe('GuardianSilentPaymentScanner', () => {
  it('asks sp.scan from the height and reports the guardian\'s progress', async () => {
    const match = { txid: txid(5), vout: 0, valueSats: 30_000, outputKey: 'cd'.repeat(32), tweak: 'ef'.repeat(32), height: 99 };
    const rpc = fakeRpc(() => ({ tipHeight: 99, birthHeight: 10, scanning: true, matches: [match], matchesTruncated: false }));
    const r = await new GuardianSilentPaymentScanner(() => rpc).scan(95);
    expect(rpc.calls).toEqual([{ method: 'sp.scan', params: { fromHeight: 95 } }]);
    expect(r).toEqual({ tipHeight: 99, birthHeight: 10, scanning: true, matches: [match], matchesTruncated: false });
  });

  it('1700 and 1701 become refusals the wallet can act on', async () => {
    for (const [code, kind] of [
      [ErrorCode.NodeRpcRequired, 'node_rpc_required'],
      [ErrorCode.SilentPaymentsNotRegistered, 'silent_payments_not_registered'],
    ] as const) {
      const e = await new GuardianSilentPaymentScanner(() => fakeRpc(() => new RpcError(code))).scan(0).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).refusal?.kind).toBe(kind);
      expect(refusalFromError(new RpcError(code))?.kind).toBe(kind);
    }
  });
});
