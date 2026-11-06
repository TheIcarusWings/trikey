import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.19:0',
  releaseNotes: {
    en_US:
      'No guardian changes: this release fixes the 0.1.18 iPhone app, which closed itself right after opening, and adds Jade over Bluetooth in the app.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
