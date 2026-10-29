import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// StartOS-side state, kept on the `startos` volume, which is never mounted into the guardian's
// container. The guardian itself keeps its state (and key 3) in the `main` volume at /data.
//
// uiPassword is the password of the HTTP basic-auth gate that StartOS puts in front of the web
// interface (see interfaces.ts). It is stored in the clear because the StartOS proxy needs the
// clear text to enforce basic auth, and it is not a key: it cannot unlock or spend anything. The
// guardian's own unlock passphrase is separate, is chosen by the user in the web interface, and
// is never stored here.
const shape = z.looseObject({
  uiPassword: z.string().optional().catch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.startos, subpath: '/store.json' },
  shape,
)
