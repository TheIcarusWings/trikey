import { FileHelper, T } from '@start9labs/start-sdk'
import { i18n } from './i18n'
import { sdk } from './sdk'
import {
  bitcoindRpcBridge,
  btcMountpoint,
  dataDir,
  electrsBridge,
  guardianUid,
  splitAddress,
  uiPort,
} from './utils'

// The guardian cannot do its job without Bitcoin Core and Electrs, and StartOS starts it whether
// or not they are there. While an address is missing, main runs only this health check, which
// says what is missing. Both addresses and the cookie are read with .const(), so main runs again,
// by itself, the moment the missing piece appears.
const waitingFor = (
  effects: T.Effects,
  id: 'bitcoind' | 'electrs',
  display: string,
  message: string,
) =>
  sdk.Daemons.of(effects).addHealthCheck(id, {
    ready: {
      display,
      gracePeriod: 0,
      trigger: sdk.trigger.cooldownTrigger(60_000),
      fn: async () => ({ result: 'failure', message }),
    },
    requires: [],
  })

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Trikey Guardian'))

  const rpc = await bitcoindRpcBridge(effects)
  if (!rpc) {
    return waitingFor(
      effects,
      'bitcoind',
      i18n('Bitcoin Core'),
      i18n(
        'Bitcoin Core is not installed, or has not published its RPC address and credentials yet',
      ),
    )
  }
  const electrum = await electrsBridge(effects)
  if (!electrum) {
    return waitingFor(
      effects,
      'electrs',
      i18n('Electrs'),
      i18n(
        'Electrs is not installed, or has not published its Electrum address yet',
      ),
    )
  }

  const guardianSub = await sdk.SubContainer.of(
    effects,
    { imageId: 'guardian' },
    sdk.Mounts.of()
      .mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: dataDir,
        readonly: false,
      })
      // Only for Bitcoin Core's RPC cookie; the guardian never reads this mount itself.
      .mountDependency<
        { id: 'bitcoind'; volumes: readonly ['main'] } & T.SDKManifest
      >({
        dependencyId: 'bitcoind',
        volumeId: 'main',
        subpath: null,
        mountpoint: btcMountpoint,
        readonly: true,
      }),
    'guardian',
  )

  // Bitcoin Core on StartOS authenticates with a cookie file, `__cookie__:<password>`, that it
  // writes again on every start. The guardian takes a user and a password, and Bitcoin Core's RPC
  // proxy accepts the cookie as the user `__cookie__`. The cookie is read here, in the package
  // runtime, and goes to the guardian as environment only, so it is never written to a volume.
  // Main runs again when a replacement cookie appears. The gap while bitcoind restarts, when the
  // file is gone, is not a change (the same pattern as electrs-startos).
  const rootfs = await guardianSub.rootfs
  const cookie = await FileHelper.string(`${rootfs}${btcMountpoint}/.cookie`)
    .read(
      (c) => c.trim(),
      (prev, next) => next === null || prev === next,
    )
    .const(effects)
  const sep = cookie ? cookie.indexOf(':') : -1
  if (!cookie || sep < 1) {
    return waitingFor(
      effects,
      'bitcoind',
      i18n('Bitcoin Core'),
      i18n(
        'Bitcoin Core is not installed, or has not published its RPC address and credentials yet',
      ),
    )
  }
  const rpcAddress = splitAddress(rpc)
  const electrumAddress = splitAddress(electrum)

  return (
    sdk.Daemons.of(effects)
      // StartOS mounts volumes owned by root every time, and the image runs the guardian as uid 1000.
      .addOneshot('chown-data', {
        subcontainer: guardianSub,
        exec: {
          command: ['chown', '-R', `${guardianUid}:${guardianUid}`, dataDir],
          user: 'root',
        },
        requires: [],
      })
      .addDaemon('guardian', {
        subcontainer: guardianSub,
        exec: {
          // The image's own CMD: `node --import tsx apps/guardian/src/main.ts`.
          command: sdk.useEntrypoint(),
          env: {
            PORT: String(uiPort),
            TRIKEY_DATA_DIR: dataDir,
            // StartOS runs Bitcoin Core on mainnet only.
            BITCOIN_NETWORK: 'bitcoin',
            ELECTRUM_HOST: electrumAddress.host,
            ELECTRUM_PORT: electrumAddress.port,
            BITCOIN_RPC_HOST: rpcAddress.host,
            BITCOIN_RPC_PORT: rpcAddress.port,
            BITCOIN_RPC_USER: cookie.slice(0, sep),
            BITCOIN_RPC_PASS: cookie.slice(sep + 1),
          },
        },
        // Ready when GET /api/status answers 2xx on the UI port: the same check as the image's
        // HEALTHCHECK. It runs inside the container (node is there; curl is not).
        ready: {
          display: i18n('Web Interface'),
          gracePeriod: 30_000,
          fn: () =>
            sdk.healthCheck.runHealthScript(
              [
                'node',
                '-e',
                `fetch('http://127.0.0.1:${uiPort}/api/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
              ],
              guardianSub,
              {
                timeout: 5_000,
                errorMessage: i18n('The web interface is not ready'),
                message: () => i18n('The web interface is ready'),
              },
            ),
        },
        requires: ['chown-data'],
      })
  )
})
