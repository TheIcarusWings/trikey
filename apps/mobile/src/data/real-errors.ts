/**
 * The real wallet's failures in words for the user: wallet errors, the guardian's refusals, the hardware adapters'
 * errors and the platform's (secure storage, cloud, passkeys) become one `WalletServiceError`.
 */
import { RandomSourceError } from '@trikey/core/random';
import { WalletError, type GuardianRefusal } from '@trikey/wallet';
import { HardwareError, describeHardwareError } from '../hardware/errors';
import { PlatformError } from '../platform/errors';
import { NODE_RPC_TEXT, RNG_REFUSED_TEXT, WalletServiceError, type ServiceErrorKind } from './errors';
import { formatSats, networkLabel } from './format';

const wait = (seconds?: number) => (seconds && seconds > 0 ? ` Try again in ${Math.ceil(seconds)} seconds.` : '');

/** What a guardian refusal means for the person, and whether the hardware wallet can stand in. */
export function refusalToError(r: GuardianRefusal): WalletServiceError {
  const opts = (suggestsHardware: boolean, retryAfterSeconds?: number) => ({ suggestsHardware, retryAfterSeconds });
  switch (r.kind) {
    case 'over_daily_limit': {
      const left = r.limitSats !== undefined && r.usedSats !== undefined ? Math.max(0, r.limitSats - r.usedSats) : undefined;
      return new WalletServiceError(
        'over_limit',
        `That is more than today's limit allows${left !== undefined ? ` (${formatSats(left)} sats left)` : ''}. Your hardware wallet can approve it instead.`,
        opts(true),
      );
    }
    case 'guardian_locked':
      return new WalletServiceError('guardian_locked', 'The guardian is locked. Unlock it on Home, or approve this with your hardware wallet.', opts(true));
    case 'unreachable':
    case 'unavailable':
      return new WalletServiceError(
        'guardian_unreachable',
        "Trikey can't reach your guardian right now. Check that it is on and online. Your hardware wallet can approve payments without it.",
        opts(true),
      );
    case 'recovery_in_progress':
      return new WalletServiceError(
        'recovery_in_progress',
        'A recovery is running, so phone-only payments are paused. Your hardware wallet can still approve a payment.',
        opts(true),
      );
    case 'phone_spending_paused':
      return new WalletServiceError(
        'phone_spending_paused',
        r.cause === 'wallet_retired'
          ? 'This wallet was retired by a recovery, so this phone can no longer pay from it.'
          : 'Phone-only payments are paused because a recovery was cancelled by someone else. Resume them from Home with your hardware wallet, or approve this payment with it.',
        opts(r.cause !== 'wallet_retired'),
      );
    case 'approval_required':
      return new WalletServiceError('refused', 'The guardian wants your hardware wallet to approve this.', opts(false));
    case 'approval_invalid':
    case 'approval_expired':
    case 'stale_sequence':
    case 'sequence_too_far':
    case 'approval_expiry_too_far':
      return new WalletServiceError('refused', "The guardian didn't accept the hardware wallet's approval. Try again.");
    case 'nothing_to_resume':
      return new WalletServiceError('wrong_state', 'Phone payments are already on.');
    case 'wallet_retired':
      return new WalletServiceError(
        'wrong_state',
        'Your guardian no longer guards this wallet: it was retired after a recovery or a guardian replacement. Your hardware wallet can still approve payments from it.',
        opts(true),
      );
    case 'hardware_confirm_required':
      return new WalletServiceError(
        'refused',
        'Your guardian took over your recovered wallet. Confirm it once with your hardware wallet before changing any rules.',
      );
    case 'recovery_not_found':
    case 'recovery_not_active':
      return new WalletServiceError('wrong_state', 'That recovery is no longer running.');
    case 'policy_violation':
      return new WalletServiceError('refused', `The guardian's rules say no${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}.`);
    case 'psbt_rejected':
      return new WalletServiceError('refused', `The guardian didn't accept this payment${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}.`);
    case 'unauthorized':
      return new WalletServiceError('refused', "The guardian doesn't know this phone. If you recovered this wallet, renew its access with your hardware wallet.");
    case 'already_paired':
      return new WalletServiceError('refused', 'That guardian is already paired with a phone.');
    case 'pairing_rejected':
      return new WalletServiceError('pairing_expired', 'The guardian turned the pairing code down. Open a fresh one on the guardian and scan it again.');
    case 'invalid_params':
      // A guardian on mainnet will not pair (or drop the last contact) without someone else to hear about a recovery.
      if (/alert contact/i.test(r.message))
        return new WalletServiceError(
          'refused',
          'On mainnet your guardian needs at least one alert contact, so a recovery is never announced only to this phone. Add one (your own nostr app on another device works) and try again.',
        );
      return new WalletServiceError('invalid_input', "The guardian didn't understand that request.");
    case 'unlock_failed':
      return new WalletServiceError('unlock_failed', `That passphrase didn't work.${wait(r.retryAfterSeconds)}`, opts(false, r.retryAfterSeconds));
    case 'rate_limited':
      return new WalletServiceError('rate_limited', `Too many tries.${wait(r.retryAfterSeconds) || ' Wait a moment and try again.'}`, opts(false, r.retryAfterSeconds));
    case 'broadcast_rejected':
      return new WalletServiceError('broadcast_failed', `The network refused the payment${r.reason ? `: ${r.reason}` : ''}. Nothing was sent.`);
    case 'tx_not_found':
      return new WalletServiceError('refused', r.message);
    case 'foreign_transaction':
      return new WalletServiceError('refused', r.reason ? `The guardian won't send this (${r.reason.replace(/_/g, ' ')}). Nothing was sent.` : r.message);
    // 1700: the guardian cannot read blocks from the user's node, which scanning for silent payments needs.
    case 'node_rpc_required':
      return new WalletServiceError('node_rpc_required', NODE_RPC_TEXT);
    // 1701: the guardian has no silent payment address registered for this phone (it was reset, or another phone paired).
    case 'silent_payments_not_registered':
      return new WalletServiceError('silent_payments_unavailable', "Your guardian forgot this phone's silent payment address. Trikey registers it again on the next check: try once more.");
    case 'other':
      return new WalletServiceError('refused', r.message || 'The guardian said no.');
  }
}

function platformCause(e: unknown): PlatformError<string> | undefined {
  for (let c: unknown = e, i = 0; c && i < 4; i++, c = (c as { cause?: unknown }).cause) {
    if (c instanceof PlatformError) return c;
  }
  return undefined;
}

/** Any error from the wallet, the adapters or the platform, as a `WalletServiceError`. Never throws. */
export function mapError(e: unknown): WalletServiceError {
  if (e instanceof WalletServiceError) return e;
  if (e instanceof RandomSourceError) return new WalletServiceError('refused', RNG_REFUSED_TEXT, { cause: e });

  const platform = platformCause(e);
  if (platform) {
    if (platform.code === 'cancelled') return new WalletServiceError('cancelled', platform.userMessage, { cause: e });
    const kind: ServiceErrorKind = platform.area === 'cloud-backup' || platform.area === 'passkey' ? 'backup_unavailable' : 'refused';
    return new WalletServiceError(kind, platform.userMessage, { cause: e });
  }

  if (e instanceof HardwareError) {
    if (e.code === 'cancelled') return new WalletServiceError('cancelled', 'Cancelled.', { cause: e });
    return new WalletServiceError('hardware', describeHardwareError(e), { cause: e });
  }

  if (e instanceof WalletError) {
    if (e.refusal) return refusalToError(e.refusal);
    const cause = e.cause instanceof HardwareError ? e.cause : undefined;
    if (cause?.code === 'cancelled') return new WalletServiceError('cancelled', 'Cancelled.', { cause: e });
    const make = (kind: ServiceErrorKind, message: string) => new WalletServiceError(kind, message, { cause: e });
    switch (e.code) {
      case 'wrong_state':
        return make('wrong_state', e.message);
      case 'wallet_exists':
        return make('wallet_exists', 'This phone already has a Trikey wallet.');
      case 'recovery_access_expired':
        return make('recovery_access_expired', "This phone's access to the guardian has run out. The recovery continues at your guardian. To see its progress here, approve again with your hardware wallet.");
      case 'network_mismatch':
        return e.backupNetwork
          ? new WalletServiceError('network_mismatch', `That backup is for ${networkLabel(e.backupNetwork)}, not the network this phone is set to.`, { network: e.backupNetwork, cause: e })
          : make('wrong_state', e.message);
      case 'hardware_unavailable':
        return make('hardware', "This phone can't connect to a hardware wallet.");
      case 'hardware_mismatch':
        return make('hardware_mismatch', e.message);
      case 'hardware_invalid_response':
        return make('hardware', cause ? describeHardwareError(cause) : `The hardware wallet's answer didn't check out. ${e.message}`);
      case 'address_mismatch':
        return make('address_mismatch', e.message);
      case 'address_unverified':
        return make('address_mismatch', "Your hardware wallet hasn't confirmed this wallet's addresses yet, so Trikey won't show one.");
      case 'pairing_uri_invalid':
        return make('pairing_invalid', e.message);
      case 'guardian_mismatch':
        return make('refused', `The guardian's answer doesn't match this wallet, so nothing was changed. ${e.message}`);
      case 'guardian_unsupported':
        return make('not_available', e.message);
      case 'guardian_refused':
        return make('refused', e.message);
      case 'key_unavailable':
        return make('refused', "The phone key couldn't be unlocked. Try again, and confirm with Face ID or your fingerprint.");
      case 'invalid_address':
        return make('invalid_input', "That doesn't look like an address on this network.");
      case 'amount_too_small':
        return make('invalid_input', e.message);
      case 'insufficient_funds':
        return make('insufficient_funds', "There isn't enough bitcoin for that and the network fee.");
      case 'nothing_to_send':
        return make('insufficient_funds', 'There is nothing to send.');
      case 'send_max_too_small':
        return make('invalid_input', e.message);
      case 'recovery_update_refused':
        return make('refused', e.message);
      case 'silent_payment_needs_helper':
        return make('silent_payment_needs_helper', e.message);
      case 'silent_payments_unavailable':
        return make('silent_payments_unavailable', e.message);
      case 'silent_payments_off':
        return make('silent_payments_off', 'Silent payments are turned off. Turn them on in Settings to get an address.');
      case 'node_rpc_required':
        return make('node_rpc_required', NODE_RPC_TEXT);
      case 'invalid_label':
        return make('invalid_input', "That label can't be used. Labels start at 1.");
      case 'quote_stale':
        return make('quote_stale', 'Your coins changed since the payment was prepared. Go back and review it again.');
      case 'no_fee_estimate':
        return make('wrong_state', 'The node has no fee estimate right now. Try again in a moment.');
      case 'no_chain_data':
        return make('wrong_state', 'Your wallet has not synced yet. Pull down to refresh.');
      case 'utxos_truncated':
      case 'nothing_to_sweep':
      case 'fee_cap_too_low':
        return make('refused', e.message);
      case 'invalid_rules':
        return make('invalid_input', e.message);
      case 'no_recovery':
        return make('wrong_state', 'No recovery is running.');
      case 'backup_unavailable':
        return make('backup_unavailable', e.message);
      case 'backup_not_found':
        return make('backup_not_found', 'No Trikey backup was found there.');
      case 'backup_invalid':
        // A backup from a newer app (a version this one does not know): say so, rather than "damaged".
        if (e.reason === 'too_new') return make('backup_invalid', 'That backup was made by a newer version of Trikey. Update the app, then restore it.');
        return make('backup_invalid', "That isn't a usable Trikey backup (it may be damaged).");
      case 'savings_exists':
        return make('wrong_state', 'This wallet already has Savings.');
      case 'no_savings':
        return make('wrong_state', e.message);
      case 'backup_wrong_secret':
        return make('backup_wrong_secret', "That didn't unlock the backup. Check the recovery code, or use the passkey you made it with.");
      case 'recovery_code_typo':
        return make('backup_wrong_secret', 'That recovery code has a typo in it. Check every group of characters.');
      case 'passkey_unavailable':
        return make('backup_unavailable', "Passkeys aren't available on this phone yet. Use the recovery code.");
      case 'hardware_unconfirmed':
        return make('hardware_unconfirmed', 'Confirm your recovered wallet on your hardware wallet first (the card on Home), then it can approve payments.');
      case 'old_guardian_unreachable':
        return new WalletServiceError('guardian_unreachable', "Your old guardian isn't answering. If it is gone for good, confirm that, and the move goes ahead without it.", { cause: e });
      case 'no_chain_source':
        return make('refused', `${e.message} Coins sent to the old wallet stay safe: your phone and hardware wallet can move them once something can read it.`);
      case 'replace_in_progress':
        return make('wrong_state', e.message);
      case 'wallet_recovered_elsewhere':
        return make('wrong_state', 'This wallet was recovered on another phone, so this phone can no longer use it. Its history stays here to read.');
      case 'sweep_fee_exceeds_cap':
        return make('refused', e.message || "Moving your money would cost more in fees than your guardian's recovery fee cap allows. Try again when fees are lower, or raise the cap with your hardware wallet.");
      case 'sweep_refused':
        return make('refused', e.message || "The guardian wouldn't send this move.");
      case 'rate_limited':
        return make('rate_limited', e.message || 'Too many tries. Wait a moment and try again.');
      case 'random_source_failed':
        return make('refused', RNG_REFUSED_TEXT);
      case 'internal':
        return make('internal', e.message);
    }
  }

  if (e instanceof Error && e.name === 'ZodError') return new WalletServiceError('invalid_input', 'That value is not allowed.', { cause: e });
  const message = e instanceof Error ? e.message : String(e);
  return new WalletServiceError('internal', message ? `Something went wrong: ${message}` : 'Something went wrong. Please try again.', { cause: e });
}
