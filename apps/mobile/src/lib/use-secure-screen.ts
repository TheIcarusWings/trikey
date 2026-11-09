import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { setScreenSecure } from '@/platform/secure-screen';

/**
 * For a screen that shows a secret (the backup's recovery code; security review 2026-11, sweep 2, finding 34): while it
 * is mounted the app is kept out of screenshots, recordings and the recents thumbnail where the phone can (Android,
 * FLAG_SECURE), and it returns `hidden` while the app is not in front, so the screen can cover the secret before iOS
 * takes the app switcher's picture.
 */
export function useSecureScreen(): { hidden: boolean } {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setScreenSecure(true);
    const sub = AppState.addEventListener('change', (s) => setHidden(s !== 'active'));
    return () => {
      sub.remove();
      setScreenSecure(false);
    };
  }, []);
  return { hidden };
}
