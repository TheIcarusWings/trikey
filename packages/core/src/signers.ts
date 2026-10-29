import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Network, bip48Path } from './network.js';
import { KeyExpression } from './descriptor.js';
import { Role, TX_OPTS, keyExpressionFromMaster } from './wallet.js';
import * as btc from '@scure/btc-signer';

/** Anything that can add its signature to a PSBT: app key, HWI device, air-gapped file/QR. */
export interface Signer {
  readonly role: Role;
  readonly label: string;
  /** Account key with origin, as it appears in the descriptor. */
  getKey(network: Network, account?: number): Promise<KeyExpression>;
  signPsbt(psbt: Uint8Array, network: Network): Promise<Uint8Array>;
}

/** BIP39 seed held in software (the app key, or a stand-in for a hardware wallet in tests). */
export class SoftwareSigner implements Signer {
  readonly label: string;

  constructor(
    readonly role: Role,
    private readonly mnemonic: string,
    label?: string,
  ) {
    this.label = label ?? `software ${role} key`;
  }

  master(network: Network): HDKey {
    return HDKey.fromMasterSeed(mnemonicToSeedSync(this.mnemonic), network.bip32);
  }

  async getKey(network: Network, account = 0): Promise<KeyExpression> {
    return keyExpressionFromMaster(this.master(network), bip48Path(network, account));
  }

  async signPsbt(psbt: Uint8Array, network: Network): Promise<Uint8Array> {
    const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
    // Signs every input whose bip32Derivation matches this master fingerprint.
    const signed = tx.sign(this.master(network) as unknown as Parameters<btc.Transaction["sign"]>[0], [btc.SigHash.ALL]);
    if (signed === 0) throw new Error(`${this.label}: no inputs to sign`);
    return tx.toPSBT();
  }
}
