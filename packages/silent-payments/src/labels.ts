/**
 * Labels (BIP 352): B_m = B_spend + hash_BIP0352/Label(ser_256(b_scan) || ser_32(m))·G.
 *
 * m = 0 is reserved for the wallet's own change and must never be handed out, so that nobody else can make a
 * payment that looks like change. Every receiving wallet scans for it anyway.
 */
import { bytesToHex, mulG, pointFromCompressed, privateKeyScalar, scalarChecked, ser256, ser32, serP, taggedHash, type Point } from './curve.js';
import { SilentPaymentError } from './errors.js';

export const CHANGE_LABEL = 0;

function checkLabel(m: number): void {
  if (!Number.isInteger(m) || m < 0 || m > 0xffffffff) throw new SilentPaymentError('invalid_label', `a label is an integer from 0 to 2^32-1, not ${m}`);
}

/** The label tweak hash(b_scan || m) as a scalar. */
export function labelTweak(scanPrivateKey: Uint8Array, m: number): bigint {
  checkLabel(m);
  const b = privateKeyScalar(scanPrivateKey);
  return scalarChecked(taggedHash('BIP0352/Label', ser256(b), ser32(m)), `label ${m}`);
}

/** The label tweak point hash(b_scan || m)·G. */
export const labelPoint = (scanPrivateKey: Uint8Array, m: number): Point => mulG(labelTweak(scanPrivateKey, m));

/** B_m for label m (compressed). */
export function labeledSpendKey(spendPublicKey: Uint8Array, scanPrivateKey: Uint8Array, m: number): Uint8Array {
  const B = pointFromCompressed(spendPublicKey);
  if (!B) throw new SilentPaymentError('invalid_argument', 'the spend public key is not a compressed point');
  return serP(B.add(labelPoint(scanPrivateKey, m)));
}

/** Precomputed labels for scanning: label point (compressed hex) to m and its tweak. */
export type LabelTable = Map<string, { m: number; tweak: bigint }>;

/**
 * The table a scan checks outputs against. The change label is always included (BIP 352: "always check for the
 * change label") unless `includeChange` is false (the test vectors scan with exactly the labels they list).
 */
export function labelTable(scanPrivateKey: Uint8Array, labels: Iterable<number>, opts: { includeChange?: boolean } = {}): LabelTable {
  const table: LabelTable = new Map();
  const all = new Set<number>(labels);
  if (opts.includeChange !== false) all.add(CHANGE_LABEL);
  for (const m of all) {
    const tweak = labelTweak(scanPrivateKey, m);
    table.set(bytesToHex(serP(mulG(tweak))), { m, tweak });
  }
  return table;
}
