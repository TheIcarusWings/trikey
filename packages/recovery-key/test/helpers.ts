/**
 * Test fixtures. Every key is a throwaway: published BIP 39 test vectors and
 * fixed test entropy. Regtest only.
 */
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, NETWORKS, type KeyExpression } from '@trikey/core';
import { SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { deriveKey2, keyFromDevice, recoveryKeyFromEntropy } from '../src/keys.js';
import type { RecoveryKit } from '../src/kit.js';

export const network = NETWORKS.regtest;

/** Published BIP 39 test vectors (never for real funds). */
export const MNEMONICS = {
  phone: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
  phone2: 'vessel ladder alter error federal sibling chat ability sun glass valve picture',
  hardware: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  hardware2: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  rkDevice: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
};

/** Fixed Recovery Key entropy for unit tests. */
export const RK_ENTROPY = () => new Uint8Array(16).fill(0x42);

export function device(mnemonic = MNEMONICS.hardware, kind: 'ledger' | 'trezor' | 'coldcard' = 'trezor') {
  return new SoftwareHardwareSigner({ mnemonic, network: 'regtest', kind });
}

export async function deviceKey(dev: SoftwareHardwareSigner, account = 0): Promise<KeyExpression> {
  return keyFromDevice(dev.info.fingerprint, await dev.getXpub(`m/48'/1'/${account}'/2'`), network, account);
}

export async function fixtureKeys() {
  const phone = deriveKey2(MNEMONICS.phone, network);
  const hw = device();
  const hardware = await deviceKey(hw);
  const rk = recoveryKeyFromEntropy(RK_ENTROPY(), network);
  const vault = new MultisigWallet(network, { app: phone.vault, hardware, cosigner: rk });
  return { phone, hardware, rk, vault, hw };
}

export async function fixtureKit(creationHeight = 812): Promise<RecoveryKit> {
  const { phone, hardware } = await fixtureKeys();
  return { network: 'regtest', creationHeight, recoveryKey: { kind: 'seed', entropy: RK_ENTROPY(), account: 0 }, phone: phone.vault, hardware };
}

/** A p2wpkh address of a fixed throwaway key: somebody else's wallet. */
export const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), network.btc).address!;

export async function rejects(p: Promise<unknown> | (() => unknown)): Promise<Error & { code?: string; detail?: Record<string, unknown> }> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error('expected a rejection');
}
