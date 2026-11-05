import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.16:0',
  releaseNotes: {
    en_US:
      'Notes that survive recovery: with the 0.1.16 app, an encrypted copy of your labels can be kept on the guardian, which stores it without being able to read it. The app now checks every Speed up against the original payment before signing.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
