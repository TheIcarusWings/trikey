import type { AndroidVariant } from './android-variant';

/**
 * The app's name in Settings > About. The two Android builds have the same package and icon (one installs over the
 * other), so this line is how a person tells which one is on the phone.
 */
export function appDisplayName(os: string, variant: AndroidVariant): string {
  return os === 'android' && variant === 'foss' ? 'Trikey (no Google)' : 'Trikey';
}
