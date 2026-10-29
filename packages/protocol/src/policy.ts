import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Policy } from './schemas.js';

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

/** sha256 of the canonical JSON of a policy, as lowercase hex. */
export function policyHash(policy: Policy): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(policy))));
}

/**
 * The text the hardware wallet signs (BIP 137 "sign message") to approve a policy change:
 *
 *     trikey-policy-v1:<policyHash>:<sequence>:<expiresAt>
 *
 * Binding the sequence number and expiry stops an old approval being replayed to roll the
 * policy back, or being used after the user has walked away.
 */
export function policyApprovalMessage(policy: Policy, sequence: number, expiresAt: number): string {
  return `trikey-policy-v1:${policyHash(policy)}:${sequence}:${expiresAt}`;
}
