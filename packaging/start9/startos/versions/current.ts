import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.8:0',
  releaseNotes: {
    en_US: 'Alerts by email, ntfy and webhook; alert contacts can lock the guardian (opt-in); the guardian watches an optional Savings wallet.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
