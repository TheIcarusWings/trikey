import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.10:0',
  releaseNotes: {
    en_US: 'Fix: the app no longer freezes when it opens; the app and the guardian skip relay messages they already read, and answers expire from the relays after about an hour.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
