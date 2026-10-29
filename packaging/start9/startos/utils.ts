import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'

/** The port the guardian's HTTP server listens on in the container (env PORT). */
export const uiPort = 3000

/** The guardian's state directory in the container, and the `main` volume mounted on it. */
export const dataDir = '/data'

/** The uid and gid of the `node` user in the image, which runs the guardian. */
export const guardianUid = 1000

/** Where the bitcoind volume (and so its RPC .cookie) is mounted in the guardian's container. */
export const btcMountpoint = '/mnt/bitcoind'

// The two ports below are not discovered, they are the contract that the Start9 packages for
// Bitcoin Core and Electrs publish. They are copied here, not imported, so that this package
// needs no dependency on either package's repository. Sources:
//   bitcoin-core-startos  startos/utils.ts   rpcHostId = 'rpc', rpcPort = 8332 (btc-rpc-proxy)
//   electrs-startos       startos/utils.ts   electrumHostId = 'electrum', port = 50001
// StartOS Bitcoin Core runs on mainnet only, so BITCOIN_NETWORK is fixed (see main.ts).
const bitcoindRpcHostId = 'rpc'
const bitcoindRpcPort = 8332
const electrsHostId = 'electrum'
const electrsPort = 50001

/** Split a bridge address, always `<ipv4>:<port>`, into the host and port the guardian wants. */
export const splitAddress = (addr: string) => {
  const i = addr.lastIndexOf(':')
  return { host: addr.slice(0, i), port: addr.slice(i + 1) }
}

/**
 * Bitcoin Core's JSON-RPC over the LXC bridge (`<osIp>:8332`), through its RPC proxy, which also
 * serves blocks the node has pruned. `null` while bitcoind is not installed; `.const()` makes
 * main run again when the address appears, so there is never a placeholder address.
 */
export const bitcoindRpcBridge = (effects: T.Effects) =>
  sdk.host
    .getBridgeAddress(effects, {
      packageId: 'bitcoind',
      hostId: bitcoindRpcHostId,
      internalPort: bitcoindRpcPort,
      ssl: false,
    })
    .const()

/** Electrs' plaintext Electrum port over the LXC bridge (`<osIp>:50001`), or `null`. */
export const electrsBridge = (effects: T.Effects) =>
  sdk.host
    .getBridgeAddress(effects, {
      packageId: 'electrs',
      hostId: electrsHostId,
      internalPort: electrsPort,
      ssl: false,
    })
    .const()
