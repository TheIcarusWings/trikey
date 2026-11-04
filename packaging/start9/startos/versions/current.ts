import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.12:0',
  releaseNotes: {
    en_US: 'Payments show up on your phone the moment they reach the mempool, from any device, and again when they confirm; syncs are much faster. Optional payment notices on your own email, ntfy or webhook. A payment waiting to confirm can be sped up. Host a guardian for family: invite people you know, whose addresses and balances you never see.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
