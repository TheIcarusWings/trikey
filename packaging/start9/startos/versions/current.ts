import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.25:0',
  releaseNotes: {
    en_US:
      'Fixes from a third security review: the guardian refuses to co-sign while its clock is behind the chain, family hosting keeps a guest\'s coins in view until they are really spent, and Savings alerts can no longer be crowded out. Update the app too.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
