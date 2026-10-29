// Runtime definition: the guardian daemon, its volume, env and readiness check.
//
// TODO(verify): every SDK call here (setupMain, Daemons, SubContainer, Mounts, healthCheck,
// dependency addresses and credentials) is a placeholder for the 0.4 API.
// The structure is what matters: one daemon, one volume at /data, a readiness check on
// GET /api/status, and bitcoind and electrs as dependencies.
import { sdk } from './sdk'
import { UI_PORT } from './interfaces'

export const main = sdk.setupMain(async ({ effects }) => {
  // TODO(verify): use the image's own CMD (`node --import tsx apps/guardian/src/main.ts`).
  // Do not hardcode a second copy of the command here unless the SDK requires it.
  const command = ['node', '--import', 'tsx', 'apps/guardian/src/main.ts']

  // TODO(verify): fill these from the bitcoind and electrs dependency interfaces at runtime.
  // The guardian needs ELECTRUM_HOST/PORT and BITCOIN_RPC_HOST/PORT/USER/PASS. Credentials
  // must come from the platform, never from this file.
  const env: Record<string, string> = {
    PORT: String(UI_PORT),
    TRIKEY_DATA_DIR: '/data',
    BITCOIN_NETWORK: 'bitcoin', // TODO(verify): read the network from the bitcoind dependency
  }

  return sdk.Daemons.of(effects).addDaemon('guardian', {
    // TODO(verify): the SubContainer and mount API for the 'main' volume at /data.
    command,
    env,
    // Readiness: the daemon is ready when GET /api/status answers 2xx on the UI port.
    // TODO(verify): wire this through the 0.4 health-check helper (HTTP GET on
    // /api/status, port UI_PORT, expected 2xx). The helper's exact name and signature
    // are unverified.
    requires: [],
  })
})
