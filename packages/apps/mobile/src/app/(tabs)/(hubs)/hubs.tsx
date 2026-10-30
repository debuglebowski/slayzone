import { useRouter } from 'expo-router'
import { useHubFeeds } from '../../../hub-connections'
import { useHubSessions } from '../../../hub-sessions'
import { HubsScreen } from '../../../HubsScreen'
import { ADD_HUB } from '../../../routes'

/** `/hubs` (the Hubs tab): the signed-in hubs with their computers; add one, sign out of one. */
export default function HubsRoute() {
  const { feeds } = useHubFeeds()
  const { sessions = [], signOut } = useHubSessions()
  const router = useRouter()
  return (
    <HubsScreen
      feeds={feeds}
      sessions={sessions}
      onAdd={() => router.push(ADD_HUB)}
      onSignOut={signOut}
    />
  )
}
