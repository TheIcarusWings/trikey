import type { AndroidVariant } from './android-variant';

/**
 * The app's name in Settings > About. The two Android builds are two apps with the same icon; the launcher says
 * "Trikey" or "Trikey FOSS" (android-variant.js), and this line says it in words.
 */
export function appDisplayName(os: string, variant: AndroidVariant): string {
  return os === 'android' && variant === 'foss' ? 'Trikey (no Google)' : 'Trikey';
}
