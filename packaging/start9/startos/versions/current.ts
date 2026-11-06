import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.18:0',
  releaseNotes: {
    en_US:
      'With the 0.1.18 app, more hardware wallets can set up a guardian wallet: a Coldcard Mk4 or Q over NFC, and Passport (2nd generation) and Krux from their microSD card. The Telegram settings now say what to do after you save the bot. A new Support page shows the donation address.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
