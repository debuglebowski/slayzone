import { Redirect } from 'expo-router'
import { SETTINGS } from '../../../routes'

/** `/hubs`: the old Hubs tab; hubs are in Settings now. Links to it open Settings. */
export default function OldHubsRoute() {
  return <Redirect href={SETTINGS} />
}
