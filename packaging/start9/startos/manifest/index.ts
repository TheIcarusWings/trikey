// Service manifest for Trikey Guardian.
//
// TODO(verify): this follows the shape of the StartOS 0.4 TypeScript SDK as far as it
// could be determined without docs.start9.com (unreachable from the packaging session).
// Check every field name, the version format, the image build source and the dependency
// package ids against the current `@start9labs/start-sdk` before building an s9pk.
import { setupManifest } from '@start9labs/start-sdk'

export const manifest = setupManifest({
  id: 'trikey-guardian',
  title: 'Trikey Guardian',
  // TODO(verify): 0.4 version string format (semver, or semver with a revision suffix).
  version: '0.1.0',
  releaseNotes: 'First release.',
  license: 'MIT',
  wrapperRepo: 'https://github.com/TheIcarusWings/trikey',
  upstreamRepo: 'https://github.com/TheIcarusWings/trikey',
  supportSite: 'https://github.com/TheIcarusWings/trikey/issues',
  marketingSite: 'https://github.com/TheIcarusWings/trikey',
  donationUrl: null,
  description: {
    short: 'Key 3 of a 2-of-3 bitcoin wallet, on your own server',
    long:
      'Trikey Guardian co-signs phone payments under a daily limit you set, and runs a ' +
      'Delay & Notify recovery if you lose your phone. It uses your own Bitcoin node and ' +
      'Electrs, opens no inbound ports, and holds its key only in memory while unlocked.',
  },
  assets: {
    // TODO(verify): these asset files do not exist yet. Add icon.png, LICENSE.md and instructions.md.
    icon: 'icon.png',
    license: 'LICENSE.md',
    instructions: 'instructions.md',
  },
  // The single persistent volume. It is mounted at /data (see main.ts).
  volumes: ['main'],
  images: {
    // TODO(verify): how 0.4 builds an image from a Dockerfile in a sibling directory.
    // The build context must be the repository root, and the Dockerfile is
    // packaging/docker/Dockerfile.
    main: {
      source: {
        dockerBuild: {
          dockerfile: '../docker/Dockerfile',
          workdir: '../..',
        },
      },
    },
  },
  dependencies: {
    // TODO(verify): package ids for the StartOS Bitcoin Core and Electrs packages.
    bitcoind: {
      description: 'Bitcoin Core node for chain data and broadcasting',
      optional: false,
      metadata: { title: 'Bitcoin Core', icon: '', description: 'Bitcoin full node' },
    },
    electrs: {
      description: 'Electrum server (Electrs) for wallet and address queries',
      optional: false,
      metadata: { title: 'Electrs', icon: '', description: 'Electrum server' },
    },
  },
})
