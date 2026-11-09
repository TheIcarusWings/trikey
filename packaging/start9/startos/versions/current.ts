import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.24:0',
  releaseNotes: {
    en_US:
      'The last, low-severity fixes from the second security review, and every dependency advisory fixed. Your own phone no longer counts as your alert contact on mainnet (add a contact in the app if it asks), a chain server is judged by its address rather than its label, and the guardian image keeps no code cache in /tmp. Update the app too.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
