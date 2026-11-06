import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.20:0',
  releaseNotes: {
    en_US:
      'Change the guardian passphrase from its web page (Settings, Passphrase): the old one stops working everywhere, other browsers are signed out, and you are alerted. With the 0.1.20 app, a BitBox02 can be your hardware wallet.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
