/**
 * The slice of Trezor Connect we use, written down as plain types. `@trezor/connect-mobile` has a large, strictly
 * typed surface (protobuf schemas); we describe only the calls and fields Trikey makes, so the conversion code and its
 * tests do not depend on it. The provider hands the real `TrezorConnect` over as a `TrezorConnectLike`.
 */

export type TrezorCoin = 'btc' | 'test' | 'regtest';

export interface TrezorMultisigPubkey {
  /** The cosigner's account xpub (standard xpub/tpub). Trezor Connect turns the string into an HD node. */
  node: string;
  /** Suffix below the account key: [chain, index]. */
  address_n: number[];
}

export interface TrezorMultisig {
  pubkeys: TrezorMultisigPubkey[];
  /** One empty string per cosigner: nobody else has signed. */
  signatures: string[];
  m: number;
  /** 1 = LEXICOGRAPHIC: the script is `sortedmulti` (BIP67). */
  pubkeys_order: 1;
}

export interface TrezorInput {
  prev_hash: string;
  prev_index: number;
  amount: string;
  sequence: number;
  script_type: 'SPENDWITNESS';
  /** Full path of this Trezor's key for the input. */
  address_n: number[];
  multisig: TrezorMultisig;
}

export type TrezorOutput =
  | { address: string; amount: string; script_type: 'PAYTOADDRESS' }
  | { address_n: number[]; amount: string; script_type: 'PAYTOWITNESS'; multisig: TrezorMultisig };

export interface TrezorRefTx {
  hash: string;
  version: number;
  lock_time: number;
  inputs: Array<{ prev_hash: string; prev_index: number; script_sig: string; sequence: number }>;
  bin_outputs: Array<{ amount: string; script_pubkey: string }>;
}

export interface TrezorSignTransactionParams {
  coin: TrezorCoin;
  inputs: TrezorInput[];
  outputs: TrezorOutput[];
  refTxs: TrezorRefTx[];
  version: number;
  locktime: number;
  /** We only want the signatures; the partially signed transaction would be useless. */
  serialize: false;
  push: false;
}

export type TrezorResponse<T> = { success: true; payload: T } | { success: false; payload: { error: string; code?: string } };

export interface TrezorConnectLike {
  getPublicKey(params: { path: string | number[]; coin: TrezorCoin; showOnTrezor?: boolean }): Promise<
    TrezorResponse<{ xpub: string; xpubSegwit?: string; rootFingerprint?: number; fingerprint: number; path: number[]; depth: number }>
  >;
  getAddress(params: {
    path: string | number[];
    coin: TrezorCoin;
    scriptType: 'SPENDWITNESS';
    multisig: TrezorMultisig;
    showOnTrezor: boolean;
  }): Promise<TrezorResponse<{ address: string; path: number[] }>>;
  signTransaction(params: TrezorSignTransactionParams): Promise<TrezorResponse<{ signatures: string[] }>>;
  signMessage(params: { path: string | number[]; coin: TrezorCoin; message: string }): Promise<TrezorResponse<{ address: string; signature: string }>>;
  /** Abandons the call in flight (the user went back, or the screen closed). */
  cancel?(reason?: string): void;
  dispose?(): Promise<unknown> | unknown;
}
