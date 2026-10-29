/**
 * Recovery Key mode's failures in words for the user. `RecoveryKeyError` carries a stable code; the package words most
 * of its messages for people already, so they pass through where that is true, and the codes that need the app's voice
 * get it here. Anything else (the hardware adapters, secure storage) goes through the guardian mode's mapper.
 */
import { RecoveryKeyError } from '@trikey/recovery-key';
import { WalletServiceError } from './errors';
import { mapError } from './real-errors';
import { networkLabel } from './format';

export function mapRkError(e: unknown): WalletServiceError {
  if (e instanceof WalletServiceError) return e;
  if (e instanceof RecoveryKeyError) {
    // The person cancelled Face ID, or the device gave up: say that, not "the phone key could not be unlocked".
    const inner = e.cause !== undefined ? mapError(e.cause) : undefined;
    if (inner && (inner.kind === 'cancelled' || inner.kind === 'hardware')) return inner;
    const make = (kind: WalletServiceError['kind'], message = e.message) => new WalletServiceError(kind, message, { cause: e });
    switch (e.code) {
      case 'mainnet_refused':
        return make('invalid_input', "Mainnet isn't available yet: Recovery Key mode works on test networks only.");
      case 'network_mismatch':
        return make('network_mismatch');
      case 'wallet_exists':
        return make('wallet_exists', 'This phone already has a Recovery Key wallet.');
      case 'hardware_unavailable':
        return make('hardware', "This phone can't connect to a hardware wallet.");
      case 'hardware_mismatch':
        return make('hardware_mismatch');
      case 'hardware_invalid_response':
        return make('hardware', `The hardware wallet's answer didn't check out. ${e.message}`);
      case 'address_mismatch':
        return make('address_mismatch');
      case 'key_unavailable':
        return make('refused', "The phone key couldn't be unlocked. Try again, and confirm with Face ID or your fingerprint.");
      case 'kit_invalid':
      case 'kit_checksum':
      case 'kit_word':
        return make('kit_invalid');
      case 'kit_mismatch':
        return make('kit_invalid');
      case 'kit_not_confirmed':
        return make('kit_invalid');
      case 'invalid_address':
        return make('invalid_input', "That doesn't look like an address on this network.");
      case 'amount_too_small':
        return make('invalid_input', "That's too small to send. The smallest payment is 546 sats.");
      case 'insufficient_funds':
        return make('insufficient_funds', /refill|confirmed coins/i.test(e.message) ? e.message : "There isn't enough bitcoin for that and the network fee.");
      case 'state_tampered':
        return make('refused', `${e.message}`);
      case 'fee_too_high':
      case 'fee_cap_too_low':
      case 'nothing_to_sweep':
        return make('refused');
      case 'chain_source':
        return make('chain_unreachable', "Trikey can't read the chain from your server right now. Check your connection, or pick another server in Settings.");
      case 'broadcast_rejected': {
        const reason = typeof e.detail?.reason === 'string' ? e.detail.reason : '';
        return make('broadcast_failed', `The network refused the transaction${reason ? ` (${reason})` : ''}. Nothing was sent.`);
      }
      case 'refill_in_flight':
        return make('wrong_state', 'A refill is on its way. Approve new refills once it has confirmed.');
      case 'nothing_to_bump':
        return make('wrong_state', 'No refill is waiting for a faster fee.');
      case 'wrong_state':
        return make('wrong_state');
      case 'chain_invalid':
      case 'internal':
        return make('internal');
    }
  }
  return mapError(e);
}

/** "This kit is for signet" for a network mismatch the screens can offer to switch for. */
export function kitNetworkError(kitNetwork: string): WalletServiceError {
  return new WalletServiceError('network_mismatch', `This Recovery Kit is for ${networkLabel(kitNetwork)}, not the network this phone is set to.`, { network: kitNetwork });
}
