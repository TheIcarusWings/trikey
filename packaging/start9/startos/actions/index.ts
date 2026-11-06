import { sdk } from '../sdk'
import { setWebPassword } from './setWebPassword'
import { showSetupCode } from './showSetupCode'

export const actions = sdk.Actions.of()
  .addAction(setWebPassword)
  .addAction(showSetupCode)
