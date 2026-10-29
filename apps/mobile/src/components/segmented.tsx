import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export type SegmentOption<T> = { value: T; label: string };

type Props<T> = {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What the control picks, for screen readers. */
  accessibilityLabel: string;
  /** Android look: a filled track like iOS, or the joined outline used for presets. */
  android?: 'filled' | 'outlined';
  /** Shorter (32px) items with a shadowed thumb: the Activity filter. */
  compact?: boolean;
  /** Muted labels for the unselected options (Activity and Review) instead of ink. */
  mutedUnselected?: boolean;
  /** Selected label in semibold (the onboarding presets). */
  boldSelected?: boolean;
  /** 'tab' for filters, 'radio' for a single choice among values. */
  role?: 'tab' | 'radio';
};

/** iOS segmented control; on Android either the same filled track or a joined outline. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  accessibilityLabel,
  android = 'filled',
  compact,
  mutedUnselected,
  boldSelected,
  role = 'radio',
}: Props<T>) {
  const outlined = !IS_IOS && android === 'outlined';
  const itemHeight = outlined ? 'h-10' : IS_IOS ? (compact ? 'h-8' : 'h-9') : 'h-10';

  return (
    <View
      role={role === 'tab' ? 'tablist' : 'radiogroup'}
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'flex-row',
        outlined
          ? 'border-border overflow-hidden rounded-[10px] border'
          : cn('bg-seg gap-1 rounded-[10px]', compact ? 'p-1' : pick('p-[3px]', 'p-1'))
      )}>
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            role={role}
            aria-selected={role === 'tab' ? selected : undefined}
            aria-checked={role === 'radio' ? selected : undefined}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 6, bottom: 6 }}
            className={cn(
              'flex-1 items-center justify-center',
              itemHeight,
              outlined
                ? cn(i < options.length - 1 && 'border-border border-r', selected && 'bg-accent')
                : cn('rounded-lg', selected && 'bg-seg-selected', selected && compact && 'shadow-sm shadow-black/10')
            )}>
            <Text
              className={cn(
                'text-sm',
                selected ? 'text-foreground' : mutedUnselected ? 'text-muted-foreground' : 'text-foreground',
                selected && boldSelected ? 'font-semibold' : 'font-medium'
              )}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Activity filter: segmented on iOS, separate chips on Android. */
export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  if (IS_IOS) {
    return <Segmented role="tab" compact mutedUnselected options={options} value={value} onChange={onChange} accessibilityLabel="Filter" />;
  }
  return (
    <View role="tablist" accessibilityLabel="Filter" className="flex-row gap-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            role="tab"
            aria-selected={selected}
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 6, bottom: 6 }}
            className={cn(
              'h-8 justify-center rounded-lg border px-3.5',
              selected ? 'border-primary bg-primary' : 'border-border bg-transparent'
            )}>
            <Text className={cn('text-sm font-medium', selected ? 'text-primary-foreground' : 'text-foreground')}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
