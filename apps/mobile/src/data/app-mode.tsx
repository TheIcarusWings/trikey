import { createContext, useContext, type ReactNode } from 'react';
import type { AppMode } from './types';

export interface AppModeControl {
  mode: AppMode;
  /** The modes this phone offers. */
  available: AppMode[];
  /** Saves the choice and restarts the wallet in that mode. Nothing is deleted: each mode keeps its own data. */
  switchTo(mode: AppMode): Promise<void>;
}

const AppModeContext = createContext<AppModeControl | null>(null);

export function AppModeProvider({ value, children }: { value: AppModeControl; children: ReactNode }) {
  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}

export function useAppMode(): AppModeControl {
  const v = useContext(AppModeContext);
  if (!v) throw new Error('useAppMode must be used inside <AppModeProvider>');
  return v;
}
