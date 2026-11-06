import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.21:0',
  releaseNotes: {
    en_US:
      'Security release, from an external review. Your hardware wallet now approves the rules a new wallet starts with (update the app too). Notification secrets stay with their server, a new guardian asks for its setup code (Actions > Show Setup Code), Savings thefts cannot be hidden behind many small payments, and a quoted CANCEL no longer cancels a recovery.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
