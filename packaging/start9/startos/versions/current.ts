import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.9:0',
  releaseNotes: {
    en_US: 'The guardian keeps listening after a relay restarts or a connection drops; relay.trikey.app is offered at setup; Savings payments can be sped up.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
