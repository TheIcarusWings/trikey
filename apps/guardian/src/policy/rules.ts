import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { RECOVERY_DELAYS, RecoveryDelayDays, Rules } from './types.js';

const MAX_SATS = 21_000_000n * 100_000_000n;
export const MAX_ALERT_CONTACTS = 20;
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

export function isNostrPubkey(s: string): boolean {
  return NOSTR_PUBKEY_RE.test(s);
}

/** Validates and normalizes rules (contacts lowercased, deduplicated and sorted). Throws with a reason. */
export function normalizeRules(r: Rules): Rules {
  if (typeof r.dailyLimitSats !== 'bigint' || r.dailyLimitSats < 0n || r.dailyLimitSats > MAX_SATS)
    throw new Error('dailyLimitSats must be a bigint between 0 and 21M BTC');
  if (!RECOVERY_DELAYS.includes(r.recoveryDelayDays as RecoveryDelayDays))
    throw new Error(`recoveryDelayDays must be one of ${RECOVERY_DELAYS.join(', ')}`);
  if (typeof r.sweepFeeCapSats !== 'bigint' || r.sweepFeeCapSats <= 0n || r.sweepFeeCapSats > MAX_SATS)
    throw new Error('sweepFeeCapSats must be a positive bigint');
  if (!Array.isArray(r.alertContacts)) throw new Error('alertContacts must be an array');
  const contacts = [...new Set(r.alertContacts.map((c) => String(c).toLowerCase()))].sort();
  for (const c of contacts) if (!isNostrPubkey(c)) throw new Error(`invalid alert contact: ${c}`);
  if (contacts.length > MAX_ALERT_CONTACTS) throw new Error(`at most ${MAX_ALERT_CONTACTS} alert contacts`);
  return {
    dailyLimitSats: r.dailyLimitSats,
    recoveryDelayDays: r.recoveryDelayDays,
    alertContacts: contacts,
    sweepFeeCapSats: r.sweepFeeCapSats,
  };
}

/**
 * Canonical JSON of normalized rules; the hardware approval commits to its sha256.
 *
 * Same encoding as `canonicalJson()` in @trikey/protocol (keys sorted, no
 * whitespace, sats as JSON numbers, which are exact below 2^53 > 21M BTC), so
 * `policyHash` here equals the protocol's `policyHash` of the same policy
 * object. Kept local so the engine does not pull in the nostr stack; a test
 * cross-checks the two.
 */
export function canonicalRules(r: Rules): string {
  const n = normalizeRules(r);
  // Keys in sorted order.
  return JSON.stringify({
    alertContacts: n.alertContacts,
    dailyLimitSats: Number(n.dailyLimitSats),
    recoveryDelayDays: n.recoveryDelayDays,
    sweepFeeCapSats: Number(n.sweepFeeCapSats),
  });
}

/** The rules as a JSON policy object (the shape @trikey/protocol's `Policy` would carry). */
export function rulesToPolicyJson(r: Rules) {
  return JSON.parse(canonicalRules(r)) as {
    alertContacts: string[];
    dailyLimitSats: number;
    recoveryDelayDays: number;
    sweepFeeCapSats: number;
  };
}

export function policyHash(r: Rules): string {
  return hex.encode(sha256(utf8ToBytes(canonicalRules(r))));
}

/**
 * The phone alone may only tighten: lower the daily limit and/or lengthen the
 * delay, with everything else unchanged. Anything else needs the hardware.
 * (Fee cap changes need the hardware either way: a lower cap could block a
 * genuine recovery, so it is not a "safe" direction.)
 */
export function phoneMayApply(from: Rules, to: Rules): { ok: true } | { ok: false; detail: string } {
  const a = normalizeRules(from);
  const b = normalizeRules(to);
  if (b.dailyLimitSats > a.dailyLimitSats) return { ok: false, detail: 'raising the daily limit' };
  if (b.recoveryDelayDays < a.recoveryDelayDays) return { ok: false, detail: 'shortening the recovery delay' };
  if (b.sweepFeeCapSats !== a.sweepFeeCapSats) return { ok: false, detail: 'changing the sweep fee cap' };
  if (a.alertContacts.join(',') !== b.alertContacts.join(',')) return { ok: false, detail: 'changing alert contacts' };
  return { ok: true };
}

export function rulesEqual(a: Rules, b: Rules): boolean {
  return canonicalRules(a) === canonicalRules(b);
}
