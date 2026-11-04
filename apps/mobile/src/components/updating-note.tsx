import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';
import { useTheme } from '@/theme/use-theme';

/** The background part of a sync shows only once it takes longer than this, so a quick one does not flicker. (ms) */
const SHOW_AFTER_MS = 600;

/**
 * "Updating…", small and quiet at the top of a screen that can be pulled to refresh, while the background part of a
 * sync runs (`WalletState.updating`: silent payments, Savings, the recovery followed). The balance and Activity are
 * already up to date by then, and the pull-to-refresh spinner is gone. Floats over the content (nothing moves) and
 * takes no touches.
 */
export function UpdatingNote() {
  const { updating } = useWallet();
  const { colors } = useTheme();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!updating) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [updating]);
  if (!updating || !shown) return null;
  return (
    <View pointerEvents="none" className="absolute right-0 left-0 top-1 items-center" testID="updating-note">
      <View
        accessible
        accessibilityLabel="Updating"
        accessibilityLiveRegion="polite"
        className="bg-background/90 flex-row items-center gap-1.5 rounded-full px-3 py-1">
        <ActivityIndicator size="small" color={colors.muted} style={{ transform: [{ scale: 0.7 }] }} />
        <Text className="text-muted-foreground text-xs leading-4">Updating…</Text>
      </View>
    </View>
  );
}
