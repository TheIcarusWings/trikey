/**
 * Test fixtures for building signed transactions: a deterministic wallet, a
 * stand-in for the guardian's delegated (tweaked) cosigner key, and low-level
 * signing for hand-built, deliberately broken transactions.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS, bip48Path } from '../../src/network.js';
import { Role, ROLES, MultisigWallet, DerivedAddress, compareBytes, cosignerKeyExpression } from '../../src/wallet.js';
import { findTweak, tweakPrivateKey } from '../../src/tweak.js';
import { parsePsbt } from '../../src/psbt.js';
import { SoftwareSigner } from '../../src/signers.js';
import { MNEMONICS } from '../helpers.js';

export const network = NETWORKS.regtest;

export interface Ctx {
  wallet: MultisigWallet;
  /** Account private keys by role (throwaway test keys). */
  accountKeys: Record<Role, Uint8Array>;
  signers: { app: SoftwareSigner; hardware: SoftwareSigner };
}

/**
 * A wallet like the app's: phone and hardware keys come from BIP39 seeds, and the
 * cosigner (guardian) contributes only a raw pubkey plus an app-chosen chaincode.
 * Everything is fixed, so failures reproduce.
 */
export async function makeCtx(opts: { hardware?: string; cosignerSeed?: number } = {}): Promise<Ctx> {
  const app = new SoftwareSigner('app', MNEMONICS.app);
  const hardware = new SoftwareSigner('hardware', opts.hardware ?? MNEMONICS.hardware, 'fake hardware wallet');
  const path = bip48Path(network);
  const cosignerAccount = HDKey.fromMasterSeed(new Uint8Array(32).fill(opts.cosignerSeed ?? 7)).derive(path);
  const keys = {
    app: await app.getKey(network),
    hardware: await hardware.getKey(network),
    cosigner: cosignerKeyExpression(cosignerAccount.publicKey!, new Uint8Array(32).fill(5), network),
  };
  return {
    wallet: new MultisigWallet(network, keys),
    accountKeys: {
      app: app.master(network).derive(path).privateKey!,
      hardware: hardware.master(network).derive(path).privateKey!,
      cosigner: cosignerAccount.privateKey!,
    },
    signers: { app, hardware },
  };
}

/**
 * The guardian's signature: it holds the raw account key and applies the
 * per-input tweak carried in the PSBT's CCDT fields (chaincode delegation).
 */
export function signAsCosigner(ctx: Ctx, psbt: Uint8Array): Uint8Array {
  const tx = parsePsbt(psbt);
  const accountPub = ctx.wallet.accountPubkeys().cosigner;
  for (let i = 0; i < tx.inputsLength; i++) {
    const tweak = findTweak(tx.getInput(i).proprietary, accountPub);
    if (tweak === undefined) throw new Error(`input ${i}: no cosigner tweak`);
    tx.signIdx(tweakPrivateKey(ctx.accountKeys.cosigner, tweak), i, [btc.SigHash.ALL]);
  }
  return tx.toPSBT();
}

export async function signAs(ctx: Ctx, role: Role, psbt: Uint8Array): Promise<Uint8Array> {
  if (role === 'cosigner') return signAsCosigner(ctx, psbt);
  return ctx.signers[role].signPsbt(psbt, network);
}

/** Signs with two roles in turn (the real flow: one signs, the PSBT travels, the next signs). */
export async function signWith(ctx: Ctx, roles: [Role, Role], psbt: Uint8Array): Promise<Uint8Array> {
  return signAs(ctx, roles[1], await signAs(ctx, roles[0], psbt));
}

/** Private key of `role` for the address at (chain, index): account key plus the delegated tweak. */
export function childKey(ctx: Ctx, role: Role, d: DerivedAddress): Uint8Array {
  return tweakPrivateKey(ctx.accountKeys[role], d.tweaks[role]);
}

/** Roles in the order their pubkeys appear in `sortedmulti` for this address. */
export function sortOrder(d: DerivedAddress): Role[] {
  return [...ROLES].sort((a, b) => compareBytes(d.pubkeys[a], d.pubkeys[b]));
}

/** DER signature plus sighash byte over the segwit v0 digest, built by hand. */
export function ecdsaSignature(
  priv: Uint8Array,
  tx: btc.Transaction,
  input: number,
  witnessScript: Uint8Array,
  amount: bigint,
  opts: { digestType?: number; appendType?: number } = {},
): Uint8Array {
  const digestType = opts.digestType ?? btc.SigHash.ALL;
  const digest = tx.preimageWitnessV0(input, witnessScript, digestType, amount);
  const der = secp256k1.sign(digest, priv, { prehash: false, format: 'der' });
  return new Uint8Array([...der, opts.appendType ?? digestType]);
}

/** Puts `witness` on input `i` and returns the raw transaction hex. */
export function withWitness(tx: btc.Transaction, i: number, witness: Uint8Array[]): string {
  tx.updateInput(i, { finalScriptWitness: witness });
  return hex.encode(tx.extract());
}

/** Hand-builds the 2-of-3 witness stack `<empty> <sig> <sig> <witnessScript>`. */
export const multisigWitness = (sigs: Uint8Array[], witnessScript: Uint8Array, dummy = new Uint8Array(0)): Uint8Array[] => [
  dummy,
  ...sigs,
  witnessScript,
];
