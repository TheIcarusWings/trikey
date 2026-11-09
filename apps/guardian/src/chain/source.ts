/**
 * The chain source the owner chose, like Sparrow Wallet's Server preferences: three kinds.
 *
 * - `electrum`: a **private Electrum server**: the box's own Electrs (Umbrel, Start9), or Electrs or Fulcrum on the
 *   owner's network. Host, port, TLS, an optional pinned certificate.
 * - `core`: **Bitcoin Core alone**, through a watch-only wallet in it (core-backend.ts).
 * - `public`: a **public Electrum server**, from a short list of well-known ones (`PUBLIC_SERVERS`) or another public
 *   one the owner names. Always TLS, verified against the public CAs (or a pinned certificate). Allowed on every network,
 *   behind a warning: such a server sees every address of the wallets the guardian watches and the box's IP address,
 *   and could hide coins or delay confirmations from it. It cannot spend or change any rule. Use your own node if you can.
 *
 * The first choice comes from the environment (CHAIN_SOURCE, ELECTRUM_*, PUBLIC_ELECTRUM_SERVER, BITCOIN_RPC_*: the
 * compose file's `.env`, or what Umbrel and Start9 pass); once the owner changes it in the web UI (Settings > Server),
 * `chain-source.json` in the data directory holds it, and the RPC password in it is sealed like the notification
 * secrets (notify/secrets.ts). Every change is announced (guardian.ts `changeChainSource`), and during a recovery the
 * guardian refuses to switch to a public server.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NetworkName } from '@trikey/core';
import { readJsonFile, writeFileAtomic } from '../files.js';
import type { Logger } from '../log.js';
import { isSealed, SecretBox, type Sealed } from '../notify/secrets.js';
import { ElectrumBackend, GENESIS, type ChainBackend } from './backend.js';
import { BitcoinRpc } from './bitcoind.js';
import { CoreBackend, DEFAULT_CORE_WALLET, type CoreBackendOptions } from './core-backend.js';
import { ElectrumClient, isLocalAddress, normalizeFingerprint, type ElectrumClientOptions } from './electrum.js';

export const CHAIN_SOURCE_FILE = 'chain-source.json';

export interface RpcSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Plain RPC to an address on the internet allowed. */
  allowPublic?: boolean;
}

export type ChainSource =
  | { kind: 'electrum'; host: string; port: number; tls: boolean; certSha256?: string; allowPublicPlaintext?: boolean }
  | { kind: 'public'; host: string; port: number; certSha256?: string }
  | { kind: 'core'; rpc: RpcSettings; wallet?: string };

export interface PublicServer {
  id: string;
  host: string;
  port: number;
  network: NetworkName;
  /** For testnet: which one (the guardian's network name covers both). */
  chain?: 'testnet3' | 'testnet4';
  operator: string;
}

/**
 * Well-known public Electrum servers, TLS, run for years by known operators (the same ones Sparrow Wallet lists). Not an
 * endorsement: each sees what any public server sees (the file comment).
 */
export const PUBLIC_SERVERS: PublicServer[] = [
  { id: 'blockstream', host: 'electrum.blockstream.info', port: 50002, network: 'bitcoin', operator: 'Blockstream' },
  { id: 'emzy', host: 'electrum.emzy.de', port: 50002, network: 'bitcoin', operator: 'Emzy' },
  { id: 'lukechilds', host: 'bitcoin.lukechilds.co', port: 50002, network: 'bitcoin', operator: 'Luke Childs' },
  { id: 'bitaroo', host: 'electrum.bitaroo.net', port: 50002, network: 'bitcoin', operator: 'Bitaroo' },
  { id: 'blockstream-testnet', host: 'electrum.blockstream.info', port: 60002, network: 'testnet', chain: 'testnet3', operator: 'Blockstream' },
  { id: 'mempool-testnet4', host: 'mempool.space', port: 40002, network: 'testnet', chain: 'testnet4', operator: 'mempool.space' },
  { id: 'mempool-signet', host: 'mempool.space', port: 60602, network: 'signet', operator: 'mempool.space' },
];

export function publicServersFor(network: NetworkName): PublicServer[] {
  return PUBLIC_SERVERS.filter((s) => s.network === network);
}

export class ChainSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainSourceError';
  }
}

const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9a-fA-F:.]+)$/;

function checkHost(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ChainSourceError(`${what}: enter a host name or an IP address.`);
  const host = raw.trim();
  if (host.includes('://') || /[\s/]/.test(host) || !HOST_RE.test(host)) throw new ChainSourceError(`${what}: a host name or an IP address only (no scheme, no port, no path).`);
  if (host.toLowerCase().endsWith('.onion')) throw new ChainSourceError(`${what}: .onion addresses do not work: the guardian does not use Tor.`);
  return host;
}

function checkPort(raw: unknown, what: string, fallback?: number): number {
  if ((raw === undefined || raw === null || raw === '') && fallback !== undefined) return fallback;
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw new ChainSourceError(`${what}: a port from 1 to 65535.`);
  return n;
}

function checkPin(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new ChainSourceError('Certificate fingerprint: paste the SHA-256 fingerprint.');
  if (/^[0-9a-f]{40}$/i.test(raw.replace(/[\s:]/g, ''))) throw new ChainSourceError('Certificate fingerprint: that is a SHA-1 fingerprint. Use the SHA-256 one (openssl x509 -fingerprint -sha256).');
  const fp = normalizeFingerprint(raw);
  if (!fp) throw new ChainSourceError('Certificate fingerprint: the SHA-256 fingerprint is 64 hex digits (colons allowed).');
  return fp;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, '');

/** True when `host` is, by its form, an address on the owner's own network (a private IP, a single label, .local, .lan, ...). */
export function looksLocal(host: string): boolean {
  const h = bare(host).toLowerCase();
  if (isIP(h)) return isLocalAddress(h);
  return !h.includes('.') || ['.local', '.lan', '.home.arpa', '.internal', '.home', '.ts.net'].some((s) => h.endsWith(s));
}

/** Every address a host name resolves to (`dns.lookup`, all of them). */
export type ResolveHost = (host: string) => Promise<string[]>;

const lookupAll: ResolveHost = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
/** A host name that takes longer than this to resolve counts as not on the owner's network. */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Whether `s` is on this box or the owner's own network, judged by its address, never by its kind (security sweep 2):
 * the kind is whatever the web page sent, so a server on the internet sent as `electrum` ("your own Electrum server")
 * got past "no public server during a recovery" and was announced without the public-server warning. A `public` source
 * never is; an `electrum` or `core` one is when its host is a local IP address, or a name every address of which is
 * local. A name that does not resolve now (or not within 5 s) is judged by its form (`looksLocal`): the guardian could
 * not reach it either.
 */
export async function onOwnNetwork(s: ChainSource, resolve: ResolveHost = lookupAll): Promise<boolean> {
  if (s.kind === 'public') return false;
  const host = bare(s.kind === 'core' ? s.rpc.host : s.host);
  if (isIP(host)) return isLocalAddress(host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      resolve(host),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), RESOLVE_TIMEOUT_MS);
      }),
    ]);
    if (!addrs.length) return looksLocal(host);
    return addrs.every((a) => isLocalAddress(bare(a)));
  } catch {
    return looksLocal(host);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the web UI sends (`PUT /api/chain`, `POST /api/chain/test`), checked. `current` fills the RPC password when the
 * owner left it out (write-only, like the notification secrets), and so does `nodeRpc`, the Bitcoin Core the guardian
 * was started with (BITCOIN_RPC_*: Umbrel and StartOS pass it), for the same host, port and user. Throws `ChainSourceError`
 * in plain words.
 */
export function parseChainSource(input: unknown, current?: ChainSource, nodeRpc?: Omit<RpcSettings, 'allowPublic'>): ChainSource {
  const r = (input ?? {}) as Record<string, unknown>;
  switch (r['kind']) {
    case 'electrum': {
      const tls = r['tls'] === true;
      const certSha256 = checkPin(r['certSha256']);
      if (certSha256 && !tls) throw new ChainSourceError('A pinned certificate needs TLS: turn TLS on.');
      const host = checkHost(r['host'], 'Electrum server');
      const allowPublicPlaintext = r['allowPublicPlaintext'] === true;
      if (!tls && !allowPublicPlaintext && isIP(bare(host)) && !isLocalAddress(bare(host)))
        throw new ChainSourceError('That address is on the internet: turn TLS on (plain TCP only goes to this box or your own network).');
      return {
        kind: 'electrum',
        host,
        port: checkPort(r['port'], 'Port', tls ? 50002 : 50001),
        tls,
        ...(certSha256 ? { certSha256 } : {}),
        ...(allowPublicPlaintext ? { allowPublicPlaintext } : {}),
      };
    }
    case 'public': {
      const preset = typeof r['preset'] === 'string' ? PUBLIC_SERVERS.find((s) => s.id === r['preset']) : undefined;
      if (r['preset'] !== undefined && !preset) throw new ChainSourceError('That is not one of the listed public servers.');
      const host = preset ? preset.host : checkHost(r['host'], 'Public server');
      const port = preset ? preset.port : checkPort(r['port'], 'Port', 50002);
      if (!preset && looksLocal(host)) throw new ChainSourceError('That address is on your own network: choose "Private Electrum server" for it.');
      const certSha256 = checkPin(r['certSha256']);
      return { kind: 'public', host, port, ...(certSha256 ? { certSha256 } : {}) };
    }
    case 'core': {
      const rpc = (r['rpc'] ?? {}) as Record<string, unknown>;
      const host = checkHost(rpc['host'], 'Bitcoin Core');
      const port = checkPort(rpc['port'], 'RPC port');
      const user = typeof rpc['user'] === 'string' ? rpc['user'].trim() : '';
      if (!user || user.length > 128 || /[:\s]/.test(user)) throw new ChainSourceError('RPC user: enter the user name (no colon or spaces), or __cookie__ with the cookie’s password.');
      let pass = typeof rpc['pass'] === 'string' && rpc['pass'] !== '' ? rpc['pass'] : undefined;
      // A kept password stays with the exact address it was saved for: host, port and user (Bitcoin Core's RPC is always
      // plain HTTP, so there is no scheme to tell apart). Another port on the same host can be anyone's listener
      // (security review 2026-11, "RPC password reused for any port").
      const sameServer = (s: { host: string; port: number; user: string }) => s.host === host && s.port === port && s.user === user;
      if (pass === undefined && current?.kind === 'core' && sameServer(current.rpc)) pass = current.rpc.pass;
      if (pass === undefined && nodeRpc && sameServer(nodeRpc)) pass = nodeRpc.pass;
      if (!pass) throw new ChainSourceError('RPC password: enter it (it is kept by the guardian and never shown again).');
      if (pass.length > 256) throw new ChainSourceError('RPC password: at most 256 characters.');
      const allowPublic = rpc['allowPublic'] === true;
      if (!allowPublic && isIP(bare(host)) && !isLocalAddress(bare(host)))
        throw new ChainSourceError("That address is on the internet, and Bitcoin Core's RPC has no encryption: use your own network or a tunnel such as Tailscale.");
      const wallet = typeof r['wallet'] === 'string' && r['wallet'].trim() ? r['wallet'].trim() : undefined;
      if (wallet !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(wallet)) throw new ChainSourceError('Wallet name: letters, digits, dots, dashes and underscores, at most 64.');
      return { kind: 'core', rpc: { host, port, user, pass, ...(allowPublic ? { allowPublic } : {}) }, ...(wallet ? { wallet } : {}) };
    }
    default:
      throw new ChainSourceError('Choose a kind of server: your own Electrum server, your own Bitcoin Core, or a public server.');
  }
}

/**
 * Whether two sources are the same server with the same settings (a save that changes nothing is not a change): key
 * order, host case, the default port and flags left out do not count. The RPC password does.
 */
export function sameChainSource(a: ChainSource, b: ChainSource): boolean {
  const canon = (s: ChainSource): string => {
    if (s.kind === 'core')
      return JSON.stringify(['core', s.rpc.host.toLowerCase(), s.rpc.port, s.rpc.user, s.rpc.pass, !!s.rpc.allowPublic, s.wallet ?? '']);
    if (s.kind === 'public') return JSON.stringify(['public', s.host.toLowerCase(), s.port, s.certSha256 ?? '']);
    return JSON.stringify(['electrum', s.host.toLowerCase(), s.port, s.tls, s.certSha256 ?? '', !!s.allowPublicPlaintext]);
  };
  return canon(a) === canon(b);
}

/**
 * "Use the server Umbrel set": how the guardian names the environment's choice, by TRIKEY_PLATFORM (`docker`: the
 * compose file's `.env`).
 */
export function environmentSourceName(platform: 'umbrel' | 'start9' | 'docker' | undefined): string {
  if (platform === 'umbrel') return 'the server Umbrel set';
  if (platform === 'start9') return 'the server StartOS set';
  return 'the server in the .env file';
}

/** For the activity log, the phone and the alerts: `own` or `public`, and the host (never a credential). */
export interface ChainSourceSummary {
  kind: 'own' | 'public';
  backend: 'electrum' | 'core';
  host: string;
  port: number;
}

/** `outside`: the source is not on the owner's network (`onOwnNetwork`), whatever its kind says: it counts as `public`. */
export function summarize(s: ChainSource, opts: { outside?: boolean } = {}): ChainSourceSummary {
  if (s.kind === 'core') return { kind: opts.outside ? 'public' : 'own', backend: 'core', host: s.rpc.host, port: s.rpc.port };
  return { kind: s.kind === 'public' || opts.outside ? 'public' : 'own', backend: 'electrum', host: s.host, port: s.port };
}

/**
 * "your own Electrum server electrs:50001", "your own Bitcoin Core 192.168.1.5:8332", "the public server mempool.space:40002";
 * with `outside` (not on the owner's network, `onOwnNetwork`), "the Electrum server ... (not on your own network)".
 */
export function describe(s: ChainSource, opts: { outside?: boolean } = {}): string {
  const at = (h: string, p: number) => `${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${p}`;
  if (s.kind === 'core') return opts.outside ? `the Bitcoin Core ${at(s.rpc.host, s.rpc.port)} (not on your own network)` : `your own Bitcoin Core ${at(s.rpc.host, s.rpc.port)}`;
  if (s.kind === 'public') return `the public server ${at(s.host, s.port)}`;
  return opts.outside ? `the Electrum server ${at(s.host, s.port)} (not on your own network)` : `your own Electrum server ${at(s.host, s.port)}`;
}

/** The view the web UI gets: everything but the RPC password (only whether one is set). */
export function publicView(s: ChainSource): Record<string, unknown> {
  if (s.kind !== 'core') return { ...s };
  const { pass: _pass, ...rpc } = s.rpc;
  return { kind: 'core', rpc: { ...rpc, passSet: true }, ...(s.wallet ? { wallet: s.wallet } : {}) };
}

export interface BackendFactoryOptions {
  network: NetworkName;
  log?: Logger;
  /** Overrides for the Electrum client (tests: short backoffs). */
  electrum?: Partial<ElectrumClientOptions>;
  /** For Bitcoin Core: wallet birthdays. */
  core?: Pick<CoreBackendOptions, 'birthday' | 'defaultBirthday' | 'pollMs'>;
  /** "Test connection": connect and check, nothing more (no wallet in Bitcoin Core). */
  probe?: boolean;
}

/** The backend for `s`. An Electrum server on a network with a known genesis block must be on it. */
export function buildBackend(s: ChainSource, o: BackendFactoryOptions): ChainBackend {
  if (s.kind === 'core') {
    const rpc = new BitcoinRpc({ host: s.rpc.host, port: s.rpc.port, user: s.rpc.user, pass: s.rpc.pass }, { allowPublic: s.rpc.allowPublic });
    return new CoreBackend({ rpc, network: o.network, walletName: s.wallet ?? DEFAULT_CORE_WALLET, log: o.log, probe: o.probe, ...o.core });
  }
  const client = new ElectrumClient({
    host: s.host,
    port: s.port,
    // A public server is always TLS.
    tls: s.kind === 'public' ? true : s.tls,
    ...(s.certSha256 ? { certSha256: s.certSha256 } : {}),
    ...(s.kind === 'electrum' && s.allowPublicPlaintext ? { allowPublicPlaintext: true } : {}),
    log: o.log,
    ...o.electrum,
  });
  const genesis = o.network === 'regtest' ? undefined : GENESIS[o.network];
  return new ElectrumBackend(client, genesis ? { genesis } : {});
}

interface StoredFile {
  version: 1;
  source: Record<string, unknown>;
  /** The RPC password, sealed (`chain.rpc.pass`). */
  rpcPass?: Sealed;
  changedAt: number;
}

/** `chain-source.json`: the owner's choice from the web UI (absent until the first change). */
export class ChainSourceStore {
  private readonly box: SecretBox;

  constructor(private readonly dataDir: string) {
    this.box = new SecretBox(dataDir);
  }

  get path(): string {
    return join(this.dataDir, CHAIN_SOURCE_FILE);
  }

  async load(): Promise<ChainSource | undefined> {
    const raw = (await readJsonFile(this.path)) as StoredFile | undefined;
    if (!raw) return undefined;
    if (raw.version !== 1 || typeof raw.source !== 'object' || !raw.source) throw new Error(`${CHAIN_SOURCE_FILE} is not valid`);
    const src = { ...raw.source } as Record<string, unknown>;
    if (src['kind'] === 'core') {
      if (!isSealed(raw.rpcPass)) throw new Error(`${CHAIN_SOURCE_FILE}: the RPC password is missing`);
      src['rpc'] = { ...(src['rpc'] as object), pass: await this.box.open('chain.rpc.pass', raw.rpcPass) };
    }
    try {
      return parseChainSource(src);
    } catch (e) {
      throw new Error(`${CHAIN_SOURCE_FILE}: ${(e as Error).message}`);
    }
  }

  /** "Use the server <platform> set" (`DELETE /api/chain`): back to the environment's choice. */
  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async save(s: ChainSource, now: number): Promise<void> {
    let file: StoredFile;
    if (s.kind === 'core') {
      const { pass, ...rpc } = s.rpc;
      file = { version: 1, source: { ...s, rpc }, rpcPass: await this.box.seal('chain.rpc.pass', pass), changedAt: now };
    } else {
      file = { version: 1, source: { ...s }, changedAt: now };
    }
    await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}
