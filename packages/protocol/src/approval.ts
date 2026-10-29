import { normalizePolicy, policyHash } from './policy.js';
import type { Policy } from './schemas.js';

/**
 * The one-line texts the hardware wallet signs (BIP 137 `signmessage`). They mirror the guardian
 * engine's `approvalMessage` / `pairingMessage` character for character (a test compares the two), so
 * the phone can show the user, and ask the device to sign, exactly the text the guardian will rebuild
 * and verify. The guardian never parses text sent by the phone.
 *
 * ASCII, one line, at most 240 characters, so every device (Coldcard has the tightest limits) can show
 * and sign it. The key values of a policy change are in clear text for the user to check on the device;
 * the hash commits to the complete policy, including the contact list.
 */
export const MAX_APPROVAL_MESSAGE_LENGTH = 240;

export type HardwareAction =
  | { action: 'policy'; policy: Policy }
  | { action: 'cancel-recovery'; recoveryId: string }
  | { action: 'resume-phone' };

export interface ApprovalContext {
  /** From the `pair` result. */
  walletId: string;
  /** Strictly greater than the guardian's last accepted sequence (`nextHardwareSequence` or higher). */
  sequence: number;
  /** Unix SECONDS, at most 24 h ahead of the guardian's clock. */
  expiresAt: number;
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function line(parts: string[]): string {
  const msg = parts.join(' ');
  if (msg.length > MAX_APPROVAL_MESSAGE_LENGTH || !/^[\x20-\x7e]+$/.test(msg)) throw new Error('approval message is not signable');
  return msg;
}

/** The exact text the hardware wallet signs for `action`. Throws if the inputs cannot form a signable message. */
export function approvalMessage(action: HardwareAction, ctx: ApprovalContext): string {
  if (!Number.isSafeInteger(ctx.sequence) || ctx.sequence < 1) throw new Error('sequence must be a positive integer');
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  if (!/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
  const head = [`wallet=${ctx.walletId}`, `seq=${ctx.sequence}`];
  const tail = `expires=${isoSeconds(ctx.expiresAt)}`;
  switch (action.action) {
    case 'policy': {
      const p = normalizePolicy(action.policy);
      return line([
        'Trikey policy v1',
        ...head,
        `limit=${p.dailyLimitSats}`,
        `delay=${p.recoveryDelayDays}d`,
        `feecap=${p.sweepFeeCapSats}`,
        `contacts=${p.alertContacts.length}`,
        `hash=${policyHash(p)}`,
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

/**
 * Signed once at pairing, to prove the device holds the authorization key.
 * `cosignerAccountPubkey` is the guardian's raw account pubkey (hex: the public key inside its xpub).
 */
export function pairingMessage(walletId: string, cosignerAccountPubkey: string): string {
  return line(['Trikey pair v1', `wallet=${walletId}`, `guardian=${cosignerAccountPubkey}`]);
}

/**
 * Signed by the hardware wallet when a NEW phone, without the old phone or its backup, asks the guardian
 * for the wallet so it can start a recovery (`recovery.access`). Such a phone knows neither the wallet id
 * nor the descriptor yet, so the text names the two nostr keys instead: the guardian's (so it cannot be
 * replayed to another guardian) and the new phone's (so nobody else can use it).
 *
 * `Trikey recovery-access v1 guardian=<hex> phone=<hex> expires=<ISO 8601 UTC>`
 */
export function recoveryAccessMessage(ctx: { guardianPubkey: string; phonePubkey: string; expiresAt: number }): string {
  if (!/^[0-9a-f]{64}$/.test(ctx.guardianPubkey) || !/^[0-9a-f]{64}$/.test(ctx.phonePubkey)) throw new Error('invalid nostr pubkey');
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  return line([
    'Trikey recovery-access v1',
    `guardian=${ctx.guardianPubkey}`,
    `phone=${ctx.phonePubkey}`,
    `expires=${isoSeconds(ctx.expiresAt)}`,
  ]);
}
