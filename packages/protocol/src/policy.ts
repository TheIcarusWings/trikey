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

/**
 * From this daily limit up, there is no daily limit for every purpose, not only at exactly `LIMIT_OFF_SATS`: 1,000 BTC
 * (100,000,000,000 sats). A limit that large brakes nothing a phone could hold, so it gets every safeguard of "off"
 * (security review 2026-11): the version-2 text says `limit=off` on the device instead of a long number, pairing refuses
 * it, the guardian alerts the phone and the contacts when the limit becomes it, and a recovery's new wallet starts with
 * the limit back on. Before, one satoshi under `LIMIT_OFF_SATS` was an ordinary number and skipped all of that. The
 * phone still sets exactly `LIMIT_OFF_SATS` to turn the limit off.
 */
export const LIMIT_OFF_THRESHOLD_SATS = 100_000_000_000;

/** True when `dailyLimitSats` means "no daily limit": `LIMIT_OFF_THRESHOLD_SATS` (1,000 BTC) or more. */
export function isLimitOff(dailyLimitSats: number): boolean {
  return dailyLimitSats >= LIMIT_OFF_THRESHOLD_SATS;
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
 * `family_hosting`: it hosts wallets for guests (`hosted.prepare`, `hosted.pair`, `hosted.coins`, `hosted.map.get`;
 * docs/design/family-hosting.md). Reported by `hosted.prepare` (an unpaired guest cannot call `guardian.status`) and in
 * `guardian.status`.
 * `notifications`: it can also send alerts by email, ntfy, webhook and Telegram (set up in its web UI, never by the phone), lists
 * them masked in `guardian.status.notifications`, and raises `notifications_changed` when they change.
 */
/**
 * What a guardian lists in `guardian.status.features`. `short_wraps` (0.1.10): its answers' gift wraps are back-dated
 * at most `RPC_WRAP_BACKDATE_SEC` and expire about an hour later (PROTOCOL.md, "Wrap timestamps"); its alerts are still
 * back-dated up to two days. `live_wallet`: it keeps the paired wallet's chain data live (Electrum subscriptions, or
 * Bitcoin Core's wallet polled) and sends `wallet_tx` alerts when a transaction touching the wallet or Savings appears
 * and when it confirms (PROTOCOL.md, "Live wallet").
 */
export const GUARDIAN_FEATURES = {
  limitOff: 'limit_off',
  contactLock: 'contact_lock',
  savings: 'savings',
  notifications: 'notifications',
  shortWraps: 'short_wraps',
  familyHosting: 'family_hosting',
  liveWallet: 'live_wallet',
  /** Several wallets of the box's owner, each with its own hardware wallet (docs/design/multi-wallet.md): `walletId`, `wallet.add.*`. */
  ownWallets: 'own_wallets',
  /**
   * Own wallets, phase 2 (docs/design/multi-wallet.md): Savings for every own wallet (`walletId` on `savings.*`),
   * `wallet.add`'s `hardwareKind` (listed in `guardian.status.wallets`) and `replacesWalletId` / `replacesDescriptor`
   * ("Replace guardian" moves every wallet), and an own wallet's `wallet.retire` refused while it holds coins.
   */
  ownWallets2: 'own_wallets_2',
  /**
   * Encrypted notes (PROTOCOL.md, "Encrypted notes"): it keeps an encrypted copy of each own wallet's labels
   * (`labels.put`, `labels.get`, `labels.list`, `labels.delete`), which a phone with recovery access may read. Never
   * listed to a guest: guests' notes are not kept (yet).
   */
  labelsBackup: 'labels_backup',
  /**
   * Unlocking with the hardware wallet (PROTOCOL.md, "Unlocking with the hardware wallet"): `unlock.hardware.add` /
   * `unlock.hardware.remove`, `guardian.unlock` with `kind: "hardware"`, and `guardian.status.hardwareUnlock`. Never
   * listed to a guest: a guest's hardware wallet never unlocks the host's guardian.
   */
  hardwareUnlock: 'hardware_unlock',
  /**
   * The guardian picks hardware unlock slot ids (PROTOCOL.md, "Unlocking with the hardware wallet"): while unlocked,
   * `guardian.status.hardwareUnlockOffer` names a fresh slot id for the wallet, held in memory only, for 30 minutes,
   * and `unlock.hardware.add` takes only that id (once). An old signature can then never make a slot again, so turning
   * the option off and on revokes it (security review 2026-11, sweep 2). Such a guardian refuses a slot id it did not
   * offer (`-32602`, `data.reason` `unlock_slot_not_offered`): a phone without this picks its own and is told to update.
   * A phone picks its own id only for a guardian that does not list it. Never listed to a guest.
   */
  hardwareUnlockOffer: 'unlock_slot_offer',
  /**
   * Sealed unlock (PROTOCOL.md, "Sealed unlock"): while locked, `guardian.status.unlockKey` names a key the guardian made
   * when it locked and holds in memory only; `guardian.unlock` takes `kind: "sealed"`, the passphrase or the hardware
   * signature sealed to that key, so an archived gift wrap plus the guardian's disk no longer reveal it. A phone sends
   * the secret sealed to such a guardian, and in the clear only to one without it. Never listed to a guest.
   */
  sealedUnlock: 'sealed_unlock',
  /**
   * Changing the passphrase (DESIGN.md, "Changing the passphrase"): the owner can change it in the guardian's web page
   * (never over nostr: there is no method for it), and the guardian then sends the paired phone a `passphrase_changed`
   * alert. The phone only says where to change it. Never listed to a guest.
   */
  passphraseChange: 'passphrase_change',
  /**
   * The rules a wallet starts with are approved on its hardware wallet (DESIGN.md, rule 4; PROTOCOL.md, "Pairing"):
   * `pair`, `wallet.add` and `hosted.pair` carry `rulesApproval`, a signature over `pairingRulesMessage` (the policy text
   * with `seq=0`), and such a guardian refuses them without it. Listed in `pair.prepare`, `guardian.status` and
   * `hosted.prepare`; a phone sends `rulesApproval` only to a guardian that lists it.
   */
  pairingRulesApproval: 'pairing_rules_approval',
} as const;

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
