import { sdk } from '../sdk'
import { setWebPassword } from './setWebPassword'

export const actions = sdk.Actions.of().addAction(setWebPassword)
