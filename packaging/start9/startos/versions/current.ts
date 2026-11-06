import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.17:0',
  releaseNotes: {
    en_US:
      'Unlock the guardian with your hardware wallet after a restart (opt-in, from the 0.1.17 app); the passphrase keeps working. Unlocks from the phone are sealed to a key the guardian keeps only in memory. QR hardware wallets (Coldcard Q, Jade, Keystone 3, Passport Prime, Specter DIY) can now set up a guardian wallet.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
