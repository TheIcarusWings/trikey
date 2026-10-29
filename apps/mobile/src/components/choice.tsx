import * as RadioGroupPrimitive from '@rn-primitives/radio-group';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * One option of a RadioGroup (`<RadioGroup value onValueChange>`). The whole row is the
 * radio, so the touch target is the full row and screen readers announce one control.
 *
 * `plain` rows sit in a list (backup provider, appearance). `card` rows are bordered
 * and carry a description, with a heavier border when selected (recovery wait, Recovery Key).
 */
export function RadioRow({
  value,
  selected,
  title,
  description,
  badge,
  variant = 'plain',
}: {
  value: string;
  selected: boolean;
  title: string;
  description?: string;
  badge?: string;
  variant?: 'plain' | 'card';
}) {
  const card = variant === 'card';

  const ring = (
    <View
      className={cn(
        'aspect-square size-5 shrink-0 items-center justify-center rounded-full border',
        selected ? 'border-primary' : 'border-chevron',
        card && 'mt-0.5'
      )}>
      <RadioGroupPrimitive.Indicator className="bg-primary size-2.5 rounded-full" />
    </View>
  );

  return (
    <RadioGroupPrimitive.Item
      value={value}
      accessibilityLabel={description ? `${title}. ${description}` : title}
      className={cn(
        'flex-row',
        card
          ? cn('items-start rounded-xl p-4', pick('gap-3 py-3.5', 'gap-4'), selected ? 'border-foreground border-[1.5px]' : 'border-border border')
          : cn('min-h-[52px] items-center', IS_IOS ? 'gap-3 px-4' : 'min-h-14 gap-4 px-0')
      )}>
      {ring}
      {card ? (
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{title}</Text>
            {badge ? (
              <Badge variant="secondary" className="rounded-md px-2 py-0.5">
                <Text className="text-xs font-medium leading-4">{badge}</Text>
              </Badge>
            ) : null}
          </View>
          {description ? <Text className="text-muted-foreground text-sm leading-5">{description}</Text> : null}
        </View>
      ) : (
        <Text className={pick('text-[17px]', 'text-base')}>{title}</Text>
      )}
    </RadioGroupPrimitive.Item>
  );
}

/** Heading plus explanation above a control: "Recovery waiting period". */
export function QuestionHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View className={cn('gap-2', pick('mt-2', 'mt-2 gap-1'))}>
      <Text role="heading" className={cn('font-semibold', pick('text-[17px] leading-[22px]', 'text-base font-medium leading-6'))}>
        {title}
      </Text>
      {children}
    </View>
  );
}
