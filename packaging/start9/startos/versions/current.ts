import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.14:0',
  releaseNotes: {
    en_US:
      'Fixes for Umbrels where Electrs cannot see the mempool of Bitcoin Core 32: the guardian reads unconfirmed payments from Core itself and warns on its page; the app never reuses coins of its own unconfirmed payments. New Wallet page (view and receive). Quicker pull to refresh.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
