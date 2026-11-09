import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * A screen that has no business being open (Settings > Wallets with "Several wallets" off, reached by a link or after
 * the last other wallet went): back to Settings, closing the screens above it, or Settings in its place when it is not
 * in the history (a link from outside the app). Only once the screen is in front: a screen further down the stack
 * re-renders too, and must leave the one on top to finish (Remove goes back by itself).
 */
export function BackToSettings() {
  const router = useRouter();
  useFocusEffect(
    useCallback(() => {
      router.dismissTo('/settings');
    }, [router]),
  );
  return null;
}
