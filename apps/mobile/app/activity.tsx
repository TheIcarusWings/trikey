import { useMemo } from 'react';
import { View } from 'react-native';
import { ActivityRow } from '@/components/activity-row';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { groupLabel, useActivity, useNow, useWallet, useWalletService, type ActivityItem } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function ActivityScreen() {
  const state = useWallet();
  const wallet = useWalletService();
  const now = useNow();
  const all = useActivity();

  const sections = useMemo(() => {
    const groups: { label: string; items: ActivityItem[] }[] = [];
    for (const item of all) {
      const label = groupLabel(item.at, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(item);
      else groups.push({ label, items: [item] });
    }
    return groups;
  }, [all, now]);

  const ctx = { now, unit: state.unit, hardwareBrand: state.hardware.brand };

  return (
    <Screen title="Activity" backLabel="Home" gap={14} onRefresh={() => wallet.sync()}>
      {sections.length === 0 ? (
        <View className="items-center gap-2 px-6 py-16">
          <Text role="heading" aria-level={2} className={cn('text-center font-semibold', pick('text-[17px] leading-[22px]', 'text-base leading-[22px]'))}>
            No payments yet
          </Text>
          <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
            Payments you send and receive show up here.
          </Text>
        </View>
      ) : null}
      {sections.map((section) => (
        <View key={section.label}>
          <Text
            role="heading"
            className={cn(
              'text-muted-foreground font-semibold',
              IS_IOS ? 'mt-1 pb-0 text-xs uppercase leading-4 tracking-[0.48px]' : 'pb-1 pt-2 text-[13px] leading-4'
            )}>
            {section.label}
          </Text>
          {section.items.map((item, i) => (
            <ActivityRow
              key={item.type === 'payment' ? item.tx.id : item.event.id}
              item={item}
              variant="activity"
              last={i === section.items.length - 1}
              ctx={ctx}
            />
          ))}
        </View>
      ))}
    </Screen>
  );
}
