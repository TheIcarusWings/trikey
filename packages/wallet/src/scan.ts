/**
 * One entry point for everything the app's cameras and paste fields read: a guardian's pairing code, its "Recover on
 * a new phone" code, a bitcoin address or BIP 21 payment URI, a PSBT, or a nostr public key (an alert contact).
 * Pure: no I/O, no state. Trikey codes go through the protocol's `decodeTrikeyUri`, which tells the two apart.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { NETWORKS, type NetworkName } from '@trikey/core';
import { decodeTrikeyUri } from '@trikey/protocol';

export type ScannedCode =
  /** `trikey://pair?...`: a guardian's one-time pairing code (onboarding, or "Replace guardian"). */
  | { kind: 'pairing'; uri: string; guardianNpub: string; relays: string[]; label?: string; expiresAt: number }
  /** `trikey://recover?...`: where a guardian lives, for a new phone without the old one or a backup. */
  | { kind: 'recovery'; uri: string; guardian: { npub: string; relays: string[] }; network: NetworkName; label?: string }
  /** A bitcoin address, bare or as a BIP 21 URI (`bitcoin:<address>?amount=<BTC>&label=...`). */
  | { kind: 'address'; address: string; network: NetworkName; amountSats?: number; label?: string; message?: string }
  /** A PSBT (base64 or hex), e.g. one a QR signer showed back. */
  | { kind: 'psbt'; psbtBase64: string }
  /** A nostr public key (`npub1...`, `nostr:npub1...`): an alert contact. */
  | { kind: 'contact'; npub: string; pubkey: string }
  /** Nothing Trikey can use, or a Trikey code that cannot be used here; `reason` says why, in words for the person. */
  | { kind: 'unknown'; text: string; reason: string };

export interface ScanOptions {
  /** The wallet's network: codes and addresses for another network come back `unknown` with a reason. */
  network?: NetworkName;
  /** Unix seconds, for the pairing code's expiry (default: now). */
  now?: number;
}

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];
const NET_LABEL: Record<NetworkName, string> = { bitcoin: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' };

/** The networks `address` is valid on (testnet and signet share their formats). */
function addressNetworks(address: string): NetworkName[] {
  const out: NetworkName[] = [];
  for (const n of Object.values(NETWORKS)) {
    try {
      btc.Address(n.btc).decode(address);
      out.push(n.name);
    } catch {
      /* not this one */
    }
  }
  return out;
}

/** "0.0015" BTC to 150000 sats, exactly (no floating point). Undefined if it is not a valid amount. */
function btcToSats(amount: string): number | undefined {
  const m = /^(\d{1,8})(?:\.(\d{0,8}))?$/.exec(amount.trim());
  if (!m) return undefined;
  const sats = Number(m[1]) * 100_000_000 + Number((m[2] ?? '').padEnd(8, '0'));
  return Number.isSafeInteger(sats) && sats <= 2_100_000_000_000_000 ? sats : undefined;
}

function asPsbt(text: string): string | undefined {
  let bytes: Uint8Array | undefined;
  try {
    if (/^cHNidP8/.test(text)) bytes = base64.decode(text.replace(/\s+/g, ''));
    else if (/^70736274ff/i.test(text)) bytes = hex.decode(text.replace(/\s+/g, '').toLowerCase());
  } catch {
    return undefined;
  }
  if (!bytes || bytes.length < 6 || !PSBT_MAGIC.every((b, i) => bytes![i] === b)) return undefined;
  return base64.encode(bytes);
}

function asAddress(text: string, opts: ScanOptions): ScannedCode | undefined {
  let address = text;
  let query = '';
  const bip21 = /^bitcoin:/i.test(text);
  if (bip21) {
    const rest = text.slice('bitcoin:'.length).replace(/^\/\//, '');
    const q = rest.indexOf('?');
    address = q < 0 ? rest : rest.slice(0, q);
    query = q < 0 ? '' : rest.slice(q + 1);
  }
  // QR codes often carry bech32 in upper case (it packs tighter); addresses are case-insensitive there.
  if (/^(bc|tb|bcrt)1/i.test(address)) address = address.toLowerCase();
  const nets = addressNetworks(address);
  if (!nets.length) return bip21 ? { kind: 'unknown', text, reason: 'This payment link has no valid bitcoin address.' } : undefined;
  const want = opts.network;
  if (want && !nets.includes(want))
    return { kind: 'unknown', text, reason: `This is a ${NET_LABEL[nets[0]!]} address, but your wallet is on ${NET_LABEL[want]}.` };
  const network = want ?? nets[0]!;
  const out: Extract<ScannedCode, { kind: 'address' }> = { kind: 'address', address, network };
  if (query) {
    const q = new URLSearchParams(query);
    for (const key of q.keys())
      if (key.startsWith('req-')) return { kind: 'unknown', text, reason: 'This payment link asks for something Trikey does not support.' };
    const amount = q.get('amount');
    if (amount !== null) {
      const sats = btcToSats(amount);
      if (sats === undefined) return { kind: 'unknown', text, reason: 'The amount in this payment link is not valid.' };
      out.amountSats = sats;
    }
    const label = q.get('label');
    const message = q.get('message');
    if (label) out.label = label.slice(0, 200);
    if (message) out.message = message.slice(0, 200);
  }
  return out;
}

function asContact(text: string): ScannedCode | undefined {
  const s = text.replace(/^nostr:/i, '');
  if (!/^npub1/i.test(s)) return undefined;
  try {
    const d = nip19Decode(s.toLowerCase());
    if (d.type !== 'npub') return undefined;
    return { kind: 'contact', npub: npubEncode(d.data), pubkey: d.data };
  } catch {
    return { kind: 'unknown', text, reason: 'This nostr key has a typo.' };
  }
}

/** Reads whatever a scanner or a paste field got. Never throws. */
export function parseScannedCode(input: string, opts: ScanOptions = {}): ScannedCode {
  const text = (input ?? '').trim();
  if (!text) return { kind: 'unknown', text, reason: 'Nothing was scanned.' };

  if (/^trikey:/i.test(text)) {
    let code: ReturnType<typeof decodeTrikeyUri>;
    try {
      code = decodeTrikeyUri(text, opts.now ?? Math.floor(Date.now() / 1000));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (/expired/.test(why)) return { kind: 'unknown', text, reason: 'This pairing code has expired. Make a fresh one on your guardian.' };
      return { kind: 'unknown', text, reason: `This Trikey code can't be read (${why}).` };
    }
    if (code.kind === 'pair') {
      const p = code.payload;
      return { kind: 'pairing', uri: text, guardianNpub: npubEncode(p.guardianPubkey), relays: p.relays, ...(p.label ? { label: p.label } : {}), expiresAt: p.expiresAt };
    }
    const r = code.payload;
    if (opts.network && r.network !== opts.network)
      return { kind: 'unknown', text, reason: `This guardian runs on ${NET_LABEL[r.network]}, but this phone is set to ${NET_LABEL[opts.network]}.` };
    return { kind: 'recovery', uri: text, guardian: { npub: npubEncode(r.guardianPubkey), relays: r.relays }, network: r.network, ...(r.label ? { label: r.label } : {}) };
  }

  const psbt = asPsbt(text);
  if (psbt) return { kind: 'psbt', psbtBase64: psbt };
  const contact = asContact(text);
  if (contact) return contact;
  const address = asAddress(text, opts);
  if (address) return address;
  return { kind: 'unknown', text, reason: "This isn't a Trikey code, a bitcoin address or a nostr key." };
}
