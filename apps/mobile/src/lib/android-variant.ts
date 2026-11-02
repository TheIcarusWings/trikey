// Which Android build this JavaScript bundle belongs to (android-variant.js at the app's root explains the two). This
// file is the standard build's and every other bundle's (iOS, web, tests); the bundle of the Android build without
// Google code takes android-variant.android.foss.ts in its place (metro.config.js), so the answer always matches the
// code that is actually running.

export type AndroidVariant = 'standard' | 'foss';

export const ANDROID_VARIANT: AndroidVariant = 'standard';
