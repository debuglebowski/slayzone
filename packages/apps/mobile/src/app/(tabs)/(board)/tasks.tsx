import { Redirect } from 'expo-router'
import { HOME } from '../../../routes'

/** `/tasks`: the old Tasks tab; the board is home now. Links to it open the board. */
export default function OldTasksRoute() {
  return <Redirect href={HOME} />
}
