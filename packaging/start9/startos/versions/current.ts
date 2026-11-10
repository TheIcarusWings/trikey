import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.26:0',
  releaseNotes: {
    en_US:
      'The guardian now finishes what it started before it stops: an alert still being sent to your contacts during an update or restart is no longer cut short. Update the app too.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
