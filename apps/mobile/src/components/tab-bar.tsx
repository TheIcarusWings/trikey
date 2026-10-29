import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { House, List, SlidersHorizontal } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { IS_IOS, IS_WEB } from '@/lib/platform';
import { cn } from '@/lib/utils';

const TABS: Record<string, { label: string; icon: LucideIcon }> = {
  home: { label: 'Home', icon: House },
  activity: { label: 'Activity', icon: List },
  settings: { label: 'Settings', icon: SlidersHorizontal },
};

/**
 * Bottom navigation in each platform's design: a plain tab bar on iOS, and a
 * Material 3 navigation bar on Android with the active pill behind the icon.
 */
export function TabBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const bottom = IS_WEB ? (IS_IOS ? 30 : 16) : IS_IOS ? Math.max(insets.bottom - 4, 8) : Math.max(insets.bottom, 16);

  return (
    <View
      role="tablist"
      accessibilityLabel="Main"
      className="bg-background border-border flex-row border-t"
      style={IS_IOS ? { paddingTop: 8, paddingHorizontal: 24, paddingBottom: bottom } : { paddingTop: 12, paddingHorizontal: 8, paddingBottom: bottom }}>
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;

        const onPress = () => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        };

        return (
          <Pressable
            key={route.key}
            role="tab"
            aria-selected={focused}
            accessibilityLabel={tab.label}
            onPress={onPress}
            className={cn('flex-1 items-center', IS_IOS ? 'min-h-11 gap-[3px]' : 'min-h-[52px] gap-1')}>
            {IS_IOS ? (
              <Icon as={tab.icon} size={26} strokeWidth={1.8} className={focused ? 'text-primary' : 'text-muted-foreground'} />
            ) : (
              <View className={cn('h-8 w-16 items-center justify-center rounded-2xl', focused && 'bg-accent')}>
                <Icon
                  as={tab.icon}
                  size={24}
                  strokeWidth={1.8}
                  className={focused ? 'text-accent-foreground' : 'text-muted-foreground'}
                />
              </View>
            )}
            <Text
              className={cn(
                IS_IOS ? 'text-[10px]' : 'text-xs',
                IS_IOS && focused ? 'text-primary font-semibold' : 'font-medium',
                !IS_IOS && focused ? 'text-foreground' : null,
                !focused && 'text-muted-foreground'
              )}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
