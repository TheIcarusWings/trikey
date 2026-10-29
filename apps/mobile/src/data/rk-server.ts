/**
 * The chain server of Recovery Key mode: what the person may type as "my own server", and what the screens say about
 * the public one. Pure, so Node tests it.
 */
import { DEFAULT_ESPLORA_URLS, PUBLIC_SERVER_PRIVACY_NOTE } from '@trikey/recovery-key';
import { WalletServiceError } from './errors';
import type { NetworkName } from './types';

/** Block 0's hash per network the app can check a server against. Regtest chains differ by build, so none. */
export const GENESIS_HASHES: Partial<Record<NetworkName, string>> = {
  testnet: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043', // testnet4
  signet: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
};

/** A host on the person's own network: plain `http` is allowed for these only. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.onion') || h.endsWith('.home.arpa')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * "https://mempool.space/signet/api", "http://umbrel.local:3006/api", "192.168.1.5:3002" -> the base URL the Esplora
 * client wants (no trailing slash). Plain `http` only for hosts on the person's own network: the server sees every
 * address of the wallet, and a stranger on the path would see them too.
 */
export function parseServerUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new WalletServiceError('invalid_input', 'Enter the address of your server, like https://mempool.example/api.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${/^(localhost|[\d.]+|[^/]*\.(local|lan))(:\d+)?(\/|$)/i.test(text) ? 'http' : 'https'}://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WalletServiceError('invalid_input', "That doesn't look like a web address.");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WalletServiceError('invalid_input', 'The server address must start with https:// (or http:// for a server on your own network).');
  if (url.username || url.password) throw new WalletServiceError('invalid_input', "Leave passwords out of the address: they would be sent in the clear and kept on the phone.");
  if (url.search || url.hash) throw new WalletServiceError('invalid_input', 'Leave out everything after the path (no ? or #).');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname))
    throw new WalletServiceError('invalid_input', 'A server on the internet must use https://. Plain http:// is for a server on your own network (a .local name or a 192.168 address).');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function defaultServerUrl(network: NetworkName): string {
  return DEFAULT_ESPLORA_URLS[network];
}

/** The same warning the package carries, for the Settings screen. */
export const SERVER_PRIVACY_NOTE = PUBLIC_SERVER_PRIVACY_NOTE;

/** "mempool.space" for the row in Settings. */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
