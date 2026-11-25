import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.32:0',
  releaseNotes: {
    en_US:
      'Nothing changes in the guardian: this release changes the app (only tested features in the app, and updates checked against Trikey\'s signature). Update the app.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
