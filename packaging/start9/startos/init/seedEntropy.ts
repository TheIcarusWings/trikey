import { randomBytes } from 'node:crypto'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

// TRIKEY_EXTRA_ENTROPY (apps/guardian/src/config.ts). Umbrel passes the app's APP_SEED, which
// umbrelOS derives from the Umbrel's own seed. StartOS has no per-service seed, so the package
// draws 32 bytes here, once, from the package runtime's CSPRNG (another process, at install
// time, not the guardian's own draw at setup), and keeps them in store.json on the `startos`
// volume, which the guardian's container never mounts. main.ts passes them as the variable. The
// guardian only ever mixes them in (HMAC keyed by its own OS draw), so they can only add to a
// new setup seed, never weaken it, and a guardian that is set up already is unchanged.
export const seedEntropy = sdk.setupOnInit(async (effects) => {
  const current = await storeJson.read((s) => s.extraEntropy).once()
  if (current) return
  await storeJson.merge(effects, {
    extraEntropy: randomBytes(32).toString('hex'),
  })
})
