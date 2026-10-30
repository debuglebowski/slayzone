import { Redirect } from 'expo-router'
import { AGENTS } from '../../../routes'

/** `/agents`: the Agents tab's address before the app had tabs; links to it still work. */
export default function OldAgentsRoute() {
  return <Redirect href={AGENTS} />
}
