/**
 * Hardware-wallet authorization of sensitive actions (rule changes, cancelling
 * a recovery, resuming phone payments after a contested recovery).
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
 * commits to the complete rules, including the contact list.
 */
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyMessageWithPubkey } from './bip137.js';
import { normalizeRules, policyHash } from './rules.js';
import { HardwareAuthKey, Rules } from './types.js';

export const MAX_MESSAGE_LENGTH = 240;

export type HardwareAction =
  | { action: 'policy'; rules: Rules }
  | { action: 'cancel-recovery'; recoveryId: string }
  | { action: 'resume-phone' };

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
      return line([
        'Trikey policy v1',
        ...head,
        `limit=${r.dailyLimitSats}`,
        `delay=${r.recoveryDelayDays}d`,
        `feecap=${r.sweepFeeCapSats}`,
        `contacts=${r.alertContacts.length}`,
        `hash=${policyHash(r)}`,
        tail,
      ]);
    }
    case 'cancel-recovery':
      if (!/^[0-9a-z-]{1,40}$/.test(action.recoveryId)) throw new Error('invalid recovery id');
      return line(['Trikey cancel-recovery v1', ...head, `recovery=${action.recoveryId}`, tail]);
    case 'resume-phone':
      return line(['Trikey resume-phone v1', ...head, tail]);
  }
}

/** Signed once at pairing, to prove the device holds the authorization key. */
export function pairingMessage(walletId: string, cosignerAccountPubkey: string): string {
  return line(['Trikey pair v1', `wallet=${walletId}`, `guardian=${cosignerAccountPubkey}`]);
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
