import { utils } from '@start9labs/start-sdk'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { formatSetupCode } from '../init/setupCode'
import { sdk } from '../sdk'

// Sets, and later rotates, the password of the basic-auth gate on the web interface. The first
// run is requested by a critical task (init/watchPassword.ts), so the guardian never starts
// with its web interface open to the local network.
export const setWebPassword = sdk.Action.withoutInput(
  'set-web-password',

  async ({ effects }) => ({
    name: i18n('Set Web UI Password'),
    description: i18n(
      'Generate a new random password for the web interface. Replaces any existing password.',
    ),
    warning: (await storeJson.read((s) => s.uiPassword).const(effects))
      ? i18n(
          'Replaces the current web interface password. Browsers that saved it will need the new one.',
        )
      : null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const uiPassword = utils.getDefaultString({
      charset: 'a-z,A-Z,0-9',
      len: 32,
    })
    await storeJson.merge(effects, { uiPassword })
    // The first-run setup code, shown here too: this is the dialog the owner sees right before opening the web UI.
    const setupCode = await storeJson.read((s) => s.setupCode).once()

    return {
      version: '1',
      title: i18n('Web UI Credentials'),
      message: i18n(
        'Sign in to the web interface with these credentials. The password is shown only now.',
      ),
      result: {
        type: 'group',
        value: [
          {
            type: 'single',
            name: i18n('Username'),
            description: null,
            value: 'admin',
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          {
            type: 'single',
            name: i18n('Password'),
            description: null,
            value: uiPassword,
            masked: true,
            copyable: true,
            qr: false,
            launchable: false,
          },
          ...(setupCode
            ? [
                {
                  type: 'single' as const,
                  name: i18n('Setup code (first run only)'),
                  description: i18n(
                    "Enter this code on the guardian's first-run screen. It is needed only until the guardian is set up.",
                  ),
                  value: formatSetupCode(setupCode),
                  masked: false,
                  copyable: true,
                  qr: false,
                  launchable: false,
                },
              ]
            : []),
        ],
      },
    }
  },
)
