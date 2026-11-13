/**
 * Deep links before expo-router navigates. Trezor Suite Lite answers each request by opening
 * `<scheme>://trezor-callback?...`; the Trezor provider (src/hardware/trezor) takes that URL from `Linking` itself, so the
 * router has nothing to show for it. Returning null here skips the navigation: no route pushed and popped while the app
 * is in the background (a cold start goes home; app/trezor-callback.tsx stays as the fallback). Every other link goes on
 * as it came.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  if (path.split('?')[0]!.includes('trezor-callback')) return initial ? '/' : null;
  return path;
}
