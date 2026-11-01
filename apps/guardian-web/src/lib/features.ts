/**
 * Feature switches of the web UI. "Host for someone" used to sit behind a build flag (`VITE_FEATURE_HOST_FOR_SOMEONE`)
 * while the guardian held one wallet; the guardian now says whether it hosts wallets (`GET /api/hosting`,
 * `available`), so the page and its navigation entry follow that instead (docs/design/family-hosting.md).
 */
export const features = {} as const;
