/**
 * Receiver keys (BIP 352, "Key Derivation"), hardened BIP 32 paths:
 *
 *     scan:  m/352'/coin_type'/account'/1'/0
 *     spend: m/352'/coin_type'/account'/0'/0
 *
 * The scan key can be given to a scanning service without exposing the spend key or the master key.
 */
import { HDKey } from '@scure/bip32';
import { SilentPaymentError } from './errors.js';
import { pubkeyOf, serP } from './curve.js';
import { encodeSilentPaymentAddress, type NetworkLike } from './address.js';
import { CHANGE_LABEL, labeledSpendKey } from './labels.js';

export const BIP352_PURPOSE = 352;

export function silentPaymentPaths(coinType: number, account = 0): { scan: string; spend: string } {
  if (!Number.isInteger(coinType) || coinType < 0 || !Number.isInteger(account) || account < 0)
    throw new SilentPaymentError('invalid_argument', 'coin type and account must be non-negative integers');
  const base = `m/${BIP352_PURPOSE}'/${coinType}'/${account}'`;
  return { scan: `${base}/1'/0`, spend: `${base}/0'/0` };
}

/** BIP 44 coin type: 0 on mainnet, 1 on every test network. */
export const coinTypeFor = (network: NetworkLike) => (network === 'bitcoin' || network === 'mainnet' ? 0 : 1);

export interface SilentPaymentKeys {
  scanPrivateKey: Uint8Array;
  spendPrivateKey: Uint8Array;
  /** Compressed. */
  scanPublicKey: Uint8Array;
  /** Compressed. */
  spendPublicKey: Uint8Array;
}

/** The scan and spend keys below a BIP 32 master key (depth 0). */
export function deriveSilentPaymentKeys(master: HDKey, opts: { coinType: number; account?: number }): SilentPaymentKeys {
  if (master.depth !== 0) throw new SilentPaymentError('invalid_argument', 'derive silent payment keys from the master key (depth 0)');
  const paths = silentPaymentPaths(opts.coinType, opts.account ?? 0);
  const scan = master.derive(paths.scan).privateKey;
  const spend = master.derive(paths.spend).privateKey;
  if (!scan || !spend) throw new SilentPaymentError('invalid_argument', 'the master key has no private key');
  return { scanPrivateKey: scan, spendPrivateKey: spend, scanPublicKey: serP(pubkeyOf(scan)), spendPublicKey: serP(pubkeyOf(spend)) };
}

/** From a BIP 39 seed (64 bytes). */
export function silentPaymentKeysFromSeed(seed: Uint8Array, opts: { coinType: number; account?: number }): SilentPaymentKeys {
  return deriveSilentPaymentKeys(HDKey.fromMasterSeed(seed), opts);
}

/**
 * The receiver's address, unlabeled or with label `m >= 1`. The change label (0) is refused: it must never be
 * handed out.
 */
export function receiverAddress(
  keys: { scanPrivateKey: Uint8Array; spendPublicKey: Uint8Array; scanPublicKey?: Uint8Array },
  network: NetworkLike,
  opts: { label?: number } = {},
): string {
  const scanPublicKey = keys.scanPublicKey ?? serP(pubkeyOf(keys.scanPrivateKey));
  if (opts.label === undefined) return encodeSilentPaymentAddress(scanPublicKey, keys.spendPublicKey, network);
  if (opts.label === CHANGE_LABEL) throw new SilentPaymentError('change_label', 'label 0 is the change label and must never be handed out');
  return encodeSilentPaymentAddress(scanPublicKey, labeledSpendKey(keys.spendPublicKey, keys.scanPrivateKey, opts.label), network);
}

/** The wallet's own change address (label 0), for sending change to itself. Never show or hand it out. */
export function changeAddress(keys: { scanPrivateKey: Uint8Array; spendPublicKey: Uint8Array }, network: NetworkLike): string {
  return encodeSilentPaymentAddress(serP(pubkeyOf(keys.scanPrivateKey)), labeledSpendKey(keys.spendPublicKey, keys.scanPrivateKey, CHANGE_LABEL), network);
}
