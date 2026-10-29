import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { Network } from './network.js';
import { KeyExpression, parseSortedMultiDescriptor, sortedMultiDescriptor } from './descriptor.js';
import { ccdtKey, tweakFromPath, tweakPublicKey, tweakToBytes } from './tweak.js';

export type Role = 'app' | 'hardware' | 'cosigner';
export const ROLES: readonly Role[] = ['app', 'hardware', 'cosigner'];

export type WalletKeys = Record<Role, KeyExpression>;
export type AccountPubkeys = Record<Role, Uint8Array>;
export type Tweaks = Record<Role, bigint>;

/** Options that keep the CCDT proprietary fields when (de)serializing PSBTs. */
export const TX_OPTS = { proprietary: 'ignore' } as const;

export const RECEIVE = 0;
export const CHANGE = 1;

export interface DerivedAddress {
  chain: number;
  index: number;
  address: string;
  script: Uint8Array;
  witnessScript: Uint8Array;
  pubkeys: Record<Role, Uint8Array>;
  tweaks: Tweaks;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** p2wsh(sortedmulti(2, ...)) from the three (already derived) pubkeys. */
export function multisigScripts(pubkeys: Uint8Array[], network: Network) {
  const sorted = [...pubkeys].sort(compareBytes);
  const payment = btc.p2wsh(btc.p2ms(2, sorted), network.btc);
  return { address: payment.address!, script: payment.script, witnessScript: payment.witnessScript! };
}

/** Script for an address given only raw account pubkeys and delegated tweaks (cosigner view). */
export function delegatedScripts(acct: AccountPubkeys, tweaks: Tweaks, network: Network) {
  const pubkeys = {
    app: tweakPublicKey(acct.app, tweaks.app),
    hardware: tweakPublicKey(acct.hardware, tweaks.hardware),
    cosigner: tweakPublicKey(acct.cosigner, tweaks.cosigner),
  };
  return { pubkeys, ...multisigScripts(ROLES.map((r) => pubkeys[r]), network) };
}

function originPathToNumbers(originPath: string): number[] {
  return originPath ? btc.bip32Path(`m/${originPath.replace(/h/g, "'")}`) : [];
}

/** The 2-of-3 wallet as the app sees it (full xpubs, including chaincodes). */
export class MultisigWallet {
  private readonly hd: Record<Role, HDKey>;

  constructor(
    readonly network: Network,
    readonly keys: WalletKeys,
  ) {
    this.hd = {
      app: HDKey.fromExtendedKey(keys.app.xpub, network.bip32),
      hardware: HDKey.fromExtendedKey(keys.hardware.xpub, network.bip32),
      cosigner: HDKey.fromExtendedKey(keys.cosigner.xpub, network.bip32),
    };
  }

  /** Keys must appear in app, hardware, cosigner order (as `descriptor()` emits them). */
  static fromDescriptor(desc: string, network: Network): MultisigWallet {
    const [app, hardware, cosigner] = parseSortedMultiDescriptor(desc);
    return new MultisigWallet(network, { app, hardware, cosigner });
  }

  descriptor(chain?: 0 | 1): string {
    return sortedMultiDescriptor(
      ROLES.map((r) => this.keys[r]),
      { chain },
    );
  }

  /** Stable id of the key set (independent of the cosigner-assigned wallet id). */
  fingerprint(): string {
    return hex.encode(sha256(new TextEncoder().encode(this.descriptor()))).slice(0, 16);
  }

  accountPubkeys(): AccountPubkeys {
    return { app: this.hd.app.publicKey!, hardware: this.hd.hardware.publicKey!, cosigner: this.hd.cosigner.publicKey! };
  }

  derive(chain: number, index: number): DerivedAddress {
    const pubkeys = {} as Record<Role, Uint8Array>;
    const tweaks = {} as Tweaks;
    for (const r of ROLES) {
      const t = tweakFromPath(this.hd[r].publicKey!, this.hd[r].chainCode!, [chain, index]);
      pubkeys[r] = t.publicKey;
      tweaks[r] = t.tweak;
    }
    return { chain, index, pubkeys, tweaks, ...multisigScripts(ROLES.map((r) => pubkeys[r]), this.network) };
  }

  /** PSBT metadata for an input or change output at `d`: BIP32 origins plus CCDT tweaks. */
  psbtFields(d: DerivedAddress) {
    const acct = this.accountPubkeys();
    return {
      witnessScript: d.witnessScript,
      bip32Derivation: ROLES.map(
        (r) =>
          [
            d.pubkeys[r],
            {
              fingerprint: parseInt(this.keys[r].fingerprint, 16),
              path: [...originPathToNumbers(this.keys[r].originPath), d.chain, d.index],
            },
          ] as [Uint8Array, { fingerprint: number; path: number[] }],
      ),
      proprietary: ROLES.map((r) => [ccdtKey(acct[r]), tweakToBytes(d.tweaks[r])] as [Uint8Array, Uint8Array]),
    };
  }
}

/** Key expression for an xpub-only key that has no BIP32 origin (the cosigner's virtual key). */
export function bareKeyExpression(hd: HDKey): KeyExpression {
  return {
    fingerprint: hd.fingerprint.toString(16).padStart(8, '0'),
    originPath: '',
    xpub: hd.publicExtendedKey,
  };
}

/** Builds the cosigner's depth-0 xpub from its raw account pubkey and an app-chosen chaincode. */
export function cosignerKeyExpression(accountPubkey: Uint8Array, chainCode: Uint8Array, network: Network): KeyExpression {
  const hd = new HDKey({ publicKey: accountPubkey, chainCode, versions: network.bip32 });
  return bareKeyExpression(hd);
}

/**
 * Account key expression `[fp/48h/c'/a'/2h]xpub` from a master HDKey (software signers, tests).
 * The master must carry the network's version bytes.
 */
export function keyExpressionFromMaster(master: HDKey, path: string): KeyExpression {
  const account = master.derive(path);
  return {
    fingerprint: master.fingerprint.toString(16).padStart(8, '0'),
    originPath: path.replace(/^m\//, '').replace(/'/g, 'h'),
    xpub: account.publicExtendedKey,
  };
}
