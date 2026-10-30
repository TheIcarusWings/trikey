/**
 * Transactions built by hand with core's `buildSpend` and signed by two software keys (key 2 and the hardware wallet's
 * seed), for the cases the wallet API would not produce: dust, a feerate below the relay minimum, replacements, a
 * relative timelock. Throwaway keys, regtest.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { SoftwareSigner, buildSpend, finalizePsbt, type MultisigWallet, type Recipient, type SpendPlan, type TimelockOpts, type Utxo } from '@trikey/core';
import { network } from './kit.js';

export interface SignedSpend {
  txHex: string;
  txid: string;
  plan: SpendPlan;
  /** The fee in sats. */
  fee: bigint;
}

/**
 * Spends exactly `coins` (largest-first selection takes them all when they are few and the amount is large) to
 * `recipients`, change to `changeIndex`, signed by `appMnemonic` and `hardwareMnemonic`. The guardian's key is not needed:
 * a 2-of-3 input is satisfied by any two.
 */
export async function buildSignedSpend(
  opts: {
    wallet: MultisigWallet;
    coins: Utxo[];
    recipients: Recipient[];
    feeRate: number;
    changeIndex: number;
    appMnemonic: string;
    hardwareMnemonic: string;
  } & TimelockOpts,
): Promise<SignedSpend> {
  const plan = buildSpend({
    wallet: opts.wallet,
    utxos: opts.coins,
    recipients: opts.recipients,
    feeRate: opts.feeRate,
    changeIndex: opts.changeIndex,
    ...(opts.sequence !== undefined ? { sequence: opts.sequence } : {}),
    ...(opts.lockTime !== undefined ? { lockTime: opts.lockTime } : {}),
  });
  const byApp = await new SoftwareSigner('app', opts.appMnemonic).signPsbt(plan.psbt, network);
  const both = await new SoftwareSigner('hardware', opts.hardwareMnemonic).signPsbt(byApp, network);
  const { txHex, txid } = finalizePsbt(both);
  return { txHex, txid, plan, fee: plan.fee };
}

/** A raw transaction without its witness data: what a hardware wallet wants as `nonWitnessUtxo` (the txid is the same). */
export function stripWitness(rawHex: string): string {
  const tx = btc.RawTx.decode(hex.decode(rawHex));
  return hex.encode(btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }));
}
