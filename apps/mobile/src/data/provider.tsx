import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { WalletService } from './service';
import type { ActivityItem, WalletState } from './types';

const WalletContext = createContext<WalletService | null>(null);

/**
 * Hands the screens a `WalletService`. The app root passes the mock today and the
 * real wallet later; nothing under `app/` or `src/components` imports ./mock.
 */
export function WalletProvider({ service, children }: { service: WalletService; children: ReactNode }) {
  return <WalletContext.Provider value={service}>{children}</WalletContext.Provider>;
}

/** The actions: `const wallet = useWalletService(); await wallet.setDailyLimit(500_000)`. */
export function useWalletService(): WalletService {
  const service = useContext(WalletContext);
  if (!service) throw new Error('useWalletService must be used inside <WalletProvider>');
  return service;
}

/** The current state. Re-renders when the wallet changes. */
export function useWallet(): WalletState {
  const service = useWalletService();
  return useSyncExternalStore(service.subscribe, service.getState, service.getState);
}

export function useNow(): Date {
  return useWalletService().now();
}

/** Activity for whichever home is showing: the guardian wallet's or the Recovery Key wallet's. */
export function useActivity(): ActivityItem[] {
  const state = useWallet();
  return state.mode === 'recoveryKey' ? state.recoveryKey.activity : state.activity;
}
