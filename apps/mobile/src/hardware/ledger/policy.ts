/**
 * Our descriptor as a Ledger Bitcoin app "wallet policy" (https://github.com/LedgerHQ/app-bitcoin-new/blob/master/doc/wallet.md):
 *
 *   descriptor  wsh(sortedmulti(2,[aaaaaaaa/48h/1h/0h/2h]xpubA/<0;1>/*,[bbbbbbbb/48h/1h/0h/2h]xpubB/<0;1>/*,[cccccccc]xpubC/<0;1>/*))#checksum
 *   template    wsh(sortedmulti(2,@0/**,@1/**,@2/**))
 *   keys        ["[aaaaaaaa/48'/1'/0'/2']xpubA", "[bbbbbbbb/48'/1'/0'/2']xpubB", "[cccccccc]xpubC"]
 *
 * Key order is kept exactly as in the descriptor: the device derives the wallet id (and checks the HMAC) from the
 * template and the keys in order, so registering with one order and signing with another would fail.
 */
import type { HardwareWalletPolicy } from '@trikey/wallet';
import { parseWalletPolicy } from '../common/wallet';
import { formatPath } from '../common/path';
import { HardwareError } from '../errors';

export const LEDGER_DESCRIPTOR_TEMPLATE = 'wsh(sortedmulti(2,@0/**,@1/**,@2/**))';

export interface LedgerWalletPolicy {
  name: string;
  descriptorTemplate: string;
  /** Key information: `[fingerprint/path']xpub`, in descriptor order. */
  keys: string[];
}

export interface LedgerRegisteredWallet extends LedgerWalletPolicy {
  hmac: Uint8Array;
}

export function toLedgerPolicy(wallet: HardwareWalletPolicy): LedgerWalletPolicy {
  const parsed = parseWalletPolicy(wallet, 'ledger');
  // The Bitcoin app also refuses a name that starts or ends with a space (`is_policy_name_acceptable`, status 6a80).
  if (/^ | $/.test(wallet.name)) throw new HardwareError('invalid-request', 'A Ledger wallet name cannot start or end with a space.', { kind: 'ledger' });
  const keys = parsed.keys.map((k) => {
    // The Bitcoin app's key parser takes hardened steps with an apostrophe only (not `h`) and the fingerprint in
    // lowercase hex (core's descriptor parser lowercases it). A key with no origin path (the guardian's
    // depth-0 key) is `[fingerprint]xpub`.
    const origin = k.origin.length ? `${k.fingerprint}${formatPath(k.origin).slice(1)}` : k.fingerprint;
    return `[${origin}]${k.xpub}`;
  });
  return { name: wallet.name, descriptorTemplate: LEDGER_DESCRIPTOR_TEMPLATE, keys };
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

export function hmacFromHex(hmac: string): Uint8Array {
  const clean = hmac.trim().replace(/^0x/i, '');
  if (clean.length !== 64 || !HEX.test(clean)) throw new HardwareError('invalid-request', 'The wallet registration (HMAC) is not 32 bytes of hex.', { kind: 'ledger' });
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hmacToHex(hmac: Uint8Array): string {
  return Array.from(hmac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The registered wallet (policy plus HMAC) that `displayAddress` and `signPsbt` need. */
export function toRegisteredLedgerWallet(wallet: HardwareWalletPolicy): LedgerRegisteredWallet {
  if (!wallet.registration?.hmac) throw new HardwareError('wallet-not-registered', 'This wallet has not been registered on the Ledger yet.', { kind: 'ledger' });
  return { ...toLedgerPolicy(wallet), hmac: hmacFromHex(wallet.registration.hmac) };
}
