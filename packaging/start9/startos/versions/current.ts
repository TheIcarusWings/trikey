import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.30:0',
  releaseNotes: {
    en_US:
      'Nothing changes in the guardian: this release changes the app (a Trezor\'s address or payment shown before Trezor Suite opens, and a protected Copy for the recovery code). Update the app.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
