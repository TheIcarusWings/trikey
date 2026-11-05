/**
 * Settings > Server: the form's checks and words (the guardian checks everything again, apps/guardian/src/chain/source.ts).
 * Three kinds, as in Sparrow Wallet: your own Electrum server, your own Bitcoin Core, or a public server.
 */
import type { ChainSettings, ChainSourceInput, ChainSourceView, MempoolCause, Platform, PublicServerOption } from '../api/types';

export type ServerKind = 'electrum' | 'core' | 'public';

export interface ServerDraft {
  kind: ServerKind;
  host: string;
  port: string;
  tls: boolean;
  certSha256: string;
  user: string;
  /** Empty: keep the stored one. */
  pass: string;
  wallet: string;
  /** A listed public server's id, or '' for another one. */
  preset: string;
}

export const KIND_LABELS: Record<ServerKind, { title: string; note: string }> = {
  electrum: { title: 'Your own Electrum server', note: 'Electrs or Fulcrum on this box or your network (Umbrel, Start9, RaspiBlitz, a NAS).' },
  core: { title: 'Your own Bitcoin Core', note: 'Bitcoin Core alone, no Electrum server: the guardian keeps a watch-only wallet in it.' },
  public: { title: 'A public server', note: 'Someone else’s Electrum server. Only if you have no node.' },
};

/** The warning every public-server choice carries. */
export const PUBLIC_WARNING =
  'A public server sees every address of your wallet and this box’s IP address, and could hide coins or delay confirmations from the guardian. It cannot spend or change any rule. Use your own node if you can.';

export const CORE_NOTE =
  'Bitcoin Core 24 or later. The guardian creates a watch-only wallet in it (no keys) and imports your wallet’s addresses; the first import scans the chain from the wallet’s start, which takes a while on mainnet. A pruned node works only if it still has those blocks. Its RPC has no encryption: use it on your own network or over Tailscale.';

/** The two ways out of the Electrs and Bitcoin Core 32 incompatibility, in words. */
export const CORE32_FIXES =
  "Fix it by adding deprecatedrpc=bip125 to Bitcoin Core's configuration (bitcoin.conf) and restarting Bitcoin Core and Electrs, or switch Settings > Server to Bitcoin Core alone.";

/** The same, worded for Settings > Server itself, where the choice is right below. */
export const CORE32_FIXES_HERE =
  "Fix it by adding deprecatedrpc=bip125 to Bitcoin Core's configuration (bitcoin.conf) and restarting Bitcoin Core and Electrs, or choose Your own Bitcoin Core below.";

/** The home status's Core 32 fix, before its link to Settings > Server with Your own Bitcoin Core chosen. */
export const HOME_CORE32_FIX = 'Fix it with deprecatedrpc=bip125 in bitcoin.conf, or';
export const HOME_CORE32_LINK = 'use Bitcoin Core alone';
/** Where that link goes: Settings > Server's Advanced section, Your own Bitcoin Core chosen (`useCoreLink`). */
export const CORE_LINK = '/settings?server=core';

/**
 * The home status's note and Settings > Server's warning while the Electrum server reports no unconfirmed payments
 * (`mempoolUnseen`): `text` names the cause when the guardian knows it and must read right on its own (the home page
 * shows only it), `detail` says what still works and what fixes it. `mempoolServerSlow`: its pings took seconds too
 * (Electrs 0.11 rereads Core 32's whole mempool on the loop that answers requests). `core32`: Bitcoin Core alone is a
 * fix (the home page links to it).
 */
export function mempoolText(
  m: { mempoolCause?: MempoolCause; mempoolViaNode?: boolean; mempoolServerSlow?: boolean },
  opts: { onServerPage?: boolean; platform?: 'umbrel' | 'start9' } = {},
): { text: string; detail: string; core32: boolean } {
  const fixes = opts.onServerPage ? CORE32_FIXES_HERE : CORE32_FIXES;
  const own = 'Payments your phone makes still show at once (the guardian remembers the ones it sent).';
  const meanwhile = m.mempoolViaNode ? 'Meanwhile the guardian reads unconfirmed payments from Bitcoin Core itself, so they still show at once.' : 'Until then, payments to you show once confirmed.';
  if (m.mempoolCause === 'electrs_core32' && m.mempoolViaNode && opts.platform) {
    const name = opts.platform === 'umbrel' ? 'Umbrel' : 'StartOS';
    return {
      text: "Electrs is slowed down by Bitcoin Core 32; the guardian reads unconfirmed payments from Bitcoin Core instead.",
      detail: `Nothing to do: payments still show at once, only syncs are slower (Electrs answers each request a few seconds late). The lasting fix is an Electrs update from ${name}. Meanwhile, deprecatedrpc=bip125 in Bitcoin Core's configuration also fixes it.`,
      core32: true,
    };
  }
  if (m.mempoolCause === 'electrs_core32') {
    if (m.mempoolServerSlow)
      return {
        text: m.mempoolViaNode
          ? 'Electrs is slowed down by Bitcoin Core 32; unconfirmed payments are read from Bitcoin Core instead.'
          : "Electrs is slowed down by Bitcoin Core 32 and can't see unconfirmed payments, so payments to you show only once confirmed.",
        detail: `Electrs 0.11 doesn't work with Bitcoin Core 32's mempool: every request to it waits several seconds, so syncs are slow. ${fixes} ${meanwhile} ${own}`,
        core32: true,
      };
    if (m.mempoolViaNode)
      return {
        text: "Electrs can't read Bitcoin Core 32's mempool, so the guardian reads unconfirmed payments from Bitcoin Core itself.",
        detail: `They still show at once. ${fixes} ${own}`,
        core32: true,
      };
    return {
      text: "Electrs can't read Bitcoin Core 32's mempool, so payments to you show only once confirmed.",
      detail: `Bitcoin Core 32 no longer gives a field Electrs 0.11 needs. ${fixes} ${own}`,
      core32: true,
    };
  }
  if (m.mempoolViaNode)
    return {
      text: "Your Electrum server doesn't report unconfirmed payments, so the guardian reads them from Bitcoin Core itself.",
      detail: `They still show at once. ${own} Restarting Electrs may help, or choose another server here.`,
      core32: false,
    };
  return {
    text: "Your Electrum server doesn't report unconfirmed payments, so payments to you show only once confirmed.",
    detail: `${own} Payments to you appear only after a block. Electrs may be catching up, or have its mempool turned off; restarting it usually helps, or choose another server here.`,
    core32: false,
  };
}

export const FINGERPRINT_COMMAND = 'openssl s_client -connect HOST:PORT </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256';

export function draftFrom(settings: ChainSettings): ServerDraft {
  const s = settings.source;
  const base: ServerDraft = { kind: 'electrum', host: '', port: '', tls: false, certSha256: '', user: '', pass: '', wallet: '', preset: '' };
  if (!s) {
    // Started from the platform's settings (Umbrel, Start9, .env) with nothing chosen here: show what is in use.
    const u = settings.summary;
    if (u?.kind === 'own' && u.backend === 'electrum') return { ...base, host: u.host, port: String(u.port) };
    if (u?.kind === 'own' && u.backend === 'core') return { ...base, kind: 'core', host: u.host, port: String(u.port) };
    return base;
  }
  if (s.kind === 'core') return { ...base, kind: 'core', host: s.rpc.host, port: String(s.rpc.port), user: s.rpc.user, wallet: s.wallet ?? '' };
  if (s.kind === 'public') {
    const preset = settings.publicServers.find((p) => p.host === s.host && p.port === s.port);
    return { ...base, kind: 'public', host: s.host, port: String(s.port), tls: true, certSha256: s.certSha256 ?? '', preset: preset?.id ?? '' };
  }
  return { ...base, kind: 'electrum', host: s.host, port: String(s.port), tls: s.tls, certSha256: s.certSha256 ?? '' };
}

const portOk = (p: string) => /^\d{1,5}$/.test(p.trim()) && Number(p) >= 1 && Number(p) <= 65535;
const hostOk = (h: string) => /^[A-Za-z0-9.:[\]-]+$/.test(h.trim()) && !h.includes('://');
const fingerprintOk = (f: string) => /^[0-9a-f]{64}$/i.test(f.trim().replace(/^sha-?256(\s*fingerprint)?\s*[=:]?\s*/i, '').replace(/[\s:]/g, ''));

/**
 * Your own Bitcoin Core, filled in for "use Bitcoin Core alone": the one in use, else the one the guardian was started
 * with (Umbrel's and StartOS's own node: its password stays in the guardian, the field can stay empty).
 */
export function coreDraft(settings: ChainSettings): ServerDraft {
  const d = draftFrom(settings);
  if (d.kind === 'core') return d;
  const n = settings.nodeRpc;
  return { ...d, kind: 'core', host: n?.host ?? '', port: n ? String(n.port) : '', user: n?.user ?? '', pass: '', tls: false, certSha256: '', preset: '', wallet: '' };
}

/** Whether the guardian already has Bitcoin Core's password for the draft's host and user (the field may stay empty). */
export function passKnown(d: ServerDraft, settings: ChainSettings): boolean {
  const host = d.host.trim();
  const user = d.user.trim();
  const s = settings.source;
  if (s?.kind === 'core' && s.rpc.host === host && s.rpc.user === user) return true;
  return !!settings.nodeRpc && settings.nodeRpc.host === host && settings.nodeRpc.user === user;
}

const defaultPort = (d: ServerDraft) => (d.kind === 'core' ? '' : d.tls || d.kind === 'public' ? '50002' : '50001');
const canonFp = (f: string) => f.trim().replace(/^sha-?256(\s*fingerprint)?\s*[=:]?\s*/i, '').replace(/[\s:]/g, '').toUpperCase();

/**
 * Whether the draft is the source in use, as the guardian would see it (Save then has nothing to do): the default port
 * left out, the host's case, the fingerprint's colons do not count. A typed RPC password always counts as a change
 * (it is write-only: an empty field means "unchanged").
 */
export function draftUnchanged(d: ServerDraft, settings: ChainSettings): boolean {
  const s = settings.source;
  if (!s) return false;
  const host = d.host.trim().toLowerCase();
  const port = Number(d.port.trim() || defaultPort(d));
  if (d.kind !== s.kind) return false;
  if (s.kind === 'core')
    return !d.pass && host === s.rpc.host.toLowerCase() && port === s.rpc.port && d.user.trim() === s.rpc.user && d.wallet.trim() === (s.wallet ?? '');
  if (s.kind === 'public') {
    const preset = d.preset ? settings.publicServers.find((p) => p.id === d.preset) : undefined;
    if (preset) return preset.host.toLowerCase() === s.host.toLowerCase() && preset.port === s.port && !s.certSha256;
    return host === s.host.toLowerCase() && port === s.port && canonFp(d.certSha256) === canonFp(s.certSha256 ?? '');
  }
  return host === s.host.toLowerCase() && port === s.port && d.tls === s.tls && canonFp(d.certSha256) === canonFp(s.certSha256 ?? '');
}

/** The first problem with the draft, in plain words, or undefined. `passStored`: Bitcoin Core's password is already kept. */
export function draftError(d: ServerDraft, passStored: boolean): string | undefined {
  if (d.kind === 'public' && d.preset) return undefined;
  if (!d.host.trim()) return d.kind === 'core' ? 'Enter Bitcoin Core’s address.' : 'Enter the server’s address.';
  if (!hostOk(d.host)) return 'Enter a host name or an IP address only (no http://, no port).';
  if (d.port.trim() && !portOk(d.port)) return 'The port is a number from 1 to 65535.';
  if (d.kind === 'core') {
    if (!d.port.trim()) return 'Enter the RPC port (8332 on mainnet).';
    if (!d.user.trim()) return 'Enter the RPC user name.';
    if (!d.pass && !passStored) return 'Enter the RPC password.';
    return undefined;
  }
  if (d.certSha256.trim() && !fingerprintOk(d.certSha256)) return 'The fingerprint is the SHA-256 one: 64 hex digits (colons allowed).';
  if (d.kind === 'electrum' && d.certSha256.trim() && !d.tls) return 'A pinned certificate needs TLS: turn TLS on.';
  return undefined;
}

/** The `PUT /api/chain` (and test) body. */
export function inputFrom(d: ServerDraft): ChainSourceInput {
  const port = d.port.trim() ? Number(d.port) : undefined;
  const cert = d.certSha256.trim() || undefined;
  if (d.kind === 'core')
    return { kind: 'core', rpc: { host: d.host.trim(), port: port!, user: d.user.trim(), ...(d.pass ? { pass: d.pass } : {}) }, ...(d.wallet.trim() ? { wallet: d.wallet.trim() } : {}) };
  if (d.kind === 'public') return d.preset ? { kind: 'public', preset: d.preset } : { kind: 'public', host: d.host.trim(), ...(port ? { port } : {}), ...(cert ? { certSha256: cert } : {}) };
  return { kind: 'electrum', host: d.host.trim(), ...(port ? { port } : {}), tls: d.tls, ...(cert ? { certSha256: cert } : {}) };
}

/** "Your own Electrum server electrs:50001 (TLS)". */
export function sourceLabel(s: ChainSourceView | null): string {
  if (!s) return 'None set';
  if (s.kind === 'core') return `Your own Bitcoin Core ${s.rpc.host}:${s.rpc.port}`;
  if (s.kind === 'public') return `Public server ${s.host}:${s.port}`;
  return `Your own Electrum server ${s.host}:${s.port}${s.tls ? (s.certSha256 ? ' (TLS, pinned certificate)' : ' (TLS)') : ''}`;
}

export function presetLabel(p: PublicServerOption): string {
  return `${p.host}:${p.port} (${p.operator}${p.chain ? `, ${p.chain}` : ''})`;
}

/** Why "Save" is refused before asking the guardian: a public server while a recovery runs. */
export function recoveryBlock(d: ServerDraft, settings: ChainSettings): string | undefined {
  return d.kind === 'public' && settings.recoveryRunning
    ? 'A recovery is running: the guardian switches to a public server only after it ends. You can switch to your own node now.'
    : undefined;
}

// --- Who set the server: Umbrel, StartOS or the .env file ----------------------------------------------------------

const PLATFORM_NAME: Record<Platform, string> = { umbrel: 'Umbrel', start9: 'StartOS', docker: 'the .env file' };

/**
 * How Settings > Server shows itself:
 * - `platform`: Umbrel or StartOS set the server and nothing was chosen here: one line and the state, the choice of
 *   another server folded under "Advanced: use a different server";
 * - `chosen`: a server chosen here, with "Use the server Umbrel set" when there is one to go back to;
 * - `form`: plain Docker (the owner sets the server up), or no server at all: the form, as before.
 */
export function serverPageMode(settings: ChainSettings): 'platform' | 'chosen' | 'form' {
  if (settings.origin === 'settings') return 'chosen';
  if ((settings.platform === 'umbrel' || settings.platform === 'start9') && settings.environment) return 'platform';
  return 'form';
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** What the platform set, in words: "this Umbrel's Electrs and Bitcoin Core", "the server in your .env file (...)". */
function environmentWords(settings: ChainSettings): string | undefined {
  const env = settings.environment;
  if (!env) return undefined;
  const platform = settings.platform ?? 'docker';
  if (platform === 'docker') return `the server in your .env file (${lowerFirst(sourceLabel(settings.source))})`;
  if (env.kind === 'public') return `the public server ${env.host}:${env.port}`;
  const box = platform === 'umbrel' ? "this Umbrel's" : "this StartOS server's";
  return env.backend === 'core' ? `${box} Bitcoin Core` : `${box} Electrs${settings.nodeRpc ? ' and Bitcoin Core' : ''}`;
}

/**
 * The line Settings > Server leads with while the platform's setting is in use: "Connected to this Umbrel's Electrs and
 * Bitcoin Core (set up by Umbrel)." Undefined once a server was chosen here (or none is set).
 */
export function environmentLine(settings: ChainSettings): string | undefined {
  if (settings.origin !== 'environment') return undefined;
  const words = environmentWords(settings);
  if (!words) return undefined;
  const platform = settings.platform ?? 'docker';
  const by = platform === 'docker' ? '' : ` (set up by ${PLATFORM_NAME[platform]})`;
  return settings.status.connected ? `Connected to ${words}${by}.` : `Not connected to ${words}${by}.`;
}

/** "Use the server Umbrel set": only once a server was chosen here and the platform set one to go back to. */
export function backButton(settings: ChainSettings): { label: string; note: string } | undefined {
  if (settings.origin !== 'settings' || !settings.environment) return undefined;
  const platform = settings.platform ?? 'docker';
  const env = settings.environment;
  const what = env.kind === 'public' ? `the public server ${env.host}:${env.port}` : `your own ${env.backend === 'core' ? 'Bitcoin Core' : 'Electrum server'} ${env.host}:${env.port}`;
  if (platform === 'docker')
    return { label: 'Use the server in the .env file', note: `Chosen here, so the .env file's server (${what}) is not used. Going back is announced like any change.` };
  const name = PLATFORM_NAME[platform];
  return { label: `Use the server ${name} set`, note: `Chosen here, so the guardian no longer follows ${name}'s setting (${what}). Going back is announced like any change.` };
}
