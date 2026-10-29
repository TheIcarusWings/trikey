/**
 * The wallet as text an air-gapped signer imports, shown to it as a QR code:
 *
 * - `coldcardMultisigConfig`: the Coldcard multisig setup file (Settings > Multisig Wallets > Import via QR). One
 *   `Derivation:` line per key, because the guardian's key has no BIP48 origin (it is a depth-0 key, `m`).
 * - the output descriptor itself, for devices that import descriptors (Jade, Passport, Keystone through their companion flows).
 */
import { formatPath } from '../common/path';
import type { ParsedWallet } from '../common/wallet';

export function coldcardMultisigConfig(wallet: ParsedWallet): string {
  const lines = [`Name: ${wallet.name}`, 'Policy: 2 of 3', 'Format: P2WSH', ''];
  for (const key of wallet.keys) {
    lines.push(`Derivation: ${key.origin.length ? formatPath(key.origin) : 'm'}`);
    lines.push(`${key.fingerprint.toUpperCase()}: ${key.xpub}`);
    lines.push('');
  }
  return lines.join('\n');
}
