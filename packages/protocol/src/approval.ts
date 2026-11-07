import { isContactLockOn, isLimitOff, normalizePolicy, policyHash } from './policy.js';
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
 *
 * A policy with no daily limit (`dailyLimitSats` = `LIMIT_OFF_SATS`) has the version-2 policy text: the same members,
 * with `limit=off` in place of the number, so the device screen says it in words:
 *
 * `Trikey policy v2 wallet=<id> seq=<n> limit=off delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO>`
 *
 * When the alert contacts may lock the guardian (`contactLock`) in the new policy, or may now and the new policy takes
 * that away, it is version 3, which says which in words after the contacts (`lock=on` / `lock=off`), the limit as in
 * versions 1 and 2:
 *
 * `Trikey policy v3 wallet=<id> seq=<n> limit=<sats|off> delay=<d>d feecap=<sats> contacts=<k> lock=<on|off> hash=<policyHash> expires=<ISO>`
 *
 * The rules a wallet starts with are approved over the same text with `seq=0` (`pairingRulesMessage`, guardians with
 * `pairing_rules_approval`): sequence 0 is never valid for any later approval (those must be above the guardian's last
 * accepted sequence, which starts at 0), so that signature can only ever pair that wallet with exactly those rules.
 */
export const MAX_APPROVAL_MESSAGE_LENGTH = 240;

export type HardwareAction =
  /**
   * `contactLockBefore`: the guardian's current policy has `contactLock` on (from `policy.get`). Then the text is
   * version 3 even when the new policy turns it off (`lock=off`), so the device says so.
   */
  | { action: 'policy'; policy: Policy; contactLockBefore?: boolean }
  | { action: 'cancel-recovery'; recoveryId: string }
  | { action: 'resume-phone' }
  | { action: 'retire-wallet' };

export interface ApprovalContext {
  /** From the `pair` result. */
  walletId: string;
  /** Strictly greater than the guardian's last accepted sequence (`nextHardwareSequence` or higher). */
  sequence: number;
  /** Unix SECONDS, at most 24 h ahead of the guardian's clock. */
  expiresAt: number;
  /**
   * For a guardian that does not report the `limit_off` feature: always the version-1 policy text, the only one it
   * rebuilds (also for a limit of `LIMIT_OFF_SATS`, which such a guardian can only have been given before the feature
   * existed). The phone never offers "off" to such a guardian.
   */
  legacyPolicyText?: boolean;
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function line(parts: string[]): string {
  const msg = parts.join(' ');
  if (msg.length > MAX_APPROVAL_MESSAGE_LENGTH || !/^[\x20-\x7e]+$/.test(msg)) throw new Error('approval message is not signable');
  return msg;
}

/** The policy text (versions 1 to 3) for `policy`, with `head` (wallet and sequence) and `tail` (expiry). */
function policyLine(policy: Policy, head: string[], tail: string, opts: { contactLockBefore?: boolean; legacyPolicyText?: boolean }): string {
  const p = normalizePolicy(policy);
  // No daily limit: version 2, which says so in words on the device screen.
  const off = isLimitOff(p.dailyLimitSats) && !opts.legacyPolicyText;
  // The contacts may lock the guardian (or may now, and this takes it away): version 3, which says which in words.
  const lockOn = isContactLockOn(p);
  const lock = lockOn || opts.contactLockBefore === true;
  return line([
    lock ? 'Trikey policy v3' : off ? 'Trikey policy v2' : 'Trikey policy v1',
    ...head,
    off ? 'limit=off' : `limit=${p.dailyLimitSats}`,
    `delay=${p.recoveryDelayDays}d`,
    `feecap=${p.sweepFeeCapSats}`,
    `contacts=${p.alertContacts.length}`,
    ...(lock ? [`lock=${lockOn ? 'on' : 'off'}`] : []),
    `hash=${policyHash(p)}`,
    tail,
  ]);
}

function checkContext(ctx: { walletId: string; expiresAt: number }): void {
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt < 0) throw new Error('expiresAt must be unix seconds');
  if (!/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
}

/** The exact text the hardware wallet signs for `action`. Throws if the inputs cannot form a signable message. */
export function approvalMessage(action: HardwareAction, ctx: ApprovalContext): string {
  if (!Number.isSafeInteger(ctx.sequence) || ctx.sequence < 1) throw new Error('sequence must be a positive integer');
  checkContext(ctx);
  const head = [`wallet=${ctx.walletId}`, `seq=${ctx.sequence}`];
  const tail = `expires=${isoSeconds(ctx.expiresAt)}`;
  switch (action.action) {
    case 'policy':
      return policyLine(action.policy, head, tail, { contactLockBefore: action.contactLockBefore, legacyPolicyText: ctx.legacyPolicyText });
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
 * The sequence number of the rules a wallet starts with (`pairingRulesMessage`). Every later approval must be above the
 * guardian's last accepted sequence, which is never below 0, so a text with this sequence approves nothing after pairing.
 */
export const PAIRING_RULES_SEQUENCE = 0;

/**
 * The text the hardware wallet signs at pairing (`pair`, `wallet.add`, `hosted.pair`, guardians with
 * `pairing_rules_approval`) to approve the rules the wallet starts with: the policy text of `approvalMessage`, with
 * `seq=0`, so the device shows the limit, delay, fee cap, number of contacts (and whether they may lock the guardian)
 * in clear, and the hash of the complete rules:
 *
 * `Trikey policy v1 wallet=<walletId> seq=0 limit=<sats> delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO>`
 *
 * (version 3 with `lock=on` when the rules let the alert contacts lock the guardian; never version 2: a wallet is never
 * paired with no daily limit). `walletId` names the wallet, whose id covers key 3, so the signature is worth nothing to
 * another wallet or another guardian, and `seq=0` is worth nothing after pairing (`PAIRING_RULES_SEQUENCE`).
 */
export function pairingRulesMessage(policy: Policy, ctx: { walletId: string; expiresAt: number }): string {
  checkContext(ctx);
  return policyLine(policy, [`wallet=${ctx.walletId}`, `seq=${PAIRING_RULES_SEQUENCE}`], `expires=${isoSeconds(ctx.expiresAt)}`, {});
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
 *
 * When the phone knows the wallet id (the guardian's recovery code carries it, `RecoveryPayload.walletId`,
 * or the phone is renewing its access), it signs version 2, bound to that wallet as well, so the
 * signature is worth nothing once the guardian guards another wallet:
 *
 * `Trikey recovery-access v2 wallet=<walletId> guardian=<hex> phone=<hex> expires=<ISO 8601 UTC>`
 *
 * Guardians accept both; a version-1 signature whose grant a wallet rotation or retirement revoked is
 * refused from then on (security review 2026-10).
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

/**
 * An unlock slot's id: 8 random bytes in hex. Guardians with `unlock_slot_offer` choose it (`guardian.status.hardwareUnlockOffer`,
 * a fresh one for every slot made); older guardians took the one the phone picked when it turned hardware unlock on.
 */
export const UNLOCK_SLOT_ID = /^[0-9a-f]{16}$/;

/**
 * The text the hardware wallet signs to unlock the guardian (guardians with `hardware_unlock`, PROTOCOL.md "Unlocking
 * with the hardware wallet"):
 *
 * `Trikey unlock key v1 wallet=<walletId> guardian=<guardian nostr pubkey, hex> network=<network> slot=<slot id>`
 *
 * Signed with the wallet's authorization key, like an approval. Ledger and Trezor sign deterministically (RFC 6979), so
 * the same device makes the same signature again for the same slot: the guardian derives the slot's key from it
 * (HKDF-SHA256 over `r || s`, `trikey/guardian-unlock/v1`, `@trikey/core` `keyFromSignature`) and checks the signature
 * against the wallet's authorization key first, so nothing but the hardware wallet can add or open a slot. The slot id
 * is fresh each time the option is turned on, and on guardians with `unlock_slot_offer` the guardian picks it and takes
 * each id once, so turning it off and on again makes every earlier signature worthless for the guardian's live data (a
 * copy of its slots file made before still opens with the old signature: only "Replace guardian" ends that).
 * Never an approval: no sequence, no expiry; it opens one slot and nothing else.
 */
export function unlockKeyMessage(ctx: { walletId: string; guardianPubkey: string; network: string; slot: string }): string {
  if (!/^[0-9a-f]{16}$/.test(ctx.walletId)) throw new Error('invalid wallet id');
  if (!/^[0-9a-f]{64}$/.test(ctx.guardianPubkey)) throw new Error('invalid nostr pubkey');
  if (!/^[a-z]{1,16}$/.test(ctx.network)) throw new Error('invalid network');
  if (!UNLOCK_SLOT_ID.test(ctx.slot)) throw new Error('invalid unlock slot id');
  return line(['Trikey unlock key v1', `wallet=${ctx.walletId}`, `guardian=${ctx.guardianPubkey}`, `network=${ctx.network}`, `slot=${ctx.slot}`]);
}
