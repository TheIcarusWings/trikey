import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'trikey-guardian',
  title: 'Trikey Guardian',
  license: 'MIT',
  packageRepo: 'https://github.com/TheIcarusWings/trikey',
  upstreamRepo: 'https://github.com/TheIcarusWings/trikey',
  marketingUrl: 'https://github.com/TheIcarusWings/trikey',
  donationUrl: null,
  description: { short, long },
  // main:     the guardian's state, mounted at /data. Key 3's encrypted keystore is in it.
  // startos:  StartOS-side state (the web interface password), never mounted into the container.
  volumes: ['main', 'startos'],
  images: {
    // The image built and published by .github/workflows/docker.yml, reproducible per
    // packaging/VERIFY.md. Keep this tag equal to the version in startos/versions/current.ts.
    guardian: {
      source: { dockerTag: 'ghcr.io/theicaruswings/trikey-guardian:0.1.0' },
      arch: ['x86_64', 'aarch64'],
      emulateMissing: false,
    },
  },
})
