import { Tabs } from 'expo-router/js-tabs';
import { Easing } from 'react-native';
import { TabBar } from '@/components/tab-bar';
import { CROSSFADE_MS } from '@/theme/motion';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      // Switching tabs: the screens crossfade (160ms, opacity only) while the bar's pill slides (docs/design/motion.md, section 7).
      screenOptions={{ headerShown: false, animation: 'fade', transitionSpec: { animation: 'timing', config: { duration: CROSSFADE_MS, easing: Easing.linear } } }}>
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="security" options={{ title: 'Security' }} />
    </Tabs>
  );
}
