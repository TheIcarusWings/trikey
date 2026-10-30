import type { LucideIcon } from 'lucide-react-native';
import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { useWallet, type AppMode, type NetworkName } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** Inserts a hairline between children, like the bordered lists in the designs. */
function withSeparators(children: ReactNode) {
  const items = Children.toArray(children).filter(Boolean);
  return items.map((child, i) => (
    <Fragment key={i}>
      {i > 0 ? <Separator /> : null}
      {child}
    </Fragment>
  ));
}

/** A bordered 12px panel whose rows are divided by hairlines. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn('overflow-hidden', className)}>{withSeparators(children)}</Card>;
}

/**
 * iOS wraps list rows in a bordered panel with hairlines between them. Android lets
 * them run flat, with hairlines only where `divided` asks for them.
 */
export function ListGroup({ children, divided }: { children: ReactNode; divided?: boolean }) {
  if (IS_IOS) return <Panel>{children}</Panel>;
  return <View>{divided ? withSeparators(children) : children}</View>;
}

type Tone = 'default' | 'muted' | 'good' | 'warn' | 'bad';

const TONE_CLASS: Record<Tone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-destructive',
};

/** "Date .......... Today, 9:42": label left in muted, value right. */
export function InfoRow({
  label,
  value,
  tone = 'default',
  mono,
  strong,
  valueStrong,
  plainLabel,
  tabular,
}: {
  label: string;
  value: string;
  tone?: Tone;
  mono?: boolean;
  /** Label and value both semibold (a total). */
  strong?: boolean;
  /** Only the value semibold. */
  valueStrong?: boolean;
  /** Label in ink instead of muted (the summary after a recovery). */
  plainLabel?: boolean;
  tabular?: boolean;
}) {
  return (
    <View
      className={cn('flex-row justify-between gap-4 px-4', pick('py-3.5', 'py-4'))}
      accessible
      accessibilityLabel={`${label}: ${value}`}>
      <Text className={cn('text-[15px] leading-5', strong ? 'font-semibold' : plainLabel ? '' : 'text-muted-foreground')}>{label}</Text>
      <Text
        className={cn(
          'shrink text-right text-[15px] leading-5',
          TONE_CLASS[tone],
          mono && 'font-mono',
          (strong || valueStrong) && 'font-semibold',
          tabular && 'tabular-nums'
        )}>
        {value}
      </Text>
    </View>
  );
}

/** "Hardware wallet .... Ledger Nano X": label in ink, value muted. Used for the summaries. */
export function SummaryRow({ label, value, tone = 'muted', tabular }: { label: string; value: string; tone?: Tone; tabular?: boolean }) {
  return (
    <View
      className={cn('flex-row items-center justify-between gap-4', pick('min-h-[52px] px-4', 'min-h-14 px-0'))}
      accessible
      accessibilityLabel={`${label}: ${value}`}>
      <Text className={cn(pick('text-[17px]', 'text-base'))}>{label}</Text>
      <Text className={cn('shrink text-right', pick('text-[17px]', 'text-base'), TONE_CLASS[tone], tabular && 'tabular-nums')}>
        {value}
      </Text>
    </View>
  );
}

/** Section heading in settings: small caps on iOS, plain on Android. */
export function SectionLabel({ children, first }: { children: string; first?: boolean }) {
  return IS_IOS ? (
    <Text role="heading" className="text-muted-foreground mt-2 text-xs font-semibold uppercase leading-4 tracking-[0.48px]">
      {children}
    </Text>
  ) : (
    <>
      {first ? null : <View className="bg-border my-2 h-px" />}
      <Text role="heading" className={cn('text-muted-foreground px-0 pb-2 text-[13px] font-semibold leading-4', first ? 'pt-4' : 'pt-2')}>
        {children}
      </Text>
    </>
  );
}

/** One row of the settings lists: label and value with a chevron (iOS), or two lines (Android). */
export function SettingsRow({
  title,
  value,
  subtitle,
  dot,
  onPress,
  tabular,
  accessibilityHint,
}: {
  title: string;
  value?: string;
  /** A second line under the title, on both platforms ("Takes its passphrase to unlock"). */
  subtitle?: string;
  /** A status dot before the value. */
  dot?: 'good' | 'warn' | 'bad';
  onPress?: () => void;
  tabular?: boolean;
  accessibilityHint?: string;
}) {
  const dotClass = dot === 'good' ? 'bg-good' : dot === 'warn' ? 'bg-warn' : 'bg-destructive';
  const content = IS_IOS ? (
    <View className={cn('min-h-[52px] flex-row items-center gap-3 px-4', subtitle && 'py-3')}>
      {subtitle ? (
        <View className="flex-1 gap-0.5">
          <Text className="text-base">{title}</Text>
          <Text className="text-muted-foreground text-[13px] leading-[18px]">{subtitle}</Text>
        </View>
      ) : (
        <Text className="flex-1 text-base">{title}</Text>
      )}
      {value ? (
        <View className="flex-row items-center gap-1.5">
          {dot ? <View className={cn('size-[7px] rounded-full', dotClass)} /> : null}
          <Text className={cn('text-muted-foreground text-[15px]', tabular && 'tabular-nums')}>{value}</Text>
        </View>
      ) : null}
      {onPress ? <Icon as={ChevronRight} size={18} className="text-chevron" strokeWidth={2} /> : null}
    </View>
  ) : (
    <View className="min-h-16 justify-center">
      <Text className="text-base leading-6">{title}</Text>
      {subtitle ? <Text className="text-muted-foreground text-sm leading-5">{subtitle}</Text> : null}
      {value ? (
        <View className="flex-row items-center gap-1.5">
          {dot ? <View className={cn('size-[7px] rounded-full', dotClass)} /> : null}
          <Text className={cn('text-muted-foreground text-sm leading-5', tabular && 'tabular-nums')}>{value}</Text>
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      role="link"
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      className="active:bg-accent">
      {content}
    </Pressable>
  );
}

const NOTICE_TONE = {
  outline: 'border border-border',
  fill: 'bg-secondary',
  warn: 'bg-warn-soft',
  'warn-outline': 'bg-warn-soft border border-border',
} as const;

/** An icon beside a short explanation. The designs use these for rules and warnings. */
export function Notice({
  icon,
  iconClass = 'text-foreground',
  tone = 'outline',
  title,
  children,
}: {
  icon?: LucideIcon;
  iconClass?: string;
  tone?: keyof typeof NOTICE_TONE;
  title?: string;
  children: ReactNode;
}) {
  return (
    <View className={cn('flex-row items-start gap-3 rounded-xl px-4 py-3.5', NOTICE_TONE[tone])}>
      {icon ? <Icon as={icon} size={20} className={cn('mt-px', iconClass)} strokeWidth={1.8} /> : null}
      <View className="flex-1 gap-1">
        {title ? <Text className="text-[15px] font-semibold leading-5">{title}</Text> : null}
        <Text className={cn('text-sm leading-5', title && 'text-muted-foreground')}>{children}</Text>
      </View>
    </View>
  );
}

/** Which network the wallet is on, for test networks and the demo: "Testnet", "Signet", "Regtest", "Demo". Nothing on mainnet. */
export function networkLabel(backing: AppMode, network: NetworkName | null): string | null {
  if (backing === 'demo') return 'Demo';
  switch (network) {
    case 'testnet':
      return 'Testnet';
    case 'signet':
      return 'Signet';
    case 'regtest':
      return 'Regtest';
    default:
      return null;
  }
}

/** The network chip on Home and Receive, so test coins are never mistaken for real ones. */
export function NetworkPill() {
  const { backing, network } = useWallet();
  const label = networkLabel(backing, network);
  if (!label) return null;
  return (
    <View accessible accessibilityLabel={backing === 'demo' ? 'Demo mode, sample data' : `${label} wallet, test bitcoin only`}>
      <Pill dot="warn" strong>
        {label}
      </Pill>
    </View>
  );
}

/** Small rounded status chip: "Confirmed", "Within today's limit". */
export function Pill({
  children,
  tone = 'outline',
  dot,
  strong,
}: {
  children: ReactNode;
  tone?: 'outline' | 'good';
  dot?: 'good' | 'warn';
  strong?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 self-start px-2.5 py-0.5', tone === 'good' && 'bg-good-soft border-transparent')}>
      {dot ? <View className={cn('size-1.5 rounded-full', dot === 'good' ? 'bg-good' : 'bg-warn')} /> : null}
      <Text
        className={cn(
          'text-xs leading-5',
          tone === 'good' ? 'text-good font-semibold' : 'text-foreground font-medium',
          strong && 'font-semibold',
          'tabular-nums'
        )}>
        {children}
      </Text>
    </Badge>
  );
}

/** Body copy under a title: 15/21 on iOS, 14/20 on Android, muted. */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[21px]', 'text-sm leading-5'), className)}>{children}</Text>;
}

/** 13/18 muted footnote. */
export function Footnote({ children, className }: { children: ReactNode; className?: string }) {
  return <Text className={cn('text-muted-foreground text-[13px] leading-[18px]', className)}>{children}</Text>;
}

/** Field label above an input. Pair `nativeID` with the input's `aria-labelledby`. */
export function FieldLabel({ children, nativeID }: { children: string; nativeID?: string }) {
  return (
    <Label nativeID={nativeID} className="text-sm font-medium leading-5">
      {children}
    </Label>
  );
}
