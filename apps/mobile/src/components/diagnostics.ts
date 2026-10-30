import type { WalletState } from '../data/types';

/** Where "Report a problem" sends people: the public issue tracker, with the form filled in. */
export const ISSUES_URL = 'https://github.com/TheIcarusWings/trikey/issues/new';

const yes = (b: boolean) => (b ? 'yes' : 'no');

/**
 * What "Report a problem" tells the developers, one line per fact, from the wallet's state only. It is public once
 * posted, so it names kinds and states, never anything that identifies the wallet or its money: no descriptor, address,
 * txid, amount, fingerprint, npub, relay URL, server URL or contact name.
 */
export function diagnostics(state: WalletState, app: { version: string; os: string; osVersion: string }): string[] {
  const lines = [
    `Trikey ${app.version} (pre-alpha)`,
    `Phone: ${app.os} ${app.osVersion}`,
    `Wallet: ${state.backing} · ${state.network ?? 'no network'} · ${state.mode === 'recoveryKey' ? 'Recovery Key' : 'guardian'} mode`,
    `Set up: ${yes(state.onboarded)}${state.recovering ? ' · recovering on this phone' : ''}`,
    // The kind only: the model can carry the device's own (Bluetooth) name.
    `Hardware wallet: ${state.hardware.kind}`,
  ];
  if (state.mode === 'guardian') {
    const g = state.guardian;
    const relays = g.relaysConnected === undefined ? '' : ` · relays ${g.relaysConnected}/${g.relays.length}`;
    lines.push(`Guardian: ${g.status} · ${g.host}${relays}`);
    lines.push(`Phone-only payments: ${state.phoneSpending}`);
  }
  lines.push(`Backup: ${state.backup ? state.backup.provider : 'none'}`);
  lines.push(`Address checked on the device: ${yes(state.addressVerified)}`);
  const r = state.recovery;
  lines.push(
    r
      ? `Recovery: started ${r.origin === 'this-phone' ? 'here' : 'elsewhere'} · lost ${r.lostKey} · ${r.state ?? 'pending'}${r.sweepUpdate ? ` · late coins ${r.sweepUpdate.status}` : ''}`
      : `Recovery: none${state.recoveryOutcome ? ` (last one ${state.recoveryOutcome})` : ''}`,
  );
  const sp = state.silentPayments;
  lines.push(`Silent payments: ${sp.setUp ? `set up · receiving ${yes(sp.receiving)} · scan ${sp.scan.state} (${sp.scan.source})` : 'not set up'}`);
  lines.push(`Synced: ${yes(state.synced)}`);
  return lines;
}

/** The new-issue page with the title and the body (questions, then the diagnostics) filled in. */
export function issueUrl(lines: string[]): string {
  const body = ['**What happened?**', '', '', '**What did you expect?**', '', '', '**Diagnostics** (from the app)', '```', ...lines, '```'].join('\n');
  return `${ISSUES_URL}?title=${encodeURIComponent('Alpha: ')}&body=${encodeURIComponent(body)}`;
}
