import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  // <upstream version>:<StartOS wrapper revision>. The upstream version is the Trikey
  // release, and it equals the image tag in manifest/index.ts.
  version: '0.1.27:0',
  releaseNotes: {
    en_US:
      'The guardian\'s web page is easier to use: larger click targets, field borders and focus outlines you can see, and plainer words. Releases are now signed with Trikey\'s key. Update the app too: it has a new Security tab and motion throughout.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
