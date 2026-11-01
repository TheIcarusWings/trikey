import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { MAX_SATS, Policy as PolicySchema, type Policy } from './schemas.js';

/**
 * "No daily limit": the protocol's largest `Sats` (all bitcoin there will ever be) as `dailyLimitSats`. It is not a new
 * `Policy` member, so `policyHash` and the protocol version stay as they are. A guardian that reports the `limit_off`
 * feature (`guardian.status.features`) has the hardware wallet sign the version-2 policy text for it, which says
 * `limit=off` in words (`approvalMessage`); the phone offers "off" only to such a guardian.
 */
export const LIMIT_OFF_SATS = MAX_SATS;

/** True when `dailyLimitSats` means "no daily limit" (`LIMIT_OFF_SATS`). */
export function isLimitOff(dailyLimitSats: number): boolean {
  return dailyLimitSats >= LIMIT_OFF_SATS;
}

/**
 * What a guardian may list in `guardian.status.features` (unknown names are ignored). `limit_off`: it builds the
 * version-2 policy text for a policy with no daily limit, refuses "off" at pairing and during a recovery, alerts the
 * paired phone and the alert contacts when the limit is turned off, and turns it back on at its last value after a
 * recovery. `contact_lock`: it knows the policy's `contactLock` member (the alert contacts may lock it with a `LOCK`
 * DM), builds the version-3 policy text whenever that is or was on, and reports who locked it (`guardian.status.lock`).
 * `savings`: it watches the phone's optional Savings wallet (`savings.register`, `savings.unregister`, `savings.get`,
 * `wallet.sync` with `wallet: "savings"`, its spends through `tx.broadcast`) and alerts when a Savings coin moves
 * (`savings_moved`). It holds no Savings key: the phone creates Savings only with such a guardian, for its chain data.
 */
export const GUARDIAN_FEATURES = { limitOff: 'limit_off', contactLock: 'contact_lock', savings: 'savings' } as const;

/** True when the alert contacts may lock the guardian (`Policy.contactLock`). */
export function isContactLockOn(policy: Pick<Policy, 'contactLock'>): boolean {
  return policy.contactLock === true;
}
export type GuardianFeature = (typeof GUARDIAN_FEATURES)[keyof typeof GUARDIAN_FEATURES];

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
 * deduplicated and sorted; `contactLock` kept only when it is on (`false` is dropped, so a policy without
 * it is byte for byte what it was before the member existed). Validates against `Policy`, so unknown members,
 * a delay other than 7/14/30 days, a non-positive fee cap or more than 20 contacts throw rather than being hashed.
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
    ...(p.contactLock === true ? { contactLock: true } : {}),
  };
}

/**
 * sha256 of the canonical JSON of the normalized policy, lowercase hex. Identical to the guardian
 * engine's `policyHash(rules)`: the canonical JSON is `{alertContacts, dailyLimitSats,
 * recoveryDelayDays, sweepFeeCapSats}` with sorted keys and sorted, lowercase contacts, plus
 * `"contactLock":true` (between `alertContacts` and `dailyLimitSats`) only when it is on.
 */
export function policyHash(policy: Policy): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(normalizePolicy(policy)))));
}
