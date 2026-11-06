import { FileHelper, T } from '@start9labs/start-sdk'
import { storeJson } from './fileModels/store.json'
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

  // The guardian uses Bitcoin Core's RPC (all four BITCOIN_RPC_* or none) for sync status, as a
  // broadcast fallback, for the silent payment scanner (`getblock <hash> 3`), and to read the
  // mempool itself when Electrs cannot (Bitcoin Core 32 dropped the `bip125-replaceable` field
  // that electrs 0.11 needs, so its mempool stays empty). Umbrel passes the same four.
  //
  // Bitcoin Core on StartOS authenticates dependents with a cookie file, `__cookie__:<password>`,
  // that it writes again on every start; `rpcuser`/`rpcpassword` are not supported
  // (bitcoin-core-startos README). Its RPC proxy on 8332 accepts the cookie user with every call
  // allowed (btc-rpc-proxy `passthrough_rpccookie`), batches included. mempool-startos,
  // electrs-startos, lnd-startos and btcpayserver-startos read the same file from the same mount.
  // The cookie is read here, in the package runtime, and goes to the guardian as environment
  // only, so it is never written to a volume.
  //
  // Main runs again when a replacement cookie appears, which restarts the guardian (and so locks
  // key 3 until it is unlocked) whenever Bitcoin restarts: the old password stops working at that
  // moment. The gap while bitcoind restarts, when the file is gone, is not a change (the same
  // pattern as electrs-startos).
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
  // Drawn once at install (init/seedEntropy.ts). Read once: it never changes afterwards.
  const extraEntropy = await storeJson.read((s) => s.extraEntropy).once()
  // Drawn once at install (init/setupCode.ts) and shown in the show-setup-code action.
  const setupCode = await storeJson.read((s) => s.setupCode).once()

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
            TRIKEY_PLATFORM: 'start9',
            // Until it is set up, the guardian asks for this code: the basic-auth gate covers only
            // the TLS interface, and other services on this server reach the plaintext port
            // without it (DESIGN.md, "First run"). The owner reads it in StartOS (Actions > Show
            // Setup Code, and with the web password). Without it the guardian would print a new
            // one in its log at every start.
            ...(setupCode ? { TRIKEY_SETUP_CODE: setupCode } : {}),
            // StartOS runs Bitcoin Core on mainnet only.
            BITCOIN_NETWORK: 'bitcoin',
            ELECTRUM_HOST: electrumAddress.host,
            ELECTRUM_PORT: electrumAddress.port,
            BITCOIN_RPC_HOST: rpcAddress.host,
            BITCOIN_RPC_PORT: rpcAddress.port,
            BITCOIN_RPC_USER: cookie.slice(0, sep),
            BITCOIN_RPC_PASS: cookie.slice(sep + 1),
            // Umbrel passes its APP_SEED here; on StartOS it is the package's own draw.
            ...(extraEntropy ? { TRIKEY_EXTRA_ENTROPY: extraEntropy } : {}),
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
