/**
 * Phone-side sealed unlock helpers for e2e tests. A guardian that lists `sealed_unlock` refuses
 * cleartext `guardian.unlock` / `unlock.hardware.add`; these match what a current app sends.
 */
import {
  generateMessageId,
  sealUnlock,
  type RpcClient,
  type UnlockSecret,
} from '@trikey/protocol';

export interface SealedPhoneCtx {
  phone: RpcClient;
  phonePubkey: string;
  guardianPubkey: string;
  /** Unix seconds (the rig's clock). */
  nowSec: number;
}

/** The sealing pubkey the guardian currently holds (`guardian.status.unlockKey`). */
export async function unlockKeyFromStatus(phone: RpcClient, walletId?: string): Promise<string> {
  const st = await phone.call('guardian.status', walletId ? { walletId } : {});
  const key = st.unlockKey?.pubkey;
  if (!key) throw new Error('guardian.status has no unlockKey (guardian not sealing?)');
  return key;
}

/** `guardian.unlock` sealed to the guardian's current unlock key. */
export async function sealedPhoneUnlock(ctx: SealedPhoneCtx, secret: UnlockSecret, unlockKey?: string) {
  const id = generateMessageId();
  const key = unlockKey ?? (await unlockKeyFromStatus(ctx.phone));
  const sealed = sealUnlock(secret, {
    purpose: 'guardian.unlock',
    guardianPubkey: ctx.guardianPubkey,
    unlockKey: key,
    phonePubkey: ctx.phonePubkey,
    id,
    expiresAt: ctx.nowSec + 300,
  });
  return ctx.phone.call('guardian.unlock', { kind: 'sealed', sealed }, { id });
}

/** Passphrase unlock from the phone, sealed. */
export function sealedPassphraseUnlock(ctx: SealedPhoneCtx, passphrase: string, unlockKey?: string) {
  return sealedPhoneUnlock(ctx, { kind: 'passphrase', passphrase }, unlockKey);
}

/** Hardware-slot unlock from the phone, sealed. */
export function sealedHardwareUnlock(
  ctx: SealedPhoneCtx,
  args: { walletId: string; slot: string; signature: string },
  unlockKey?: string,
) {
  return sealedPhoneUnlock(ctx, { kind: 'hardware', ...args }, unlockKey);
}

/** `unlock.hardware.add` with the signature sealed (guardian must be unlocked). */
export async function sealedHardwareAdd(
  ctx: SealedPhoneCtx,
  args: { walletId: string; slot: string; signature: string },
  unlockKey?: string,
) {
  const id = generateMessageId();
  const key = unlockKey ?? (await unlockKeyFromStatus(ctx.phone, args.walletId));
  const sealed = sealUnlock(
    { kind: 'hardware', walletId: args.walletId, slot: args.slot, signature: args.signature },
    {
      purpose: 'unlock.hardware.add',
      guardianPubkey: ctx.guardianPubkey,
      unlockKey: key,
      phonePubkey: ctx.phonePubkey,
      id,
      expiresAt: ctx.nowSec + 300,
    },
  );
  return ctx.phone.call('unlock.hardware.add', { walletId: args.walletId, slot: args.slot, sealed }, { id });
}
