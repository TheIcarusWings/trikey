import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.28:0',
  releaseNotes: {
    en_US:
      'Nothing changes in the guardian. Releases are now signed by the founder\'s own nostr key (Icarus Wings) instead of the Trikey account, and the Android app can be rebuilt byte for byte.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
