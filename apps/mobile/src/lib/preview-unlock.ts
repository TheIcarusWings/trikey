/**
 * The preview unlock (docs/design/public-release.md, section 3): preview features (features.ts) turn on for one phone
 * when the owner signs this phone's challenge with the publisher key, the key that signs releases.
 *
 * 1. The phone makes a challenge (16 hex digits from the secure random source), shows it, and keeps it for 15 minutes.
 * 2. On a computer: `node tools/release/unlock-preview.mjs <challenge>` asks the signer app (Amber) over NIP-46 to sign
 *    an event of kind 1421 with exactly this content and a `challenge` tag, and shows it as a QR code.
 * 3. The phone scans it (or the JSON is pasted) and checks: the signature, the pinned key, the kind, the content, the
 *    one tag, a creation time no earlier than the challenge, and the challenge still fresh. Each challenge works once.
 *
 * It can't be a code typed into the app: the source is public, so a code (or the check for it) would be in it, and a
 * scammer could tell someone "type this to unlock support mode". Only the publisher key's owner can make this event,
 * and it unlocks only the phone that made the challenge. Kind 1421 is used for nothing else (kind 1420 is the release
 * signature), and the event is never published.
 */
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { PUBLISHER_PUBKEY } from './publisher-key';

export const PREVIEW_KIND = 1421;
export const PREVIEW_CONTENT = 'Unlock Trikey preview on this phone for 24 hours';
export const PREVIEW_HOURS = 24;
export const CHALLENGE_MINUTES = 15;

export const CHALLENGE_KEY = 'trikey.preview.challenge';
export const UNTIL_KEY = 'trikey.preview.until';

export interface Challenge {
  code: string;
  /** Unix seconds. */
  issuedAt: number;
}

export type UnlockCheck = { ok: true; until: number } | { ok: false; reason: string };

/** 8 random bytes as 16 hex digits. */
export function challengeCode(bytes: Uint8Array): string {
  if (bytes.length !== 8) throw new Error('a challenge is 8 random bytes');
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "a1b2 c3d4 e5f6 0718", for reading off the screen; the tool takes it with or without the spaces. */
export function showCode(code: string): string {
  return code.match(/.{1,4}/g)!.join(' ');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a scanned or pasted unlock against this phone's challenge, at `now` (Unix seconds). `verify` and `pubkey` are
 * for the tests; the app uses nostr-tools' check and the pinned key.
 */
export function checkUnlock(
  raw: string,
  challenge: Challenge | null,
  now: number,
  opts: { pubkey?: string; verify?: (e: Event) => boolean } = {}
): UnlockCheck {
  const pubkey = opts.pubkey ?? PUBLISHER_PUBKEY;
  const verify = opts.verify ?? verifyEvent;
  if (!challenge) return { ok: false, reason: 'Start again: this phone has no open challenge.' };
  if (now - challenge.issuedAt > CHALLENGE_MINUTES * 60) return { ok: false, reason: 'The challenge ran out. Start again for a new one.' };
  let event: unknown;
  try {
    event = JSON.parse(raw.trim());
  } catch {
    return { ok: false, reason: "That isn't a signed unlock. Scan the code the unlock tool shows." };
  }
  if (!isObject(event)) return { ok: false, reason: "That isn't a signed unlock." };
  if (event.kind !== PREVIEW_KIND || event.content !== PREVIEW_CONTENT) return { ok: false, reason: "That isn't a signed unlock." };
  const tags = event.tags;
  if (!Array.isArray(tags) || tags.length !== 1 || !Array.isArray(tags[0]) || tags[0].length !== 2 || tags[0][0] !== 'challenge' || tags[0][1] !== challenge.code)
    return { ok: false, reason: "It was signed for another challenge. Scan the one made for this phone's code." };
  if (event.pubkey !== pubkey) return { ok: false, reason: "It isn't signed by Trikey's publisher key, so it can't unlock preview." };
  const created = event.created_at;
  if (typeof created !== 'number' || created < challenge.issuedAt - 60 || created > now + 300)
    return { ok: false, reason: "Its time doesn't match the challenge. Check the computer's and the phone's clocks, then start again." };
  let valid = false;
  try {
    valid = verify(cleanCopy(event) as Event);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "Its signature doesn't check." };
  return { ok: true, until: now + PREVIEW_HOURS * 3600 };
}

// nostr-tools caches a verified flag on the object: check a clean copy of the fields only.
function cleanCopy(e: Record<string, unknown>) {
  const { id, pubkey, created_at, kind, tags, content, sig } = e;
  return { id, pubkey, created_at, kind, tags, content, sig };
}
