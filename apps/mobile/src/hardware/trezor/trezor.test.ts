import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { NETWORKS, TX_OPTS, analyzePsbt, buildSpend, buildSweep, compareBytes, parsePsbt } from '@trikey/core';
import type { HardwareWalletPolicy } from '@trikey/wallet';
import { appSigner, fund, hwSigner } from '../../../../../packages/core/test/helpers';
import { HardwareError } from '../errors';
import { HARDENED, formatPath } from '../common/path';
import { bip32VersionsFor, decodeXpub, encodeXpub } from '../common/xpub';
import { parseWalletPolicy } from '../common/wallet';
import { deviceSignatures, makeFixture, network, type Fixture } from '../test/fixtures';
import { coinForNetwork, mergeTrezorSignatures, multisigAt, psbtToTrezorRequest, trezorSignatureToDer } from './convert';
import { mapTrezorError } from './errors';
import { TrezorSigner } from './signer';
import type { TrezorConnectLike, TrezorMultisig, TrezorResponse, TrezorSignTransactionParams } from './types';

const H = HARDENED;
const ACCOUNT = [48 + H, 1 + H, 0 + H, 2 + H];

/** What the Trezor firmware computes from a `multisig` structure: the sortedmulti witness script. */
function scriptFromMultisig(ms: TrezorMultisig): { witnessScript: Uint8Array; script: Uint8Array } {
  const keys = ms.pubkeys.map((p) => {
    const hd = HDKey.fromExtendedKey(p.node, bip32VersionsFor(p.node));
    return p.address_n.reduce((k, n) => k.deriveChild(n), hd).publicKey!;
  });
  const ordered = ms.pubkeys_order === 1 ? [...keys].sort(compareBytes) : keys;
  const pay = btc.p2wsh(btc.p2ms(ms.m, ordered), btc.TEST_NETWORK);
  return { witnessScript: pay.witnessScript!, script: pay.script };
}


type Bip32 = [Uint8Array, { fingerprint: number; path: number[] }][];

/** Rebuilds a PSBT from scratch with some inputs or outputs changed (btc-signer refuses most in-place edits). */
function rebuild(psbt: Uint8Array, edit: { input?: (i: number, v: ReturnType<ReturnType<typeof parsePsbt>['getInput']>) => Record<string, unknown>; output?: (i: number, v: ReturnType<ReturnType<typeof parsePsbt>['getOutput']>) => Record<string, unknown> }): Uint8Array {
  const src = parsePsbt(psbt);
  const tx = new btc.Transaction(TX_OPTS);
  for (let i = 0; i < src.inputsLength; i++) {
    const inp = src.getInput(i);
    tx.addInput(({ ...inp, ...(edit.input?.(i, inp) ?? {}) }) as never);
  }
  for (let i = 0; i < src.outputsLength; i++) {
    const out = src.getOutput(i);
    tx.addOutput(({ ...out, ...(edit.output?.(i, out) ?? {}) }) as never);
  }
  return tx.toPSBT();
}

const withHardwarePath = (v: Bip32 | undefined, fp: string, edit: (path: number[]) => number[]): Bip32 =>
  (v ?? []).map(([pub, d]) => [pub, d.fingerprint === parseInt(fp, 16) ? { ...d, path: edit(d.path) } : d]);

async function twoInputFixture() {
  const f = await makeFixture();
  const utxos = [fund(f.wallet, 0, 3, 60_000n), fund(f.wallet, 1, 7, 50_000n)];
  const plan = buildSpend({ wallet: f.wallet, utxos, recipients: [{ address: f.wallet.derive(0, 9).address, amount: 80_000n }], feeRate: 3, changeIndex: 5 });
  return { f, utxos, plan };
}

describe('PSBT to Trezor signTransaction', () => {
  it('converts every field of a one-input spend with change', async () => {
    const f = await makeFixture();
    const wallet = parseWalletPolicy(f.policy);
    const { params, signerPubkeys } = psbtToTrezorRequest(f.psbt, wallet, f.hardwareFingerprint, 'regtest');
    const tx = parsePsbt(f.psbt);
    const inp = tx.getInput(0);
    const prevTxid = hex.encode(inp.txid!);

    expect(params).toMatchObject({ coin: 'regtest', version: 2, locktime: 0, serialize: false, push: false });
    expect(params.inputs).toHaveLength(1);
    expect(params.outputs).toHaveLength(2);

    const input = params.inputs[0]!;
    expect(input.prev_hash).toBe(prevTxid);
    expect(input.prev_index).toBe(0);
    expect(input.amount).toBe('100000');
    expect(input.sequence).toBe(0xfffffffd);
    expect(input.script_type).toBe('SPENDWITNESS');
    expect(input.address_n).toEqual([...ACCOUNT, 0, 3]);
    expect(input.multisig.m).toBe(2);
    expect(input.multisig.signatures).toEqual(['', '', '']);
    expect(input.multisig.pubkeys_order).toBe(1);
    expect(input.multisig.pubkeys.map((p) => p.node).sort()).toEqual([f.wallet.keys.app.xpub, f.wallet.keys.hardware.xpub, f.wallet.keys.cosigner.xpub].sort());
    for (const p of input.multisig.pubkeys) expect(p.address_n).toEqual([0, 3]);

    // The multisig structure reproduces exactly the script the PSBT spends.
    const derived = scriptFromMultisig(input.multisig);
    expect(derived.witnessScript).toEqual(inp.witnessScript);
    expect(derived.script).toEqual(inp.witnessUtxo!.script);
    // The Trezor's own key is one of the three, at the path in address_n.
    const hw = HDKey.fromExtendedKey(f.wallet.keys.hardware.xpub, bip32VersionsFor(f.wallet.keys.hardware.xpub));
    expect(signerPubkeys[0]).toEqual(hw.deriveChild(0).deriveChild(3).publicKey);

    // Previous transaction, from nonWitnessUtxo.
    expect(params.refTxs).toHaveLength(1);
    const ref = params.refTxs[0]!;
    expect(ref.hash).toBe(prevTxid);
    expect(ref.version).toBe(2);
    expect(ref.lock_time).toBe(0);
    expect(ref.inputs).toEqual([{ prev_hash: expect.stringMatching(/^[0-9a-f]{64}$/), prev_index: 0, script_sig: '51', sequence: 0xffffffff }]);
    expect(ref.bin_outputs).toEqual([{ amount: '100000', script_pubkey: hex.encode(inp.witnessUtxo!.script) }]);
    // ... and it hashes to the outpoint (what the firmware checks).
    const raw = btc.RawTx.encode({ version: ref.version, segwitFlag: false, lockTime: ref.lock_time, inputs: ref.inputs.map((i) => ({ txid: hex.decode(i.prev_hash), index: i.prev_index, finalScriptSig: hex.decode(i.script_sig), sequence: i.sequence })), outputs: ref.bin_outputs.map((o) => ({ amount: BigInt(o.amount), script: hex.decode(o.script_pubkey) })) });
    expect(hex.encode(sha256(sha256(raw)).reverse())).toBe(prevTxid);

    // Outputs: the payment as an address, the change as address_n + multisig.
    expect(params.outputs[0]).toEqual({ address: f.wallet.derive(0, 9).address, amount: '30000', script_type: 'PAYTOADDRESS' });
    const change = params.outputs[1]!;
    if (!('multisig' in change)) throw new Error('the change output must carry a multisig structure');
    expect(change.script_type).toBe('PAYTOWITNESS');
    expect(change.address_n).toEqual([...ACCOUNT, 1, 4]);
    expect(change.multisig.pubkeys.every((p) => p.address_n[0] === 1 && p.address_n[1] === 4)).toBe(true);
    expect(scriptFromMultisig(change.multisig).script).toEqual(tx.getOutput(1).script);
    expect(BigInt(change.amount)).toBe(tx.getOutput(1).amount);
    // Amounts balance: fee = inputs - outputs.
    const fee = 100_000n - 30_000n - BigInt(change.amount);
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(2_000n);
  });

  it('lists the keys in script order and says so', async () => {
    const f = await makeFixture();
    const wallet = parseWalletPolicy(f.policy);
    for (const [chain, index] of [[0, 0], [0, 3], [1, 9], [0, 250]] as const) {
      const ms = multisigAt(wallet, chain, index);
      const keys = ms.pubkeys.map((p) => HDKey.fromExtendedKey(p.node, bip32VersionsFor(p.node)).deriveChild(chain).deriveChild(index).publicKey!);
      expect(keys.every((k, i) => i === 0 || compareBytes(keys[i - 1]!, k) < 0)).toBe(true);
      expect(scriptFromMultisig(ms).script).toEqual(f.wallet.derive(chain, index).script);
    }
  });

  it('handles several inputs from both chains', async () => {
    const { f, plan } = await twoInputFixture();
    const wallet = parseWalletPolicy(f.policy);
    const { params, signerPubkeys } = psbtToTrezorRequest(plan.psbt, wallet, f.hardwareFingerprint, 'regtest');
    expect(params.inputs.map((i) => i.address_n.slice(-2))).toEqual([[0, 3], [1, 7]]);
    expect(params.inputs.map((i) => i.amount)).toEqual(['60000', '50000']);
    expect(params.refTxs).toHaveLength(2);
    expect(signerPubkeys).toHaveLength(2);
    expect(params.inputs.map((i) => scriptFromMultisig(i.multisig).script)).toEqual([f.wallet.derive(0, 3).script, f.wallet.derive(1, 7).script]);
    expect(params.outputs).toHaveLength(2);
    expect(params.outputs[1]).toMatchObject({ script_type: 'PAYTOWITNESS', address_n: [...ACCOUNT, 1, 5] });
  });

  it('sends a payment to our own receive chain as an ordinary address (only chain 1 is change)', async () => {
    const f = await makeFixture();
    const sweep = buildSweep({ from: f.wallet, utxos: [fund(f.wallet, 0, 3, 100_000n)], destination: f.wallet, destinationIndex: 4, feeRate: 2 });
    const { params } = psbtToTrezorRequest(sweep.psbt, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'regtest');
    expect(params.outputs).toEqual([{ address: f.wallet.derive(0, 4).address, amount: String(100_000n - sweep.fee), script_type: 'PAYTOADDRESS' }]);
  });

  it('does not treat an output as change when its claimed key path does not derive to its script', async () => {
    const f = await makeFixture();
    // The change output's derivation says index 99, but its script is address 4's.
    const psbt = rebuild(f.psbt, { output: (i, out) => (i === 1 ? { bip32Derivation: withHardwarePath(out.bip32Derivation as Bip32, f.hardwareFingerprint, (p) => [...p.slice(0, -1), 99]) } : {}) });
    const { params } = psbtToTrezorRequest(psbt, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'regtest');
    expect(params.outputs[1]).toMatchObject({ address: f.wallet.derive(1, 4).address, script_type: 'PAYTOADDRESS' });
  });

  it('uses the right coin for each network, and checks that the keys match it', async () => {
    expect(coinForNetwork('bitcoin')).toBe('btc');
    expect(coinForNetwork('testnet')).toBe('test');
    expect(coinForNetwork('signet')).toBe('test');
    expect(coinForNetwork('regtest')).toBe('regtest');
    const f = await makeFixture();
    expect(() => psbtToTrezorRequest(f.psbt, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'bitcoin')).toThrowError(/mainnet|test network/);
    expect(psbtToTrezorRequest(f.psbt, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'signet').params.coin).toBe('test');
  });

  it('refuses what a Trezor cannot or should not sign', async () => {
    const f = await makeFixture();
    const wallet = parseWalletPolicy(f.policy);
    const run = (psbt: Uint8Array, fp = f.hardwareFingerprint) => () => psbtToTrezorRequest(psbt, wallet, fp, 'regtest');

    // Not this device's wallet.
    expect(run(f.psbt, '00000000')).toThrowError(/not part of the wallet/);

    // No previous transaction (the Trezor needs refTxs).
    const noPrev = buildSpend({
      wallet: f.wallet,
      utxos: [{ ...fund(f.wallet, 0, 3, 100_000n), prevTxHex: undefined }],
      recipients: [{ address: f.wallet.derive(0, 9).address, amount: 30_000n }],
      feeRate: 2,
      changeIndex: 4,
    });
    expect(run(noPrev.psbt)).toThrowError(/previous transaction/);

    // The claimed key path does not derive to the script.
    const moved = rebuild(f.psbt, { input: (_i, inp) => ({ bip32Derivation: withHardwarePath(inp.bip32Derivation as Bip32, f.hardwareFingerprint, (p) => [...p.slice(0, -1), 99]) }) });
    expect(run(moved)).toThrowError(/does not belong|different key/);

    // A different origin path than the wallet's.
    const wrongOrigin = rebuild(f.psbt, { input: (_i, inp) => ({ bip32Derivation: withHardwarePath(inp.bip32Derivation as Bip32, f.hardwareFingerprint, (p) => [44 + H, ...p.slice(1)]) }) });
    expect(run(wrongOrigin)).toThrowError(/this wallet uses/);

    // A sighash type other than ALL.
    expect(run(rebuild(f.psbt, { input: () => ({ sighashType: btc.SigHash.SINGLE }) }))).toThrowError(/SIGHASH_ALL/);

    // Garbage.
    expect(run(new Uint8Array([1, 2, 3]))).toThrowError(HardwareError);
  });
});

describe('signatures back into the PSBT', () => {
  async function trezorStyleSignatures(psbt: Uint8Array, form: 'der' | 'der+sighash' | 'compact' = 'der') {
    return (await deviceSignatures(psbt)).map((s) => {
      const der = s.signature.slice(0, -1);
      if (form === 'der') return hex.encode(der);
      if (form === 'der+sighash') return hex.encode(s.signature);
      return hex.encode(trezorCompact(der));
    });
  }
  /** DER back to r||s, as an independent decoder: 0x30 len 0x02 rlen r 0x02 slen s. */
  function trezorCompact(der: Uint8Array): Uint8Array {
    const rlen = der[3]!;
    const r = der.slice(4, 4 + rlen);
    const sOff = 4 + rlen + 2;
    const s = der.slice(sOff, sOff + der[sOff - 1]!);
    const pad = (x: Uint8Array) => {
      const t = x[0] === 0 ? x.slice(1) : x;
      const o = new Uint8Array(32);
      o.set(t, 32 - t.length);
      return o;
    };
    return new Uint8Array([...pad(r), ...pad(s)]);
  }

  for (const form of ['der', 'der+sighash', 'compact'] as const) {
    it(`merges ${form} signatures from two inputs next to the app signature`, async () => {
      const { f, plan } = await twoInputFixture();
      const appSigned = await appSigner().signPsbt(plan.psbt, network);
      const request = psbtToTrezorRequest(appSigned, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'regtest');
      const merged = mergeTrezorSignatures(appSigned, request, await trezorStyleSignatures(appSigned, form));
      const analysis = analyzePsbt(merged, f.wallet.accountPubkeys(), network);
      expect(analysis.inputs.map((i) => i.signedBy.sort())).toEqual([['app', 'hardware'], ['app', 'hardware']]);
      // Complete: the PSBT now finalizes to a transaction.
      const done = parsePsbt(merged);
      done.finalize();
      expect(done.extract().length).toBeGreaterThan(200);
    });
  }

  it('refuses wrong counts, empty and invalid signatures', async () => {
    const { f, plan } = await twoInputFixture();
    const request = psbtToTrezorRequest(plan.psbt, parseWalletPolicy(f.policy), f.hardwareFingerprint, 'regtest');
    const good = await trezorStyleSignatures(plan.psbt);
    const merge = (sigs: string[]) => () => mergeTrezorSignatures(plan.psbt, request, sigs);
    expect(merge([good[0]!])).toThrowError(/2 inputs/);
    expect(merge([good[0]!, ''])).toThrowError(/did not sign input 1/);
    expect(merge([good[1]!, good[0]!])).toThrowError(/does not verify/);
    expect(merge([good[0]!, 'zz'])).toThrowError(/malformed/);
    expect(merge([good[0]!, '0102'])).toThrowError(/unknown format/);
    expect(merge(good)).not.toThrow();
  });

  it('reads DER, DER with sighash and compact forms', async () => {
    const [s] = await deviceSignatures((await makeFixture()).psbt);
    const der = s!.signature.slice(0, -1);
    expect(trezorSignatureToDer(hex.encode(der))).toEqual(der);
    expect(trezorSignatureToDer(hex.encode(s!.signature))).toEqual(der);
    expect(trezorSignatureToDer(`0x${hex.encode(der)}`)).toEqual(der);
  });
});

// -------------------------------------------------------------------------------------------------- the signer

/** A fake Trezor Connect that behaves like the firmware: it checks what it is sent and signs with the throwaway key. */
class FakeConnect implements TrezorConnectLike {
  calls: Array<{ method: string; params: unknown }> = [];
  inFlight = 0;
  maxInFlight = 0;
  cancelled: string[] = [];
  respond?: (method: string, params: unknown) => TrezorResponse<never> | undefined;
  delay = 0;
  addressOverride?: string;
  signature = base64.encode(new Uint8Array([40, ...new Uint8Array(64).fill(5)]));

  constructor(private readonly f: Fixture) {}

  private async run<T>(method: string, params: unknown, fn: () => Promise<TrezorResponse<T>> | TrezorResponse<T>): Promise<TrezorResponse<T>> {
    this.calls.push({ method, params });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      return (this.respond?.(method, params) as TrezorResponse<T> | undefined) ?? (await fn());
    } finally {
      this.inFlight--;
    }
  }

  getPublicKey(params: Parameters<TrezorConnectLike['getPublicKey']>[0]) {
    return this.run('getPublicKey', params, () => {
      const path = typeof params.path === 'string' ? params.path : formatPath(params.path);
      return { success: true as const, payload: { xpub: this.f.hardwareXpub, fingerprint: 1, rootFingerprint: parseInt(this.f.hardwareFingerprint, 16), path: path.replace(/^m\//, '').split('/').map((p) => (p.endsWith("'") ? parseInt(p) + H : parseInt(p))), depth: 4 } };
    });
  }

  getAddress(params: Parameters<TrezorConnectLike['getAddress']>[0]) {
    return this.run('getAddress', params, () => {
      const script = scriptFromMultisig(params.multisig).script;
      const address = this.addressOverride ?? btc.Address(NETWORKS.regtest.btc).encode(btc.OutScript.decode(script));
      return { success: true as const, payload: { address, path: params.path as number[] } };
    });
  }

  signTransaction(params: TrezorSignTransactionParams) {
    return this.run<{ signatures: string[] }>('signTransaction', params, async (): Promise<TrezorResponse<{ signatures: string[] }>> => {
      // What the firmware insists on: every input's previous transaction hashes to its outpoint.
      for (const i of params.inputs) {
        const ref = params.refTxs.find((r) => r.hash === i.prev_hash);
        if (!ref) return { success: false, payload: { error: 'Missing previous transaction', code: 'Failure_DataError' } };
      }
      // It signs with its key, found through `address_n`, for the inputs it can derive.
      const psbt = this.f.psbt;
      const sigs = await deviceSignatures(psbt);
      return { success: true, payload: { signatures: sigs.map((s) => hex.encode(s.signature.slice(0, -1))) } };
    });
  }

  signMessage(params: Parameters<TrezorConnectLike['signMessage']>[0]) {
    return this.run('signMessage', params, () => ({ success: true as const, payload: { address: 'bcrt1qxyz', signature: this.signature } }));
  }

  cancel(reason?: string) {
    this.cancelled.push(reason ?? '');
  }
}

async function setupSigner(net: 'regtest' | 'testnet' | 'signet' | 'bitcoin' = 'regtest') {
  const f = await makeFixture();
  const connect = new FakeConnect(f);
  const signer = new TrezorSigner({ kind: 'trezor', fingerprint: f.hardwareFingerprint }, connect, { network: net });
  return { f, connect, signer };
}

describe('TrezorSigner', () => {
  it('asks for the xpub with the right coin, caches it, and checks the answer', async () => {
    for (const [net, coin] of [['regtest', 'regtest'], ['testnet', 'test'], ['signet', 'test']] as const) {
      const { f, connect, signer } = await setupSigner(net);
      expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
      expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
      expect(connect.calls).toHaveLength(1);
      expect(connect.calls[0]).toEqual({ method: 'getPublicKey', params: { path: "m/48'/1'/0'/2'", coin, showOnTrezor: false } });
    }
    const { connect, signer } = await setupSigner('bitcoin');
    // A tpub for a mainnet request is refused.
    await expect(signer.getXpub("m/48'/0'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response' });
    expect(connect.calls[0]!.params).toMatchObject({ coin: 'btc' });
    await expect(signer.getXpub("m/48'/2'/0'/2'")).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(signer.getXpub('m')).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('refuses a key answer for another path', async () => {
    const { connect, signer } = await setupSigner();
    connect.respond = () => ({ success: true, payload: { xpub: 'x', fingerprint: 0, path: [1, 2], depth: 2 } as never });
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('seeds the xpub fetched while connecting', async () => {
    const f = await makeFixture();
    const connect = new FakeConnect(f);
    const signer = new TrezorSigner({ kind: 'trezor', fingerprint: f.hardwareFingerprint }, connect, { network: 'regtest', knownXpubs: { "m/48'/1'/0'/2'": f.hardwareXpub } });
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
    expect(connect.calls).toHaveLength(0);
  });

  it('normalises SLIP-132 keys', async () => {
    const { f, connect, signer } = await setupSigner();
    const d = decodeXpub(f.hardwareXpub);
    connect.respond = () => ({ success: true, payload: { xpub: encodeXpub({ ...d, version: 0x02575483 }), fingerprint: 0, path: ACCOUNT, depth: 4 } as never });
    expect(await signer.getXpub("m/48'/1'/0'/2'")).toBe(f.hardwareXpub);
  });

  it('needs no registration', async () => {
    const { f, connect, signer } = await setupSigner();
    expect(await signer.registerWallet(f.policy)).toEqual({});
    expect(connect.calls).toHaveLength(0);
    const stranger = new TrezorSigner({ kind: 'trezor', fingerprint: '00000000' }, connect, { network: 'regtest' });
    await expect(stranger.registerWallet(f.policy)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('shows an address with the multisig structure, and compares it with the one the wallet derives', async () => {
    const { f, connect, signer } = await setupSigner();
    expect(await signer.displayAddress(f.policy, 1, 6)).toBe(f.wallet.derive(1, 6).address);
    const call = connect.calls[0]!;
    expect(call.method).toBe('getAddress');
    const p = call.params as Parameters<TrezorConnectLike['getAddress']>[0];
    expect(p).toMatchObject({ coin: 'regtest', scriptType: 'SPENDWITNESS', showOnTrezor: true, path: [...ACCOUNT, 1, 6] });
    expect(p.multisig.m).toBe(2);
    expect(p.multisig.signatures).toEqual(['', '', '']);

    connect.addressOverride = f.wallet.derive(1, 7).address;
    await expect(signer.displayAddress(f.policy, 1, 6)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(signer.displayAddress(f.policy, 3 as 0, 6)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('signs a PSBT end to end', async () => {
    const { f, connect, signer } = await setupSigner();
    const out = await signer.signPsbt(base64.encode(f.psbtAppSigned), f.policy);
    const analysis = analyzePsbt(base64.decode(out), f.wallet.accountPubkeys(), network);
    expect(analysis.inputs[0]!.signedBy.sort()).toEqual(['app', 'hardware']);
    expect(connect.calls.map((c) => c.method)).toEqual(['signTransaction']);
    // The CCDT tweaks and derivations survive.
    expect(parsePsbt(base64.decode(out)).getInput(0).proprietary).toHaveLength(3);
  });

  it('maps failures: rejected on the device, closed Suite, bad data', async () => {
    const { f, connect, signer } = await setupSigner();
    connect.respond = () => ({ success: false, payload: { error: 'Action cancelled by user', code: 'Failure_ActionCancelled' } });
    await expect(signer.signPsbt(f.psbtBase64, f.policy)).rejects.toMatchObject({ code: 'user-rejected', kind: 'trezor' });
    connect.respond = () => ({ success: false, payload: { error: 'Device not found', code: 'Device_NotFound' } });
    await expect(signer.displayAddress(f.policy, 0, 1)).rejects.toMatchObject({ code: 'disconnected' });
    connect.respond = () => {
      throw new Error('deeplink exploded');
    };
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toBeInstanceOf(HardwareError);
  });

  it('signs messages: coin from the path, BIP137 signature checked', async () => {
    const { connect, signer } = await setupSigner('signet');
    const sig = await signer.signMessage("m/84'/1'/0'/0/0", 'Trikey pair v1');
    expect(base64.decode(sig)).toHaveLength(65);
    expect(connect.calls[0]).toEqual({ method: 'signMessage', params: { path: "m/84'/1'/0'/0/0", coin: 'test', message: 'Trikey pair v1' } });
    connect.signature = base64.encode(new Uint8Array(65).fill(1));
    await expect(signer.signMessage("m/84'/1'/0'/0/0", 'x')).rejects.toMatchObject({ code: 'invalid-response' });
    connect.signature = base64.encode(new Uint8Array(10));
    await expect(signer.signMessage("m/84'/1'/0'/0/0", 'x')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(signer.signMessage("m/84'/1'/0'/0/0", 'café')).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('runs one request at a time and cancels on close', async () => {
    const { f, connect, signer } = await setupSigner();
    connect.delay = 5;
    await Promise.all([signer.getXpub("m/48'/1'/0'/2'"), signer.displayAddress(f.policy, 0, 1), signer.signMessage("m/84'/1'/0'/0/0", 'a')]);
    expect(connect.maxInFlight).toBe(1);
    expect(connect.calls.map((c) => c.method)).toEqual(['getPublicKey', 'getAddress', 'signMessage']);
    await signer.close();
    expect(connect.cancelled).toEqual(['closed']);
  });

  it('keeps going after a failed request', async () => {
    const { connect, signer } = await setupSigner();
    connect.respond = () => ({ success: false, payload: { error: 'x', code: 'Method_Cancel' } });
    await expect(signer.getXpub("m/48'/1'/0'/2'")).rejects.toMatchObject({ code: 'user-rejected' });
    connect.respond = undefined;
    await expect(signer.getXpub("m/48'/1'/0'/2'")).resolves.toMatch(/^tpub/);
  });
});

describe('mapTrezorError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['rejected on the device', { error: 'Action cancelled by user', code: 'Failure_ActionCancelled' }, 'user-rejected'],
    ['cancelled in Suite', { error: 'Cancelled', code: 'Method_Cancel' }, 'user-rejected'],
    ['window closed', { error: 'Popup closed', code: 'Method_Interrupted' }, 'cancelled'],
    ['no device', { error: 'Device not found', code: 'Device_NotFound' }, 'disconnected'],
    ['busy', { error: 'busy', code: 'Device_CallInProgress' }, 'device-error'],
    ['no Suite', { error: 'no transport', code: 'Transport_Missing' }, 'unavailable'],
    ['not initialised', { error: 'Init_NotInitialized' , code: 'Init_NotInitialized' }, 'unavailable'],
    ['bad parameter', { error: 'path is invalid', code: 'Method_InvalidParameter' }, 'invalid-request'],
    ['forbidden path (no code)', { error: 'Forbidden key path' }, 'invalid-request'],
    ['text only: cancelled', { error: 'The user cancelled' }, 'user-rejected'],
    ['deep link with no response', { error: 'The provided url is missing `response` parameter.' }, 'unavailable'],
    ['unknown', { error: 'kaboom', code: 'Weird' }, 'device-error'],
    ['a thrown Error', new Error('timed out'), 'timeout'],
    ['our own cancel(reason)', { success: false, error: 'closed' }, 'cancelled'],
    ['a callback URL that does not parse (Error object)', { success: false, error: new TypeError('Invalid URL') }, 'device-error'],
  ];
  it.each(cases)('%s', (_n, input, code) => {
    const e = mapTrezorError(input);
    expect(e.code).toBe(code);
    expect(e.kind).toBe('trezor');
  });
});

// ------------------------------------------------------------------ the real @trezor/connect-mobile deep-link client

describe('TrezorSigner over the real connect-mobile deep-link client (offline)', () => {
  // What Trezor Suite Lite would do: read the request from the deep link, then open our callback URL with the result.
  async function realConnect() {
    const { default: TrezorConnect } = await import('@trezor/connect-mobile');
    const opened: string[] = [];
    await TrezorConnect.init({
      manifest: { appName: 'Trikey', appUrl: 'https://example.invalid', email: 'dev@example.invalid' },
      deeplinkOpen: (url: string) => void opened.push(url),
      deeplinkCallbackUrl: 'trikey://trezor-callback',
    });
    const request = () => {
      const url = new URL(opened.at(-1)!);
      const callback = new URL(url.searchParams.get('callback')!);
      return { method: url.searchParams.get('method'), params: JSON.parse(url.searchParams.get('params')!), callback };
    };
    const answer = (response?: unknown) => {
      const { callback } = request();
      if (response !== undefined) callback.searchParams.set('response', JSON.stringify(response));
      TrezorConnect.handleDeeplink(callback.toString());
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { connect: TrezorConnect as unknown as TrezorConnectLike, request, answer, tick };
  }

  it('sends our parameters through the deep link and reads the answer', async () => {
    const f = await makeFixture();
    const { connect, request, answer, tick } = await realConnect();
    const signer = new TrezorSigner({ kind: 'trezor', fingerprint: f.hardwareFingerprint }, connect, { network: 'regtest' });
    const p = signer.getXpub("m/48'/1'/0'/2'");
    await tick();
    expect(request()).toMatchObject({ method: 'getPublicKey', params: { path: "m/48'/1'/0'/2'", coin: 'regtest', showOnTrezor: false } });
    answer({ success: true, payload: { xpub: f.hardwareXpub, path: [48 + H, 1 + H, H, 2 + H], fingerprint: 1, depth: 4 } });
    expect(await p).toBe(f.hardwareXpub);
  });

  it('reports a callback without a result, and its own cancellation, as typed errors', async () => {
    const f = await makeFixture();
    const { connect, answer, tick } = await realConnect();
    const signer = new TrezorSigner({ kind: 'trezor', fingerprint: f.hardwareFingerprint }, connect, { network: 'regtest' });
    // connect-mobile resolves this one as { success: false, error } with no payload.
    const missing = signer.getXpub("m/48'/1'/0'/2'");
    await tick();
    answer();
    await expect(missing).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('`response`') });
    // And a call cut short by cancel(reason) as { payload: { success: false, error: reason } }.
    const closed = signer.getXpub("m/48'/1'/0'/2'");
    await tick();
    await signer.close();
    await expect(closed).rejects.toMatchObject({ code: 'cancelled' });
  });
});
