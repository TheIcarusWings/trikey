import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Policy as PolicySchema, type Policy } from './schemas.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order, no whitespace, `undefined`
 * object members dropped. Numbers must be finite. Both the guardian and the hardware-wallet
 * flow hash this, so it must never change.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map((v) => canonicalize(v === undefined ? null : v));
      const out: { [k: string]: Json } = {};
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) out[key] = canonicalize(v);
      }
      return out;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/**
 * The policy in the form that gets hashed (and that the guardian stores): contacts lowercased,
 * deduplicated and sorted. Validates against `Policy`, so unknown members, a delay other than 7/14/30
 * days, a non-positive fee cap or more than 20 contacts throw rather than being hashed.
 */
export function normalizePolicy(policy: Policy): Policy {
  const contacts = Array.isArray(policy?.alertContacts)
    ? [...new Set(policy.alertContacts.map((c) => (typeof c === 'string' ? c.toLowerCase() : c)))].sort()
    : policy?.alertContacts;
  const p = PolicySchema.parse({ ...policy, alertContacts: contacts });
  return {
    alertContacts: p.alertContacts,
    dailyLimitSats: p.dailyLimitSats,
    recoveryDelayDays: p.recoveryDelayDays,
    sweepFeeCapSats: p.sweepFeeCapSats,
  };
}

/**
 * sha256 of the canonical JSON of the normalized policy, lowercase hex. Identical to the guardian
 * engine's `policyHash(rules)`: the canonical JSON is `{alertContacts, dailyLimitSats,
 * recoveryDelayDays, sweepFeeCapSats}` with sorted keys and sorted, lowercase contacts.
 */
export function policyHash(policy: Policy): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(normalizePolicy(policy)))));
}
