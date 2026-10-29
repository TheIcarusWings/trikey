/**
 * @trikey/silent-payments: BIP 352 (version 1.1.x) in pure TypeScript on @noble/curves, @noble/hashes and
 * @scure/base, for Node and Hermes. Checked against every case of the BIP's `send_and_receive_test_vectors.json`.
 *
 * - Addresses: `encodeSilentPaymentAddress`, `decodeSilentPaymentAddress` (`sp` / `tsp`, versions, labels).
 * - Keys: `deriveSilentPaymentKeys` at m/352'/coin'/account'/1'/0 (scan) and /0'/0 (spend).
 * - Sender: `summarizeSenderInputs` (eligible inputs, a, input_hash) and `createOutputs`.
 * - Receiver: `computeTweak` (input_hash·A, for an index or scanning server), `scanOutputs` / `scanTransaction`,
 *   `spendingPrivateKey`.
 */
export * from './errors.js';
export {
  K_MAX,
  NUMS_H,
  bytesToHex,
  hexToBytes,
} from './curve.js';
export * from './address.js';
export * from './labels.js';
export * from './keys.js';
export * from './inputs.js';
export * from './sender.js';
export * from './receiver.js';
export * from './transaction.js';
