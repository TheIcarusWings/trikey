/**
 * One phone, one wallet of one kind per mode and network: a guardian wallet or a Recovery Key wallet.
 *
 * The screens talk to a single `WalletService`. This one holds both real services (the guardian mode's in ./real.ts and
 * Recovery Key mode's in ./rk-service.ts) and hands every call to the one the phone runs. Which one that is:
 *
 * - the one that has a finished wallet on this phone (in this app mode);
 * - otherwise the last kind the person picked at onboarding ("No home server?" picks Recovery Key mode), kept in the
 *   key-value store so a restart in the middle of setting up goes on where it was;
 * - otherwise the guardian mode.
 *
 * While neither wallet is finished, `setMode` switches between them (onboarding's two paths). Once a wallet is there it
 * does nothing: a phone does not run two wallets at once, and removing the wallet is how it starts over.
 *
 * Mainnet is the guardian mode's only. Picking it while Recovery Key mode is the one in use, before anything is set up,
 * moves the phone to the guardian mode; Recovery Key mode keeps its test network.
 */
import type { KeyValueStore } from '@trikey/wallet';
import { WalletServiceError } from './errors';
import type { WalletService } from './service';
import type { AmountUnit, NetworkName, ThemePreference, WalletMode } from './types';

export type RoutedWalletService = WalletService & { close(): Promise<void>; readonly kind: WalletMode };

type Member = WalletService & { close?(): Promise<void> };

export const kindPrefKey = (mode: string) => `trikey.app.kind.${mode}`;

/** Which kind a phone should open: see the module comment. */
export async function pickInitialKind(opts: { mode: string; kv: KeyValueStore; guardian: Member; recoveryKey: Member }): Promise<WalletMode> {
  const g = opts.guardian.getState();
  const r = opts.recoveryKey.getState();
  const guardianHas = g.onboarded || g.recovering;
  if (guardianHas && !r.onboarded) return 'guardian';
  if (r.onboarded && !guardianHas) return 'recoveryKey';
  let saved: string | null = null;
  try {
    saved = await opts.kv.get(kindPrefKey(opts.mode));
  } catch {
    /* no preference */
  }
  return saved === 'recoveryKey' ? 'recoveryKey' : 'guardian';
}

export function createRoutedWalletService(opts: { mode: string; kv: KeyValueStore; guardian: Member; recoveryKey: Member; initial: WalletMode }): RoutedWalletService {
  let active: WalletMode = opts.initial;
  const listeners = new Set<() => void>();
  const members: Member[] = [opts.guardian, opts.recoveryKey];
  const current = (): Member => (active === 'recoveryKey' ? opts.recoveryKey : opts.guardian);
  const notify = () => listeners.forEach((l) => l());
  for (const m of members) m.subscribe(notify);

  const finished = (m: Member) => {
    const s = m.getState();
    return s.onboarded || s.recovering;
  };
  const switchTo = (mode: WalletMode) => {
    // The demo's mock shows either home; a real phone only chooses before it has a wallet.
    if (finished(current()) || mode === active) return;
    active = mode;
    void opts.kv.set(kindPrefKey(opts.mode), mode).catch(() => undefined);
    notify();
  };

  const own = {
    get kind(): WalletMode {
      return active;
    },
    getState: () => current().getState(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setNetwork(network: NetworkName) {
      // The network is chosen before the wallet exists, and both kinds start on it.
      // A kind that already has an unfinished wallet keeps its network; only the one in use may refuse.
      let refused: unknown;
      let other: Member | undefined;
      for (const m of members) {
        if (finished(m)) continue;
        try {
          m.setNetwork(network);
          if (m !== current()) other = m;
        } catch (e) {
          if (m === current()) refused = e;
        }
      }
      if (refused === undefined) return;
      // Recovery Key mode said no to the network itself (mainnet) and the guardian mode took it: that is the mode for it.
      if (other === opts.guardian && refused instanceof WalletServiceError && refused.kind === 'invalid_input') return switchTo('guardian');
      throw refused;
    },
    acceptMainnetRisk(accepted: boolean) {
      for (const m of members) m.acceptMainnetRisk(accepted);
    },
    setUnit(unit: AmountUnit) {
      for (const m of members) m.setUnit(unit);
    },
    setTheme(theme: ThemePreference) {
      for (const m of members) m.setTheme(theme);
    },
    setMode(mode: WalletMode) {
      switchTo(mode);
    },
    async close() {
      await Promise.all(members.map((m) => m.close?.().catch(() => undefined)));
    },
  };

  return new Proxy(own as unknown as RoutedWalletService, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      const service = current() as unknown as Record<PropertyKey, unknown>;
      const value = service[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(service) : value;
    },
  });
}
