/**
 * React Native has no global `Buffer`; the Ledger signer kit, bitcoinjs-lib and the UR libraries expect one.
 * Import this module first (for its side effect) in any module that loads them.
 */
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: unknown };
if (typeof g.Buffer === 'undefined') g.Buffer = Buffer;

export {};
