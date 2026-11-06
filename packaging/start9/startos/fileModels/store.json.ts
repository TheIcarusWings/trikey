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
//
// extraEntropy is 32 random bytes (64 hex characters) drawn once by the package at install
// (init/seedEntropy.ts) and passed to the guardian as TRIKEY_EXTRA_ENTROPY, the Start9 stand-in
// for Umbrel's APP_SEED. The guardian mixes it into every new key-3 setup seed next to its own
// OS draw and the browser's bytes (DESIGN.md, "Entropy"). It is not a key: knowing it does not
// weaken the seed, which stays as strong as the guardian's own draw.
//
// setupCode is the guardian's first-run setup code (TRIKEY_SETUP_CODE): 16 characters of Crockford base32 (80 bits)
// drawn once at install (init/setupCode.ts), shown to the owner by the show-setup-code action (and with the web
// password), and asked for by the guardian until it is set up. The basic-auth gate covers only the TLS interface:
// another service on the same server reaches the guardian's plaintext port directly and could otherwise run setup
// first (security review 2026-11, finding 3). Useless once the guardian is set up.
const shape = z.looseObject({
  uiPassword: z.string().optional().catch(undefined),
  extraEntropy: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .catch(undefined),
  setupCode: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{16}$/)
    .optional()
    .catch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.startos, subpath: '/store.json' },
  shape,
)
