/**
 * Feature flags, fixed at build time (`VITE_FEATURE_*=true npm run build`). A flag that is off removes
 * the page's route and navigation entry, so nothing is reachable by URL either.
 */
export const features = {
  /**
   * "Host for someone": run a guardian for a family member's wallet. The guardian engine holds one
   * wallet today (`GET /api/hosting` answers empty and the invite endpoints `501 not_available`),
   * so the page stays hidden until the API supports it. The code is kept in `pages/host.tsx`.
   */
  hostForSomeone: import.meta.env.VITE_FEATURE_HOST_FOR_SOMEONE === 'true',
} as const;
