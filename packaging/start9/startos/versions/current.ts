import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.11:0',
  releaseNotes: {
    en_US: 'The guardian sends out a payment it has just co-signed, or one spending a coin it already knows, without reading the whole wallet again, so payments show in seconds; with the 0.1.11 app, no more "Guardian offline" after the phone slept, and mainnet fees never below 1 sat/vB.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
