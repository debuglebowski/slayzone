import { Redirect } from 'expo-router'
import { HOME } from '../../../routes'

/** `/agents`: the old Agents tab; the board's 🔔 took its place. Links to it open the board. */
export default function OldAgentsRoute() {
  return <Redirect href={HOME} />
}
