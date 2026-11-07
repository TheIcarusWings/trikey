/**
 * Hardware-wallet authorization of sensitive actions (rule changes, cancelling
 * a recovery, resuming phone payments after a contested recovery, retiring
 * the wallet, letting a new phone in to recover).
 *
 * The phone shows the change, asks the hardware wallet to `signmessage` a
 * canonical one-line text with the single-sig key recorded at pairing, and
 * forwards the signature. The guardian rebuilds the text from the request and
 * its own state (it never parses text sent by the phone), then verifies it.
 *
 * The text is ASCII, one line and at most 240 characters so that every target
 * device (Coldcard has the tightest limits) can sign and display it. The key
 * values of a rule change (limit, delay, fee cap, number of contacts) are in
 * clear text so the user can check them on the device screen; the hash
 * commits to the complete rules, including the contact list. Rules with no
 * daily limit have the version-2 policy text, `limit=off` in place of the
 * number. Rules where the alert contacts may lock the guardian, or a change
 * from such rules to rules where they may not, have the version-3 text, which
 * adds `lock=on` / `lock=off` after the contacts.
 *
 * Versions 1 to 3 show only the number of contacts, so a malicious app could swap one for its own unseen (security
 * review 2026-11). Version 4 (`contactsInText`, guardians with `approval_contacts`) names every contact on the device
 * (`contactId`), or their number and a code (`contactsCode`) the web page shows when they do not all fit; such a guardian
 * refuses an older text for anything that sets or changes the contacts (`verifyPolicyApproval`).
 */
import { bech32, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { parseBip137Signature, verifyMessageWithPubkey } from './bip137.js';
import { isContactLockOn, isLimitOff, normalizeRules, policyHash } from './rules.js';
import { HardwareAuthKey, Rules } from './types.js';

export const MAX_MESSAGE_LENGTH = 240;
/** What every device shows of a text before cutting it (Jade: 188 characters, then "..."). Same as @trikey/protocol's. */
export const DEVICE_VISIBLE_LENGTH = 188;

/**
 * A contact as the device, the web page and the app show it: `npub1`, the first 8 characters of the npub's data, `..`
 * and its last 4 (60 bits). Same as @trikey/protocol's `contactId`.
 */
export function contactId(pubkey: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) throw new Error('invalid nostr pubkey');
  const npub = bech32.encode('npub', bech32.toWords(hex.decode(pubkey.toLowerCase())));
  return `${npub.slice(0, 13)}..${npub.slice(-4)}`;
}

/** The code of a contact list (80 bits of sha256, hex in groups of 4). Same as @trikey/protocol's `contactsCode`. */
export function contactsCode(contacts: readonly string[]): string {
  const sorted = [...new Set(contacts.map((c) => c.toLowerCase()))].sort();
  const digest = hex.encode(sha256(utf8ToBytes(['trikey contacts v1', ...sorted].join('\n'))).slice(0, 10));
  return digest.match(/.{4}/g)!.join('-');
}

/** The `contacts=` member of a version-4 text: every `contactId` if the list ends within `DEVICE_VISIBLE_LENGTH`, else `<k>:<code>`. */
function contactsMember(contacts: readonly string[], before: number): string {
  if (!contacts.length) return 'contacts=none';
  const list = `contacts=${contacts.map(contactId).join(',')}`;
  if (before + 1 + list.length <= DEVICE_VISIBLE_LENGTH) return list;
  return `contacts=${contacts.length}:${contactsCode(contacts)}`;
}

export type HardwareAction =
  /** `contactLockBefore`: the current rules let the contacts lock the guardian (so turning it off says `lock=off`). */
  | { action: 'policy'; rules: Rules; contactLockBefore?: boolean }
  | { action: 'cancel-recovery'; recoveryId: string }
  | { action: 'resume-phone' }
  | { action: 'retire-wallet' };

export interface ApprovalContext {
  walletId: string;
  sequence: number;
  /** Unix seconds. */
  expiresAt: number;
  /** The version-4 policy text, which names the contacts (guardians with `approval_contacts`). */
  contactsInText?: boolean;
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function line(parts: string[]): string {
  const msg = parts.join(' ');
  if (msg.length > MAX_MESSAGE_LENGTH || !/^[\x20-\x7e]+$/.test(msg)) throw new Error('approval message is not signable');
  return msg;
}

/** The policy text (versions 1 to 4) for `rules`, with `head` (wallet and sequence) and `tail` (expiry). */
function policyLine(rules: Rules, head: string[], tail: string, contactLockBefore?: boolean, contactsInText?: boolean): string {
  const r = normalizeRules(rules);
  if (contactsInText) {
    // Version 4: every contact by name (or their number and code), the lock in words, no hash: all else is in clear.
    const before = [
      'Trikey policy v4',
      ...head,
      isLimitOff(r) ? 'limit=off' : `limit=${r.dailyLimitSats}`,
      `delay=${r.recoveryDelayDays}d`,
      `feecap=${r.sweepFeeCapSats}`,
      `lock=${isContactLockOn(r) ? 'on' : 'off'}`,
    ];
    return line([...before, contactsMember(r.alertContacts, before.join(' ').length), tail]);
  }
  // No daily limit: version 2 says so in words ("limit=off"), so the device screen shows it plainly. Guardians
  // before it rebuild only version 1, so they refuse such a signature (the phone does not offer "off" to them).
  const off = isLimitOff(r);
  // Contacts may lock the guardian, or may now and this takes it away: version 3 says which in words. Guardians
  // before it never have such rules, and a phone only sends them to a guardian that reports `contact_lock`.
  const lockOn = isContactLockOn(r);
  const lock = lockOn || contactLockBefore === true;
  return line([
    lock ? 'Trikey policy v3' : off ? 'Trikey policy v2' : 'Trikey policy v1',
    ...head,
    off ? 'limit=off' : `limit=${r.dailyLimitSats}`,
    `delay=${r.recoveryDelayDays}d`,
    `feecap=${r.sweepFeeCapSats}`,
    `contacts=${r.alertContacts.length}`,
    ...(lock ? [`lock=${lockOn ? 'on' : 'off'}`] : []),
    `hash=${policyHash(r)}`,
    tail,
  ]);
}

function checkContext(ctx: { walletId: string; expiresAt: number }): void {
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  if (!/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
}

/** The exact text the hardware wallet signs for `action`. */
export function approvalMessage(action: HardwareAction, ctx: ApprovalContext): string {
  if (!Number.isSafeInteger(ctx.sequence) || ctx.sequence < 1) throw new Error('sequence must be a positive integer');
  checkContext(ctx);
  const head = [`wallet=${ctx.walletId}`, `seq=${ctx.sequence}`];
  const tail = `expires=${isoSeconds(ctx.expiresAt)}`;
  switch (action.action) {
    case 'policy':
      return policyLine(action.rules, head, tail, action.contactLockBefore, ctx.contactsInText);
    case 'cancel-recovery':
      if (!/^[0-9a-z-]{1,40}$/.test(action.recoveryId)) throw new Error('invalid recovery id');
      return line(['Trikey cancel-recovery v1', ...head, `recovery=${action.recoveryId}`, tail]);
    case 'resume-phone':
      return line(['Trikey resume-phone v1', ...head, tail]);
    case 'retire-wallet':
      return line(['Trikey retire-wallet v1', ...head, tail]);
  }
}

/**
 * The sequence of the rules a wallet starts with. Every later approval must be above the last accepted sequence, which
 * starts at 0 and only grows, so a text with this sequence approves nothing after pairing.
 */
export const PAIRING_RULES_SEQUENCE = 0;

/**
 * Signed at pairing (`pair`, `wallet.add`, `hosted.pair`) to approve the rules the wallet starts with: the policy text with
 * `seq=0` (`PAIRING_RULES_SEQUENCE`), its limit, delay, fee cap and contacts in clear and the hash of the complete rules.
 * The wallet id covers key 3, so the signature pairs only this wallet with this guardian, and only with these rules.
 * Same text as @trikey/protocol's `pairingRulesMessage`.
 */
export function pairingRulesMessage(rules: Rules, ctx: { walletId: string; expiresAt: number; contactsInText?: boolean }): string {
  checkContext(ctx);
  return policyLine(rules, [`wallet=${ctx.walletId}`, `seq=${PAIRING_RULES_SEQUENCE}`], `expires=${isoSeconds(ctx.expiresAt)}`, undefined, ctx.contactsInText);
}

/**
 * Checks a signature over a policy text (`text(v4)` builds it): the version-4 text, which names the contacts, first;
 * then, only when `legacyAllowed` (the contacts stay as they are, or the guardian does not require version 4), versions
 * 1 to 3. `legacy_text`: a valid signature over the older text where it is not allowed (an app from before
 * `approval_contacts` setting or changing the contacts: "update the app"). Never throws.
 */
export function verifyPolicyApproval(
  text: (contactsInText: boolean) => string,
  signature: unknown,
  key: HardwareAuthKey,
  authorizer: HardwareAuthorizer,
  legacyAllowed: boolean,
): 'ok' | 'legacy_text' | 'invalid' {
  if (typeof signature !== 'string') return 'invalid';
  const verifies = (v4: boolean) => {
    let message: string;
    try {
      message = text(v4);
    } catch {
      return false;
    }
    return authorizer.verify(message, signature, key);
  };
  if (verifies(true)) return 'ok';
  if (!verifies(false)) return 'invalid';
  return legacyAllowed ? 'ok' : 'legacy_text';
}

/** Why an older policy text is refused where the contacts are set or changed. */
export const CONTACTS_NOT_SHOWN =
  'Update the Trikey app: your guardian now has your hardware wallet show the alert contacts themselves, not only how many there are, whenever they are set or changed. Nothing was changed.';

/** Signed once at pairing, to prove the device holds the authorization key. */
export function pairingMessage(walletId: string, cosignerAccountPubkey: string): string {
  return line(['Trikey pair v1', `wallet=${walletId}`, `guardian=${cosignerAccountPubkey}`]);
}

/**
 * Signed by the hardware wallet to let a NEW phone (no old phone, no backup) read the wallet and start
 * a recovery (`recovery.access`). Bound to the guardian's and the phone's nostr keys, and in version 2
 * (`walletId` given) to the wallet too: the new phone learns the id from the guardian's recovery code.
 * Version 1 (no wallet id) is still accepted, except a signature whose grant a rotation or retirement
 * revoked (`GuardianState.revokedAccess`). Same text as @trikey/protocol's `recoveryAccessMessage`.
 */
export function recoveryAccessMessage(ctx: { guardianPubkey: string; phonePubkey: string; expiresAt: number; walletId?: string }): string {
  if (!/^[0-9a-f]{64}$/.test(ctx.guardianPubkey) || !/^[0-9a-f]{64}$/.test(ctx.phonePubkey)) throw new Error('invalid nostr pubkey');
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  if (ctx.walletId !== undefined && !/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
  return line([
    ctx.walletId !== undefined ? 'Trikey recovery-access v2' : 'Trikey recovery-access v1',
    ...(ctx.walletId !== undefined ? [`wallet=${ctx.walletId}`] : []),
    `guardian=${ctx.guardianPubkey}`,
    `phone=${ctx.phonePubkey}`,
    `expires=${isoSeconds(ctx.expiresAt)}`,
  ]);
}

/** What identifies a proof whatever its encoding (BIP137: sha256 of r || s, so another header byte is the same proof). */
export function proofId(proof: string): string | undefined {
  try {
    return hex.encode(sha256(parseBip137Signature(proof).compact));
  } catch {
    return undefined;
  }
}

/** A way for the hardware wallet to prove it approved a message. Add more kinds behind this. */
export interface HardwareAuthorizer {
  readonly kind: string;
  /** Checks the key recorded at pairing is well formed. Throws with a reason otherwise. */
  validateKey(key: HardwareAuthKey): void;
  /** True iff `proof` shows the holder of `key` approved exactly `message`. Never throws. */
  verify(message: string, proof: string, key: HardwareAuthKey): boolean;
}

export const bip137Authorizer: HardwareAuthorizer = {
  kind: 'bip137',
  validateKey(key) {
    if (key.kind !== 'bip137') throw new Error('not a bip137 key');
    if (!/^0[23][0-9a-f]{64}$/.test(key.pubkey)) throw new Error('authorization pubkey must be 33-byte compressed hex');
    secp256k1.Point.fromHex(key.pubkey).assertValidity();
    if (!/^m(\/\d+['h]?)+$/.test(key.path)) throw new Error('invalid authorization key path');
  },
  verify(message, proof, key) {
    if (key.kind !== 'bip137') return false;
    try {
      return verifyMessageWithPubkey(message, hex.decode(key.pubkey), proof);
    } catch {
      return false;
    }
  },
};
