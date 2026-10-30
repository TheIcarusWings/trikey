/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` or `http`. Defaults to mock in dev and http in production builds. */
  readonly VITE_API?: 'mock' | 'http';
  /** Prefix for API requests when the UI is not served by the guardian. */
  readonly VITE_API_BASE?: string;
  /** `true` shows "Host for someone" (page and navigation entry). Off until the API supports hosting. */
  readonly VITE_FEATURE_HOST_FOR_SOMEONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
