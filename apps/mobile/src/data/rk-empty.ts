import { defaultServerUrl } from './rk-server';
import type { NetworkName, RecoveryKeyKind, RecoveryKeyState } from './types';

/** `WalletState.recoveryKey` for a wallet that is not in Recovery Key mode (or has nothing in it yet). */
export function emptyRecoveryKeyState(opts: { keyKind?: RecoveryKeyKind; network?: NetworkName | null } = {}): RecoveryKeyState {
  return {
    keyKind: opts.keyKind ?? 'paper',
    stage: 'new',
    savedKey: null,
    fingerprint: null,
    spendingSats: 0,
    vaultSats: 0,
    refillAmountSats: 200_000,
    refillCount: 8,
    refillsLeft: 0,
    refillsTotal: 0,
    refillsStatus: 'none',
    needsApproval: false,
    invalidatedBy: null,
    next: null,
    notices: [],
    speedUp: null,
    server: { url: defaultServerUrl(opts.network ?? 'testnet'), isDefault: true },
    syncedAt: null,
    refills: [],
    activity: [],
  };
}
