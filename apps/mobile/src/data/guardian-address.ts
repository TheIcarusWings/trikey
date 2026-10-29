import { decode as nip19Decode } from 'nostr-tools/nip19';
import { normalizeRelayUrl } from '@trikey/protocol';
import type { GuardianAddress } from './types';

/** Why an address could not be read, in words for the user. */
export class GuardianAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianAddressError';
  }
}

const RELAY_RE = /wss?:\/\/[^\s,;"'<>]+/gi;
const NPUB_RE = /npub1[02-9ac-hj-np-z]{58}/i;

/**
 * Reads where a guardian lives from what a person pasted or scanned, for a new phone that has nothing but the
 * hardware wallet: a `trikey://pair?...` URI (its npub and relays; the secret and expiry are ignored, they matter
 * only when pairing), or an `npub1...` plus relay URLs separated by spaces, commas or lines. `extraRelays` is the
 * separate "relays" field, when the screen has one.
 */
export function parseGuardianAddress(input: string, extraRelays = ''): GuardianAddress {
  const text = `${input}\n${extraRelays}`.trim();
  if (!text) throw new GuardianAddressError("Paste the guardian's npub and its relays, or scan its code.");

  let npub: string | undefined;
  let relays: string[];

  if (/^trikey:/i.test(input.trim())) {
    // trikey://pair?v=1&npub=...&relay=...&relay=...
    const query = input.trim().split('?')[1] ?? '';
    const q = new URLSearchParams(query);
    npub = q.get('npub') ?? undefined;
    relays = [...q.getAll('relay'), ...(extraRelays.match(RELAY_RE) ?? [])];
  } else {
    npub = NPUB_RE.exec(text)?.[0];
    relays = text.match(RELAY_RE) ?? [];
  }

  if (!npub) throw new GuardianAddressError("The guardian's public key (it starts with npub1) is missing.");
  try {
    const d = nip19Decode(npub.toLowerCase());
    if (d.type !== 'npub') throw new Error('not an npub');
  } catch {
    throw new GuardianAddressError('That is not a valid npub. Check for a typo.');
  }

  const clean: string[] = [];
  for (const r of relays) {
    try {
      const n = normalizeRelayUrl(r.replace(/[.,;)]+$/, ''));
      if (!clean.includes(n)) clean.push(n);
    } catch (e) {
      throw new GuardianAddressError(`Not a usable relay: ${e instanceof Error ? e.message : r}`);
    }
  }
  if (clean.length === 0) throw new GuardianAddressError('Add at least one relay of the guardian (wss://...).');
  if (clean.length > 8) throw new GuardianAddressError('Give at most 8 relays.');
  return { npub: npub.toLowerCase(), relays: clean };
}
