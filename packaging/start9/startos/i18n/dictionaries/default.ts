export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting Trikey Guardian': 0,
  'Web Interface': 1,
  'The web interface is ready': 2,
  'The web interface is not ready': 3,
  'Bitcoin Core': 4,
  'Bitcoin Core is not installed, or has not published its RPC address and credentials yet': 5,
  Electrs: 6,
  'Electrs is not installed, or has not published its Electrum address yet': 7,

  // interfaces.ts
  'Web UI': 8,
  'The Trikey Guardian web interface: set up, pair your phone, unlock and lock key 3': 9,

  // dependencies.ts
  'Chain data, the broadcast fallback and the silent payment scanner': 10,
  'Address and transaction lookups': 11,

  // actions/setWebPassword.ts, init/watchPassword.ts
  'Set Web UI Password': 12,
  'Generate a new random password for the web interface. Replaces any existing password.': 13,
  'Replaces the current web interface password. Browsers that saved it will need the new one.': 14,
  'Web UI Credentials': 15,
  'Sign in to the web interface with these credentials. The password is shown only now.': 16,
  Username: 17,
  Password: 18,
  'Trikey Guardian has no login of its own, so StartOS must protect its web interface with a password.': 19,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
