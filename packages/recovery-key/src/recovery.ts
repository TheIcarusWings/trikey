/**
 * Recovery: any two of the three keys move every vault coin, immediately.
 * There is no Delay & Notify in this mode: two real keys sign, and nobody
 * has to be convinced of anything.
 *
 *   kit + hardware   phone lost or stolen
 *   kit + phone      hardware wallet and its seed words lost
 *   phone + hardware Recovery Kit lost (sweep to a vault with a new kit)
 *
 * The sweep spends every confirmed vault coin, including a coin a refill in
 * the mempool is spending: the sweep replaces that refill (it signals BIP
 * 125, and full-RBF nodes take a better-paying replacement anyway), so a
 * thief who broadcast a refill with a stolen phone loses it to the sweep if
 * it has not confirmed. The fee follows the chain server's estimate, under a
 * cap, and pays enough to replace whatever it conflicts with.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { SEQUENCE_RBF, TX_OPTS, analyzePsbt, combinePsbts, parsePsbt, type MultisigWallet, type Role } from '@trikey/core';
import { DUST_SATS, estimateVsize, feeForRate } from './fees.js';
import type { EsploraClient, ScanResult } from './esplora.js';
import { scanAccount } from './esplora.js';
import type { VaultCoin } from './refills.js';
import { RecoveryKeyError } from './errors.js';

export const DEFAULT_SWEEP_FEE_CAP_SATS = 100_000;
/** A sweep never pays more than this share of what it moves. */
export const MAX_SWEEP_FEE_SHARE = 0.05;

export interface SweepCoins {
  coins: VaultCoin[];
  totalSats: bigint;
  /** Mempool transactions the sweep will replace, with their descendants' fees counted in. */
  replaces: { txid: string; feeSats: bigint; rate: number }[];
  /** Unconfirmed coins left out (sweep again once they confirm). */
  unconfirmedSats: bigint;
  scan: ScanResult;
}

/**
 * Every confirmed vault coin that no confirmed transaction spends, with its
 * funding transaction (checked against the txid).
 */
export async function gatherVaultCoins(client: EsploraClient, vault: MultisigWallet, opts: { minIndex?: Record<number, number>; gapLimit?: number } = {}): Promise<SweepCoins> {
  const scan = await scanAccount(client, (c, i) => ({ chain: c, index: i, address: vault.derive(c, i).address, script: vault.derive(c, i).script }), opts);
  const usable = scan.coins.filter((c) => c.height > 0 && (!c.spentBy || !c.spentBy.confirmed));
  const unconfirmedSats = scan.unspent.filter((c) => c.height === 0).reduce((s, c) => s + c.value, 0n);
  const prev = new Map<string, string>();
  for (const id of new Set(usable.map((c) => c.txid))) prev.set(id, await client.txHex(id));
  const coins: VaultCoin[] = usable.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, chain: c.chain, index: c.index, prevTxHex: prev.get(c.txid)! }));
  // What the sweep conflicts with: the direct spenders in the mempool, and their mempool descendants.
  const direct = new Set(usable.filter((c) => c.spentBy && !c.spentBy.confirmed).map((c) => c.spentBy!.txid));
  const replaces: SweepCoins['replaces'] = [];
  for (const txid of direct) {
    let fee = 0n;
    let first: { fee: number; weight: number } | undefined;
    const seen = new Set<string>();
    const walk = async (id: string, depth: number) => {
      if (seen.has(id) || depth > 4) return;
      seen.add(id);
      const t = await client.tx(id);
      if (!t || t.status.confirmed) return;
      fee += BigInt(t.fee ?? 0);
      first ??= { fee: t.fee ?? 0, weight: t.weight ?? 4 };
      for (let v = 0; v < t.vout.length; v++) {
        const s = await client.outspend(id, v);
        if (s.spent && s.txid) await walk(s.txid, depth + 1);
      }
    };
    await walk(txid, 0);
    replaces.push({ txid, feeSats: fee, rate: first ? first.fee / Math.ceil(first.weight / 4) : 0 });
  }
  return { coins, totalSats: coins.reduce((s, c) => s + c.value, 0n), replaces, unconfirmedSats, scan };
}

export interface SweepPlan {
  psbt: Uint8Array;
  feeSats: bigint;
  amountSats: bigint;
  vsize: number;
  feeRate: number;
}

/** One output to `destinationScript`, every coin in. */
export function buildVaultSweep(opts: {
  vault: MultisigWallet;
  coins: SweepCoins;
  destinationScript: Uint8Array;
  feeRate: number;
  feeCapSats: bigint;
  minRelaySatPerVb?: number;
}): SweepPlan {
  const { vault, coins } = opts;
  if (!coins.coins.length) throw new RecoveryKeyError('nothing_to_sweep', 'The vault has no confirmed coins to move.');
  const minRelay = opts.minRelaySatPerVb ?? 1;
  const vsize = estimateVsize({ multisigInputs: coins.coins.length, outputScriptLengths: [opts.destinationScript.length] });
  let fee = feeForRate(opts.feeRate, vsize);
  // BIP 125: pay for what is replaced plus our own relay, at a higher rate than each replaced transaction.
  const replacedFees = coins.replaces.reduce((s, r) => s + r.feeSats, 0n);
  const replaceMin = replacedFees + feeForRate(minRelay, vsize);
  const rateMin = coins.replaces.reduce((m, r) => Math.max(m, r.rate), 0);
  const needed = [replaceMin, rateMin > 0 ? feeForRate(rateMin + 1, vsize) : 0n, feeForRate(minRelay, vsize)].reduce((a, b) => (a > b ? a : b));
  if (fee < needed) fee = needed;
  const share = BigInt(Math.floor(Number(coins.totalSats) * MAX_SWEEP_FEE_SHARE));
  const cap = opts.feeCapSats < share ? opts.feeCapSats : share;
  if (fee > cap) {
    if (needed > cap) throw new RecoveryKeyError('fee_cap_too_low', `Moving the vault needs at least ${needed} sats in fees, above the ${cap} cap.`, { detail: { neededSats: Number(needed), capSats: Number(cap) } });
    fee = cap;
  }
  const amount = coins.totalSats - fee;
  if (amount < DUST_SATS) throw new RecoveryKeyError('nothing_to_sweep', 'The vault holds too little to pay for moving it.');
  const tx = new btc.Transaction({ ...TX_OPTS, version: 2 });
  for (const c of coins.coins) {
    const d = vault.derive(c.chain, c.index);
    tx.addInput({
      txid: c.txid,
      index: c.vout,
      sequence: SEQUENCE_RBF,
      witnessUtxo: { script: d.script, amount: c.value },
      nonWitnessUtxo: hex.decode(c.prevTxHex),
      sighashType: btc.SigHash.ALL,
      ...vault.psbtFields(d),
    });
  }
  tx.addOutput({ script: opts.destinationScript, amount });
  return { psbt: tx.toPSBT(), feeSats: fee, amountSats: amount, vsize, feeRate: Number(fee) / vsize };
}

/** One key's signature on a vault PSBT. */
export interface VaultSigner {
  role: Role;
  /** What to tell the user ("your Recovery Kit", "your Ledger", "this phone"). */
  label: string;
  sign(psbt: Uint8Array): Promise<Uint8Array>;
}

/**
 * Has each signer sign in turn, checks that every input ends up with valid
 * signatures from both roles and that the transaction did not change, and
 * finalizes.
 */
export async function signVaultTx(psbt: Uint8Array, vault: MultisigWallet, signers: VaultSigner[]): Promise<{ txid: string; txHex: string }> {
  const txid = parsePsbt(psbt).id;
  let cur = psbt;
  for (const s of signers) {
    let out: Uint8Array;
    try {
      out = await s.sign(cur);
      cur = combinePsbts([cur, out]);
    } catch (e) {
      if (e instanceof RecoveryKeyError) throw e;
      throw new RecoveryKeyError('hardware_invalid_response', `${s.label} did not sign: ${(e as Error).message}`, { cause: e });
    }
    const a = analyzePsbt(cur, vault.accountPubkeys(), vault.network);
    if (a.txid !== txid) throw new RecoveryKeyError('hardware_invalid_response', `${s.label} changed the transaction.`);
    if (a.inputs.some((i) => !i.signedBy.includes(s.role))) throw new RecoveryKeyError('hardware_invalid_response', `${s.label} did not sign every input.`);
  }
  const tx = btc.Transaction.fromPSBT(cur, TX_OPTS);
  tx.finalize();
  return { txid: tx.id, txHex: hex.encode(tx.extract()) };
}
