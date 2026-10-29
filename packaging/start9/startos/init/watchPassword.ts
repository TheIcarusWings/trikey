import { setWebPassword } from '../actions/setWebPassword'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

// The guardian has no login of its own (apps/guardian/README.md, "Do not expose it"): anyone who
// can reach its port can lock it, create pairing codes and read its activity log. StartOS does not
// authenticate a bound port, so the interface carries a basic-auth gate (interfaces.ts), and this
// handler asks the user for the password until one exists. Reading it with .const() reruns the
// handler if the file is changed or restored without a password.
export const watchPassword = sdk.setupOnInit(async (effects) => {
  const uiPassword = await storeJson.read((s) => s.uiPassword).const(effects)
  if (!uiPassword) {
    await sdk.action.createOwnTask(effects, setWebPassword, 'critical', {
      reason: i18n(
        'Trikey Guardian has no login of its own, so StartOS must protect its web interface with a password.',
      ),
    })
  }
})
