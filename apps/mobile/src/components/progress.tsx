import { View } from 'react-native';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * A thin bar: how much of the daily limit is left, how far a recovery has come.
 * Plain views, no animation library, so it renders the same everywhere.
 */
export function ProgressBar({
  fraction,
  label,
  fillClassName = 'bg-good',
  trackClassName = 'bg-border',
  thick,
}: {
  /** 0 to 1. */
  fraction: number;
  /** Spoken value, e.g. "180,000 of 200,000 sats left". */
  label: string;
  fillClassName?: string;
  trackClassName?: string;
  /** 6px on both platforms (recovery countdown) instead of 6 iOS / 4 Android. */
  thick?: boolean;
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <View
      role="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      className={cn('overflow-hidden rounded-full', thick ? 'h-1.5' : pick('h-1.5', 'h-1'), trackClassName)}>
      <View className={cn('h-full rounded-full', fillClassName)} style={{ width: `${clamped * 100}%` }} />
    </View>
  );
}
