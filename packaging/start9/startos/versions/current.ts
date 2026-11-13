import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.29:0',
  releaseNotes: {
    en_US:
      'Nothing changes in the guardian: this release fixes the app (Trezor on iPhone, Replace guardian after a reset, recovery codes and removing a wallet). Update the app.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
