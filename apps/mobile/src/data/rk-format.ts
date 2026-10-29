import { daysBetween, formatCountdown, formatInDays, formatSats } from './format';
import type { NextRefill } from './types';

/** "+200,000 in 3 days", "+200,000 ready", "+200,000 arriving": where the next refill stands, in a few words. */
export function nextRefillText(next: NextRefill, now: Date): string {
  const amount = `+${formatSats(next.amountSats)}`;
  switch (next.status) {
    case 'ready':
      return `${amount} ready`;
    case 'arriving':
      return `${amount} arriving`;
    case 'waiting':
    case 'pending': {
      if (next.status === 'pending' || !next.etaAt) return `${amount} after ${next.index > 1 ? `refill ${next.index - 1}` : 'the last transaction'} confirms`;
      const ms = new Date(next.etaAt).getTime() - now.getTime();
      return `${amount} ${ms < 24 * 3_600_000 ? `in ${formatCountdown(ms)}` : formatInDays(daysBetween(now, new Date(next.etaAt)))}`;
    }
  }
}

/** One line under the next refill: what it is waiting for, so "ready" does not look like "nothing is happening". */
export function nextRefillHint(next: NextRefill): string | null {
  switch (next.status) {
    case 'ready':
      return 'Your phone sends it when the spending balance runs low.';
    case 'waiting':
      return `Refill ${next.index} unlocks a week after the one before it. None can arrive early.`;
    case 'arriving':
      return 'Sent, waiting for the network to confirm it.';
    case 'pending':
      return `Refill ${next.index} waits for the one before it to confirm.`;
  }
}

