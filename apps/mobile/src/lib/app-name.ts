import type { AndroidVariant } from './android-variant';
import type { BuildChannel } from './build-channel';

/**
 * The app's name in Settings > About. The two Android builds are two apps with the same icon; the launcher says
 * "Trikey" or "Trikey FOSS" (android-variant.js), and this line says it in words.
 */
export function appDisplayName(os: string, variant: AndroidVariant, channel: BuildChannel = 'release'): string {
  const name = os === 'android' && variant === 'foss' ? 'Trikey (no Google)' : 'Trikey';
  // A test build is its own app on Android, "Trikey Test" (android-variant.js).
  return channel === 'test' ? `${name} Test` : name;
}
