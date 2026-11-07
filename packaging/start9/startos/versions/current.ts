import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.23:0',
  releaseNotes: {
    en_US:
      'Security release, from a second review. Your hardware wallet now shows your alert contacts by name, adding a wallet needs your first wallet\'s hardware wallet, a stolen phone can no longer freeze a recovery with unsent payments, and turning hardware unlock off and on replaces it. A stranger who reaches the guardian\'s page can no longer keep you waiting to unlock. Update the app too.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
