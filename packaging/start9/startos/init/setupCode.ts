import { randomBytes } from 'node:crypto'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 16 characters of Crockford base32 from 10 random bytes (80 bits), as the guardian makes its own (http/setup-code.ts). */
export const newSetupCode = (bytes: Uint8Array = randomBytes(10)): string => {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return out
}

/** `ABCDEFGHJKMNPQRS` as the guardian prints it: `ABCD-EFGH-JKMN-PQRS`. */
export const formatSetupCode = (code: string) => code.match(/.{4}/g)!.join('-')

// TRIKEY_SETUP_CODE (apps/guardian/src/config.ts). The guardian asks for a setup code on every platform until it is set
// up: StartOS's basic-auth gate covers only the TLS interface, and another service on this server can reach the
// guardian's plaintext port without it (security review 2026-11, finding 3). Drawn once here, from the package
// runtime's CSPRNG, kept in store.json on the `startos` volume (which the guardian's container never mounts), passed
// by main.ts, and shown to the owner by the show-setup-code action and with the web password, in StartOS's own UI.
export const seedSetupCode = sdk.setupOnInit(async (effects) => {
  const current = await storeJson.read((s) => s.setupCode).once()
  if (current) return
  await storeJson.merge(effects, { setupCode: newSetupCode() })
})
