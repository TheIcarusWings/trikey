/**
 * Test doubles for silent payments over the guardian rig's fake Electrs: chain data by script for the phone's
 * single-key coins (`SingleKeyChainSource`), and blocks with prevouts for the local scanner (`BlockSource`, what
 * bitcoind's `getblock <hash> 3` gives a full node). Regtest only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TX_OPTS } from '@trikey/core';
import type { FakeElectrum, GuardianRig } from '@trikey/guardian/testing';
import { createOutputs } from '@trikey/silent-payments';
import type { BlockSource, FeeEstimates, ScanBlock, ScriptUtxo, SingleKeyChainSource } from '../src/index.js';

const scriptHash = (scriptHex: string) => hex.encode(sha256(hex.decode(scriptHex)).reverse());

const decodeTx = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });

/** The user's own Electrum server, for the helper coin and received silent payments. */
export class FakeSingleKeyChain implements SingleKeyChainSource {
  readonly kind = 'test-electrum';
  readonly broadcasts: string[] = [];

  constructor(
    private readonly electrs: FakeElectrum,
    private readonly opts: { onBroadcast?: (txHex: string) => void } = {},
  ) {}

  async tipHeight(): Promise<number> {
    return this.electrs.height;
  }

  async unspent(scripts: string[]): Promise<ScriptUtxo[]> {
    const tip = this.electrs.height;
    return scripts.flatMap((script) =>
      (this.electrs.unspent.get(scriptHash(script)) ?? []).map((u) => ({
        script,
        txid: u.txid,
        vout: u.vout,
        valueSats: u.value,
        height: Math.max(0, u.height),
        confirmations: u.height > 0 ? tip - u.height + 1 : 0,
      })),
    );
  }

  async used(scripts: string[]): Promise<string[]> {
    return scripts.filter((s) => (this.electrs.history.get(scriptHash(s)) ?? []).length > 0);
  }

  async getTransaction(txid: string): Promise<string> {
    const raw = this.electrs.txs.get(txid);
    if (!raw) throw new Error(`unknown transaction ${txid}`);
    const tx = btc.RawTx.decode(hex.decode(raw));
    return hex.encode(btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }));
  }

  async broadcast(txHex: string): Promise<string> {
    const err = this.electrs.applyTransaction(txHex);
    if (err) throw new Error(`the node refused it: ${err}`);
    this.electrs.broadcasts.push(txHex);
    this.broadcasts.push(txHex);
    this.opts.onBroadcast?.(txHex);
    return decodeTx(txHex).id;
  }

  async estimateFees(): Promise<FeeEstimates> {
    return { estimates: [{ target: 3, satPerVb: 10 }], minRelaySatPerVb: 1 };
  }
}

/** Blocks of the fake chain with each input's previous output (transactions whose prevouts are unknown are left out). */
export class ElectrsBlockSource implements BlockSource {
  constructor(private readonly electrs: FakeElectrum) {}

  async tipHeight(): Promise<number> {
    return this.electrs.height;
  }

  async block(height: number): Promise<ScanBlock> {
    const ids = new Set<string>();
    for (const list of this.electrs.history.values()) for (const h of list) if (h.height === height) ids.add(h.tx_hash);
    const txs: ScanBlock['txs'] = [];
    for (const id of ids) {
      const raw = this.electrs.txs.get(id);
      if (!raw) continue;
      const tx = decodeTx(raw);
      const prevouts: ScanBlock['txs'][number]['prevouts'] = [];
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        const prevRaw = this.electrs.txs.get(hex.encode(inp.txid!));
        const out = prevRaw ? decodeTx(prevRaw).getOutput(inp.index!) : undefined;
        if (!out?.script) break;
        prevouts.push({ script: out.script, amount: out.amount! });
      }
      if (prevouts.length === tx.inputsLength) txs.push({ hex: raw, prevouts });
    }
    return { height, txs };
  }
}

/** Copies a transaction's outputs into another fake Electrs (two guardians watching one chain). */
export function mirrorOutputs(to: FakeElectrum, txHex: string, height = 0): void {
  const tx = decodeTx(txHex);
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    to.addUtxo(o.script!, { txid: tx.id, vout: i, value: Number(o.amount), height }, txHex);
  }
}

let payerSeed = 1;
/**
 * Somebody else pays silent payment addresses: a fresh confirmed P2WPKH coin (funded "from nowhere") spent to one
 * taproot output of 30,000 sats per recipient, into the rig's mempool (the next `mine` puts it in a block).
 */
export function externalPayment(rig: GuardianRig, recipients: string[]): { txid: string; txHex: string } {
  const key = sha256(new TextEncoder().encode(`outside payer ${payerSeed++}`));
  const script = btc.p2wpkh(secp256k1.getPublicKey(key, true)).script;
  const coin = rig.fund(script, 200_000n);
  const out = createOutputs({ inputs: [{ txid: coin.txid, vout: 0, prevoutScript: script, privateKey: key }], recipients, network: 'regtest' });
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script, amount: 200_000n } });
  for (const o of out.outputs) tx.addOutput({ script: o.script, amount: 30_000n });
  tx.addOutput({ script, amount: 200_000n - 30_000n * BigInt(out.outputs.length) - 2_000n });
  tx.signIdx(key, 0);
  tx.finalize();
  const txHex = hex.encode(tx.extract());
  const err = rig.electrs.applyTransaction(txHex);
  if (err) throw new Error(`the fake mempool refused the outside payment: ${err}`);
  return { txid: tx.id, txHex };
}
