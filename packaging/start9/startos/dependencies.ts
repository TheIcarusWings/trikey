import { i18n } from './i18n'
import { sdk } from './sdk'

// Package ids, health check ids and version ranges follow the packages that already depend on
// these two: electrs-startos (bitcoind) and mempool-startos (bitcoind, electrs).
//
// Declaring a dependency does not stop StartOS from starting the guardian before they run. main.ts
// waits for both addresses instead and reports why it is waiting.

const bitcoind = sdk.Dependency.required('bitcoind', {
  description: i18n(
    'Chain data, the broadcast fallback and the silent payment scanner',
  ),
  metadata: {
    // Named generically: this covers Bitcoin Core and Bitcoin Knots.
    title: 'Bitcoin',
    icon: 'https://raw.githubusercontent.com/Start9Labs/bitcoin-core-startos/refs/heads/30.x/dep-icon.svg',
  },
  // Silent payment scanning reads `getblock <hash> 3` (prevouts), which needs Bitcoin Core 25 or
  // later. TODO(verify): the lowest "<version>:<revision>" the Start9 registry publishes in this
  // range; ">=28.4:0" is the version of the oldest release that mempool-startos accepts.
  versionRange: '>=28.4:0',
  kind: 'running',
  healthChecks: ['bitcoind', 'sync-progress'],
})

const electrs = sdk.Dependency.required('electrs', {
  description: i18n('Address and transaction lookups'),
  metadata: {
    title: 'Electrs',
    icon: 'https://raw.githubusercontent.com/Start9Labs/electrs-startos/refs/heads/master/icon.svg',
  },
  versionRange: '>=0.11.1:0',
  kind: 'running',
  healthChecks: ['electrs', 'sync'],
})

export const dependencies = sdk.Dependencies.of()
  .addDependency(bitcoind)
  .addDependency(electrs)
