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
 */
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseBip137Signature, verifyMessageWithPubkey } from './bip137.js';
import { isContactLockOn, isLimitOff, normalizeRules, policyHash } from './rules.js';
import { HardwareAuthKey, Rules } from './types.js';

export const MAX_MESSAGE_LENGTH = 240;

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
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function line(parts: string[]): string {
  const msg = parts.join(' ');
  if (msg.length > MAX_MESSAGE_LENGTH || !/^[\x20-\x7e]+$/.test(msg)) throw new Error('approval message is not signable');
  return msg;
}

/** The exact text the hardware wallet signs for `action`. */
export function approvalMessage(action: HardwareAction, ctx: ApprovalContext): string {
  if (!Number.isSafeInteger(ctx.sequence) || ctx.sequence < 1) throw new Error('sequence must be a positive integer');
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  if (!/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
  const head = [`wallet=${ctx.walletId}`, `seq=${ctx.sequence}`];
  const tail = `expires=${isoSeconds(ctx.expiresAt)}`;
  switch (action.action) {
    case 'policy': {
      const r = normalizeRules(action.rules);
      // No daily limit: version 2 says so in words ("limit=off"), so the device screen shows it plainly. Guardians
      // before it rebuild only version 1, so they refuse such a signature (the phone does not offer "off" to them).
      const off = isLimitOff(r);
      // Contacts may lock the guardian, or may now and this takes it away: version 3 says which in words. Guardians
      // before it never have such rules, and a phone only sends them to a guardian that reports `contact_lock`.
      const lockOn = isContactLockOn(r);
      const lock = lockOn || action.contactLockBefore === true;
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
    case 'cancel-recovery':
      if (!/^[0-9a-z-]{1,40}$/.test(action.recoveryId)) throw new Error('invalid recovery id');
      return line(['Trikey cancel-recovery v1', ...head, `recovery=${action.recoveryId}`, tail]);
    case 'resume-phone':
      return line(['Trikey resume-phone v1', ...head, tail]);
    case 'retire-wallet':
      return line(['Trikey retire-wallet v1', ...head, tail]);
  }
}

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
