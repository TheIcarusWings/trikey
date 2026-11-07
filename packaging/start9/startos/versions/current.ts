import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.22:0',
  releaseNotes: {
    en_US:
      'Security release, from a second review. Your hardware wallet now shows your alert contacts by name, adding a wallet needs your first wallet\'s hardware wallet, and a stolen phone can no longer freeze a recovery with unsent payments. The guardian page\'s sign-in is tied to its own tab. Update the app too.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
