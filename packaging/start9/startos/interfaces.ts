import { storeJson } from './fileModels/store.json'
import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

// The guardian's web interface is its only listener. It has no authentication of its own, so the
// StartOS proxy gates every request with HTTP basic auth (proxy.auth). The password comes from
// store.json and is set by the set-web-password action. Until it exists nothing is bound, so the
// port cannot be reached; the critical task from init/watchPassword.ts asks for it.
export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const password = await storeJson.read((s) => s.uiPassword).const(effects)
  if (!password) return []

  const uiMulti = sdk.MultiHost.of(effects, 'ui-multi')
  const uiMultiOrigin = await uiMulti.bindPort(uiPort, {
    // 'http' keeps the plaintext port on the server itself and the internal bridge. Anything
    // off the server reaches the guardian through the TLS leg StartOS adds, and that leg
    // is where the auth gate sits (SDK 3.1: AddSslOptions.auth).
    protocol: 'http',
    addSsl: {
      auth: {
        type: 'basic',
        credentials: [{ username: 'admin', password }],
        realm: null,
      },
    },
  })

  const ui = sdk.createInterface(effects, {
    name: i18n('Web UI'),
    id: 'ui',
    description: i18n(
      'The Trikey Guardian web interface: set up, pair your phone, unlock and lock key 3',
    ),
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })

  const uiReceipt = await uiMultiOrigin.export([ui])

  return [uiReceipt]
})
