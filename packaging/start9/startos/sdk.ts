// SDK instance bound to this package's manifest.
//
// TODO(verify): StartSdk.of().withManifest(...).build(true) is the pattern shown by a
// third-party mirror of @start9labs/start-sdk. Confirm it against the current SDK.
import { StartSdk } from '@start9labs/start-sdk'
import { manifest } from './manifest'

export const sdk = StartSdk.of().withManifest(manifest).build(true)
