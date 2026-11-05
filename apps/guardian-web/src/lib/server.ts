/**
 * Settings > Server: the form's checks and words (the guardian checks everything again, apps/guardian/src/chain/source.ts).
 * Three kinds, as in Sparrow Wallet: your own Electrum server, your own Bitcoin Core, or a public server.
 */
import type { ChainSettings, ChainSourceInput, ChainSourceView, MempoolCause, PublicServerOption } from '../api/types';

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

/**
 * The home status's note and Settings > Server's warning while the Electrum server reports no unconfirmed payments
 * (`mempoolUnseen`): `text` names the cause when the guardian knows it, `detail` says what still works and what fixes it.
 * `mempoolServerSlow`: its pings took seconds too (Electrs 0.11 rereads Core 32's whole mempool on the loop that answers
 * requests).
 */
export function mempoolText(m: { mempoolCause?: MempoolCause; mempoolViaNode?: boolean; mempoolServerSlow?: boolean }): { text: string; detail: string } {
  const own = 'Payments your phone makes still show at once (the guardian remembers the ones it sent).';
  const meanwhile = m.mempoolViaNode ? 'Meanwhile the guardian reads unconfirmed payments from Bitcoin Core itself, so they still show at once.' : 'Until then, payments to you show once confirmed.';
  if (m.mempoolCause === 'electrs_core32') {
    if (m.mempoolServerSlow)
      return {
        text: "Electrs is slowed down and can't see unconfirmed payments: it doesn't work with Bitcoin Core 32's mempool.",
        detail: `Every request to Electrs waits several seconds, so syncs are slow. ${CORE32_FIXES} ${meanwhile} ${own}`,
      };
    if (m.mempoolViaNode)
      return {
        text: "Electrs can't read Bitcoin Core 32's mempool, so the guardian reads unconfirmed payments from Bitcoin Core itself.",
        detail: `They still show at once. ${CORE32_FIXES} ${own}`,
      };
    return {
      text: "Electrs can't read Bitcoin Core 32's mempool; unconfirmed payments show once confirmed, or switch Settings > Server to Bitcoin Core alone.",
      detail: `Bitcoin Core 32 no longer gives a field Electrs 0.11 needs. ${CORE32_FIXES} ${own}`,
    };
  }
  if (m.mempoolViaNode)
    return {
      text: "Your Electrum server doesn't report unconfirmed payments, so the guardian reads them from Bitcoin Core itself.",
      detail: `They still show at once. ${own} Restarting Electrs may help, or choose another server here.`,
    };
  return {
    text: "Your Electrum server doesn't report unconfirmed payments; they will show once confirmed.",
    detail: `${own} Payments to you appear only after a block. Electrs may be catching up, or have its mempool turned off; restarting it usually helps, or choose another server here.`,
  };
}

export const FINGERPRINT_COMMAND = 'openssl s_client -connect HOST:PORT </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256';

export function draftFrom(settings: ChainSettings): ServerDraft {
  const s = settings.source;
  const base: ServerDraft = { kind: 'electrum', host: '', port: '', tls: false, certSha256: '', user: '', pass: '', wallet: '', preset: '' };
  if (!s) return base;
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
