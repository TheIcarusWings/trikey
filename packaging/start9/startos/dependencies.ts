import { i18n } from './i18n'
import { sdk } from './sdk'

// Package ids, health check ids and version ranges follow the packages that already depend on
// these two: electrs-startos (bitcoind) and mempool-startos (bitcoind, electrs).
//
// Declaring a dependency does not stop StartOS from starting the guardian before they run. main.ts
// waits for both addresses instead and reports why it is waiting.

const bitcoind = sdk.Dependency.required('bitcoind', {
  description: i18n(
    'Chain data, the mempool, the broadcast fallback and the silent payment scanner',
  ),
  metadata: {
    // Named generically: this covers Bitcoin Core and Bitcoin Knots.
    title: 'Bitcoin',
    icon: 'https://raw.githubusercontent.com/Start9Labs/bitcoin-core-startos/refs/heads/30.x/dep-icon.svg',
  },
  // The range mempool-startos requires: the bitcoind (and Bitcoin Knots, flavor `knotsprerdts`)
  // revisions of each major line built for StartOS 0.4, which serve the RPC cookie at `/.cookie`
  // on the `main` volume and btc-rpc-proxy on host `rpc`, port 8332, the way main.ts reads them.
  // Silent payment scanning reads `getblock <hash> 3` (prevouts), which needs Bitcoin Core 25+.
  versionRange:
    '(>=28.4:29 && <29) || (>=29.4:16 && <30) || (>=30.3:16 && <31) || >=31.1:16 || >=#knotsprerdts:29.3:29',
  kind: 'running',
  healthChecks: ['bitcoind', 'sync-progress'],
})

const electrs = sdk.Dependency.required('electrs', {
  description: i18n('Address and transaction lookups'),
  metadata: {
    title: 'Electrs',
    icon: 'https://raw.githubusercontent.com/Start9Labs/electrs-startos/refs/heads/master/icon.svg',
  },
  // mempool-startos' range for electrs: its StartOS 0.4 revisions, Electrum on host `electrum`,
  // port 50001.
  versionRange: '>=0.11.1:11',
  kind: 'running',
  healthChecks: ['electrs', 'sync'],
})

export const dependencies = sdk.Dependencies.of()
  .addDependency(bitcoind)
  .addDependency(electrs)
