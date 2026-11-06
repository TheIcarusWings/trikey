import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { formatSetupCode } from '../init/setupCode'
import { sdk } from '../sdk'

// The guardian's first-run setup code (init/setupCode.ts), read in StartOS's UI: the one place only the server's owner
// reaches. The guardian asks for it until it is set up; afterwards it opens nothing.
export const showSetupCode = sdk.Action.withoutInput(
  'show-setup-code',

  async () => ({
    name: i18n('Show Setup Code'),
    description: i18n(
      'Show the one-time code the guardian asks for when you set it up.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const code = await storeJson.read((s) => s.setupCode).const(effects)
    return {
      version: '1',
      title: i18n('Setup Code'),
      message: i18n(
        "Enter this code on the guardian's first-run screen. It is needed only until the guardian is set up.",
      ),
      result: {
        type: 'single',
        value: code ? formatSetupCode(code) : '',
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)
