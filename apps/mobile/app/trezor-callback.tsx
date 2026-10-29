import { useRouter } from 'expo-router';
import { useEffect } from 'react';

/**
 * Trezor Suite Lite opens `<scheme>://trezor-callback?id=...&response=...` when it is done. The Trezor provider
 * (src/hardware/trezor) listens for that URL and hands it to Trezor Connect, which resolves the request that is waiting.
 * The router still sees the URL as a navigation, so this route exists only to get out of the way: it shows nothing and
 * goes straight back to the screen the user came from.
 */
export default function TrezorCallback() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);
  return null;
}
