import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActivityRow } from '@/components/activity-row';
import { Screen } from '@/components/screen';
import { FilterTabs } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { groupLabel, useActivity, useNow, useWallet, type ActivityItem } from '@/data';
import { IS_IOS } from '@/lib/platform';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'payments' | 'security';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'payments', label: 'Payments' },
  { value: 'security', label: 'Security' },
];

export default function ActivityScreen() {
  const state = useWallet();
  const now = useNow();
  const all = useActivity();
  const [filter, setFilter] = useState<Filter>('all');

  const sections = useMemo(() => {
    const visible = all.filter((item) => filter === 'all' || (filter === 'payments' ? item.type === 'payment' : item.type === 'security'));
    const groups: { label: string; items: ActivityItem[] }[] = [];
    for (const item of visible) {
      const label = groupLabel(item.at, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(item);
      else groups.push({ label, items: [item] });
    }
    return groups;
  }, [all, filter, now]);

  const ctx = { now, unit: state.unit, hardwareBrand: state.hardware.brand };

  return (
    <Screen tab title="Activity" gap={14}>
      <FilterTabs options={FILTERS} value={filter} onChange={setFilter} />
      {sections.length === 0 ? (
        <Text className="text-muted-foreground py-8 text-center text-[15px]">Nothing here yet.</Text>
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
