import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { House, Shield } from '@/components/icons';
import { FadeLayer, spring, useReduceMotion } from '@/components/motion';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { IS_IOS, IS_WEB } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { STANDARD } from '@/theme/motion';

const TABS: Record<string, { label: string; icon: LucideIcon }> = {
  home: { label: 'Home', icon: House },
  security: { label: 'Security', icon: Shield },
};

/** Height the floating iOS bar takes from the bottom of a tab screen, so the last content can scroll clear of it. */
export const FLOATING_TAB_BAR_SPACE = 104;

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

/**
 * Bottom navigation in each platform's design: on iOS a floating, translucent pill over the content (as iOS 26 tab bars
 * float), on Android a Material 3 navigation bar with the active pill behind the icon.
 */
export function TabBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const reduceTransparency = useReduceTransparency();
  // Where each iOS tab is in the bar, for the pill to slide to.
  const [tabX, setTabXs] = useState<({ x: number; width: number } | undefined)[]>([]);
  const setTabX = (index: number, x: number, width: number) =>
    setTabXs((all) => (all[index]?.x === x && all[index]?.width === width ? all : Object.assign([...all], { [index]: { x, width } })));
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
      // The selected tab's pill is drawn once, behind the tabs, and slides to the tab chosen (`TabPill`).
      return (
        <Pressable
          key={route.key}
          role="tab"
          aria-selected={focused}
          accessibilityLabel={tab.label}
          onPress={onPress}
          onLayout={(e) => setTabX(index, e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
          className="min-h-[52px] flex-1 items-center justify-center gap-px rounded-full">
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
        <View className="h-8 w-16 items-center justify-center">
          {/* Material 3's indicator stays with its tab; it fades in when the tab is chosen. */}
          <FadeLayer shown={focused} ms={STANDARD.duration} style={StyleSheet.absoluteFill}>
            <View className="bg-accent size-full rounded-2xl" />
          </FadeLayer>
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
            <TabPill at={tabX[state.index]} />
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

/**
 * The iOS bar's selected-tab pill: one pill that slides to the chosen tab with the firm spring (no bounce) while the
 * screens crossfade. It is placed without sliding the first time, and with Reduce Motion it moves at once (the chosen
 * tab's label also turns bold).
 */
function TabPill({ at }: { at?: { x: number; width: number } }) {
  const reduced = useReduceMotion();
  // Where the pill sits at translateX 0, measured once: the offset to a tab's x is the difference.
  const [origin, setOrigin] = useState<number | undefined>(undefined);
  const x = useSharedValue(0);
  const placed = useRef(false);
  const target = at && origin !== undefined ? at.x - origin : undefined;
  useEffect(() => {
    if (target === undefined) return;
    if (!placed.current || reduced) {
      placed.current = true;
      x.value = target;
      return;
    }
    x.value = spring(target, 'firm');
  }, [target, reduced, x]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  if (!at) return null;
  return (
    <Animated.View
      onLayout={(e) => setOrigin(e.nativeEvent.layout.x)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, top: 4, bottom: 4, width: at.width, opacity: target === undefined ? 0 : 1 }, slide]}>
      <View className="bg-foreground/10 size-full rounded-full" />
    </Animated.View>
  );
}
