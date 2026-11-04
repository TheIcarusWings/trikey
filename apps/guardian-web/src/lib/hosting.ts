/**
 * Words and small rules of the "Host for someone" page (docs/design/family-hosting.md, sections 2, 7 and 9). Kept out
 * of the page so they are tested: the disclosure must stay true (the page never shows a guest's amounts, but the box
 * does store what it co-signs), and Stop hosting must say what it costs.
 */
import type { HostedWallet } from '@/api';

/** What the host is told when making an invite (section 9). */
export const HOST_DISCLOSURE_TITLE = "You'll hold one of their three keys";
export const HOST_DISCLOSURE = [
  "You can't spend their money, and this page never shows their balance or their payments. Your box does store the payments it co-signs for them: treat its data as theirs.",
  "They're counting on you to keep this box online, unlock it after every restart, let a recovery wait run its full length, and never help anyone get around it. While you host, Reset is refused. To stop, use Stop hosting: they get 30 days to move.",
] as const;

/** What "stop now" must be confirmed with, typed exactly (the guardian checks it too). */
export const STOP_NOW_CONFIRMATION = 'STOP HOSTING NOW';

export const STOP_NOW_WARNING =
  "Stopping now deletes their key on this box at once. If they have lost their phone or their hardware wallet at this moment, they lose their money. Give them notice instead unless you must.";

export const LINK_SHOWN_ONCE = 'The link is shown only once: this box keeps just a fingerprint of it. If you lost it, cancel this invite and make a new one.';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The second line of a hosted wallet's row. Names, states and dates only: never an amount. */
export function hostedWalletLine(w: HostedWallet): string {
  switch (w.state) {
    case 'invited':
      return 'Invite sent · not accepted yet';
    case 'recovering':
      return `Recovery waiting until ${w.recoveryReadyAt ? day(w.recoveryReadyAt) : 'soon'}. Keep this box on and unlocked.`;
    case 'leaving':
      return `You stopped hosting · they have until ${w.endsAt ? day(w.endsAt) : 'soon'} to move`;
    case 'ended':
      return `Hosting ended${w.endedAt ? ` ${day(w.endedAt)}` : ''} · their key here is gone`;
    case 'left':
      return `They moved their wallet away${w.endedAt ? ` ${day(w.endedAt)}` : ''}`;
    case 'active':
      return `Since ${w.since ? day(w.since) : 'recently'}${w.recoveryDelayDays ? ` · ${w.recoveryDelayDays}-day recovery wait` : ''}`;
  }
}

/** The weekly count, the only trace of their payments the page shows. */
export function paymentsLine(w: HostedWallet): string | undefined {
  if (w.state !== 'active' && w.state !== 'leaving' && w.state !== 'recovering') return undefined;
  const n = w.paymentsThisWeek ?? 0;
  return `Signed ${n} ${n === 1 ? 'payment' : 'payments'} this week`;
}

/** Which actions a row offers. */
export function hostedWalletActions(w: HostedWallet): { cancelInvite: boolean; stop: boolean; stopNow: boolean; remove: boolean } {
  return {
    cancelInvite: w.state === 'invited',
    // Refused by the guardian while their recovery runs: not offered then.
    stop: w.state === 'active',
    stopNow: w.state === 'active' || w.state === 'leaving',
    remove: w.state === 'ended' || w.state === 'left',
  };
}

/** The Reset page's hint while hosting (the guardian refuses with `hosting_active`). */
export const RESET_WHILE_HOSTING = 'Reset is refused while this box hosts wallets for others: it would destroy their keys. Stop hosting each of them first (Host for someone).';
