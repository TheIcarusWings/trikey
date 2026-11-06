import { sdk } from '../sdk'
import { dependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { actions } from '../actions'
import { restoreInit } from '../backups'
import { seedEntropy } from './seedEntropy'
import { seedSetupCode } from './setupCode'
import { watchPassword } from './watchPassword'

// Actions are registered before the handlers that create tasks for them.
export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  actions,
  dependencies,
  seedEntropy,
  seedSetupCode,
  watchPassword,
)

export const uninit = sdk.setupUninit(versionGraph)
