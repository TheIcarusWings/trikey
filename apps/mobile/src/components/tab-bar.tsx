import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { House, Shield } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { IS_IOS, IS_WEB } from '@/lib/platform';
import { cn } from '@/lib/utils';

const TABS: Record<string, { label: string; icon: LucideIcon }> = {
  home: { label: 'Home', icon: House },
  security: { label: 'Security', icon: Shield },
};

/** Height the floating iOS bar takes from the bottom of a tab screen, so the last content can scroll clear of it. */
export const FLOATING_TAB_BAR_SPACE = 104;

/**
 * Bottom navigation in each platform's design: on iOS a floating, translucent pill over the content (as iOS 26 tab bars
 * float), on Android a Material 3 navigation bar with the active pill behind the icon.
 */
/** iOS "Reduce Transparency": when it is on, nothing on screen is see-through. */
function useReduceTransparency(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!IS_IOS || IS_WEB) return;
    let alive = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((v) => alive && setOn(v));
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

export function TabBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const reduceTransparency = useReduceTransparency();
  const bottom = IS_WEB ? (IS_IOS ? 30 : 16) : IS_IOS ? Math.max(insets.bottom - 4, 8) : Math.max(insets.bottom, 16);

  const tabs = state.routes.map((route, index) => {
    const tab = TABS[route.name];
    if (!tab) return null;
    const focused = state.index === index;

    const onPress = () => {
      const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigateToTab(route.key);
    };

    if (IS_IOS) {
      return (
        <Pressable
          key={route.key}
          role="tab"
          aria-selected={focused}
          accessibilityLabel={tab.label}
          onPress={onPress}
          className={cn('min-h-[52px] flex-1 items-center justify-center gap-px rounded-full', focused && 'bg-foreground/10')}>
          <Icon as={tab.icon} size={24} strokeWidth={1.8} className={focused ? 'text-foreground' : 'text-muted-foreground'} />
          <Text className={cn('text-[10px] leading-3', focused ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium')}>{tab.label}</Text>
        </Pressable>
      );
    }

    return (
      <Pressable
        key={route.key}
        role="tab"
        aria-selected={focused}
        accessibilityLabel={tab.label}
        onPress={onPress}
        className="min-h-[52px] flex-1 items-center gap-1">
        <View className={cn('h-8 w-16 items-center justify-center rounded-2xl', focused && 'bg-accent')}>
          <Icon as={tab.icon} size={24} strokeWidth={1.8} className={focused ? 'text-accent-foreground' : 'text-muted-foreground'} />
        </View>
        <Text className={cn('text-xs font-medium', focused ? 'text-foreground' : 'text-muted-foreground')}>{tab.label}</Text>
      </Pressable>
    );
  });

  if (IS_IOS) {
    // On an iPhone the system blur shows through (unless Reduce Transparency is on: then the bar is solid). The web
    // preview draws the same with CSS.
    const blur = !IS_WEB && !reduceTransparency;
    return (
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 items-center" style={{ paddingBottom: bottom - 6 }}>
        <View
          className="rounded-full"
          style={{ shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 6 }}>
          <View
            role="tablist"
            accessibilityLabel="Main"
            className={cn(
              'border-foreground/10 w-[200px] flex-row gap-1 overflow-hidden rounded-full border p-1',
              blur ? 'bg-background/40' : reduceTransparency ? 'bg-background' : 'bg-background/80'
            )}
            style={IS_WEB ? ({ backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' } as object) : undefined}>
            {blur ? <BlurView tint="systemChromeMaterial" intensity={80} style={StyleSheet.absoluteFill} /> : null}
            {tabs}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      role="tablist"
      accessibilityLabel="Main"
      className="bg-background border-border flex-row border-t"
      style={{ paddingTop: 12, paddingHorizontal: 8, paddingBottom: bottom }}>
      {tabs}
    </View>
  );
}
