import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme/use-theme';

export type AppButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';

type Props = {
  title: string;
  onPress?: () => void;
  variant?: AppButtonVariant;
  /** hero: 52px on iOS, used for the main action on onboarding and home. regular: 48px. compact: 36px. */
  size?: 'hero' | 'regular' | 'compact';
  /** Red label on an outline button ("Cancel recovery", "Replace guardian"). */
  danger?: boolean;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Shows a spinner and ignores presses. */
  busy?: boolean;
  accessibilityLabel?: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
};

const VARIANT_MAP = {
  primary: 'default',
  secondary: 'secondary',
  outline: 'outline',
  ghost: 'ghost',
  destructive: 'destructive',
} as const;

/**
 * The one button the screens use. It wraps reusables' Button and applies the
 * type and height each platform's design calls for.
 */
export function AppButton({
  title,
  onPress,
  variant = 'primary',
  size = 'regular',
  danger,
  icon,
  disabled,
  busy,
  accessibilityLabel,
  className,
  style,
}: Props) {
  const { colors } = useTheme();
  const isLink = variant === 'ghost';

  const height =
    size === 'compact'
      ? pick('h-9 px-3.5', 'h-10 px-4')
      : size === 'hero'
        ? pick(isLink ? 'h-11' : 'h-[52px]', 'h-12')
        : isLink
          ? pick('h-11', 'h-12')
          : 'h-12';

  const type =
    size === 'compact'
      ? 'text-sm font-medium'
      : size === 'hero'
        ? pick(isLink ? 'text-[17px] font-medium' : 'text-[17px] font-semibold', 'text-[15px] font-medium tracking-[0.15px]')
        : pick(isLink ? 'text-[17px] font-medium' : 'text-base font-medium', 'text-[15px] font-medium tracking-[0.15px]');

  return (
    <Button
      variant={VARIANT_MAP[variant]}
      disabled={disabled || busy}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      hitSlop={size === 'compact' ? { top: 4, bottom: 4 } : undefined}
      className={cn(height, size === 'compact' && 'rounded-lg', 'self-stretch', className)}
      style={style}>
      {busy ? (
        <ActivityIndicator size="small" color={variant === 'primary' ? colors.onAccent : colors.ink} />
      ) : icon ? (
        <Icon as={icon} size={size === 'compact' ? 16 : 20} strokeWidth={2} />
      ) : null}
      <Text className={cn(type, danger && 'text-destructive')}>{title}</Text>
    </Button>
  );
}
