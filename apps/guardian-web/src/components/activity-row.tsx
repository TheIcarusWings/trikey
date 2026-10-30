import type { ActivityEntry, ActivityResult } from '@/api';
import { formatSats, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

/** What the result column says. A passphrase unlock is "Unlocked" rather than a bare "OK". */
export function resultLabel(entry: ActivityEntry): string {
  switch (entry.result) {
    case 'co-signed':
      return 'Co-signed';
    case 'refused':
      return 'Refused';
    case 'locked':
      return 'Locked';
    case 'rule-changed':
      return 'Changed';
    case 'ok':
      return /unlock/i.test(entry.summary ?? entry.event) ? 'Unlocked' : 'OK';
  }
}

const TONE: Record<ActivityResult, string> = {
  'co-signed': 'text-good',
  refused: 'text-bad',
  locked: 'text-warn',
  ok: 'text-muted-foreground',
  'rule-changed': 'text-muted-foreground',
};

function approvedOn(signedBy: string): string {
  return `approved on ${signedBy.toLowerCase() === 'hardware wallet' ? 'the hardware wallet' : signedBy}`;
}

/** One line of activity: what happened and when, the amount, and the outcome in words and color. */
export function ActivityRow({ entry, className }: { entry: ActivityEntry; className?: string }) {
  const meta = [formatWhen(entry.at)];
  if (entry.kind === 'rules' && entry.signedBy) meta.push(approvedOn(entry.signedBy));
  const sats = entry.sats === null ? null : `${formatSats(entry.sats)} sats`;
  return (
    <li className={cn('flex min-h-14 items-center gap-3 border-t py-1.5 first:border-t-0', className)}>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-[15px] leading-5">{entry.summary ?? entry.event}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          {meta.join(' · ')}
          {sats && <span className="sm:hidden"> · {sats}</span>}
        </span>
      </span>
      {sats && <span className="hidden text-sm text-muted-foreground tabular-nums sm:block">{sats}</span>}
      <span className={cn('min-w-[76px] text-right text-[13px] leading-5 font-semibold', TONE[entry.result])}>{resultLabel(entry)}</span>
    </li>
  );
}
