import { useRouter } from 'expo-router'
import { useHubFeeds } from '../hub-connections'
import { useHubSessions } from '../hub-sessions'
import { HubsScreen } from '../HubsScreen'
import { ADD_HUB, HOME } from '../routes'

/** `/hubs`: the signed-in hubs with their computers; add one, sign out of one. */
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
      onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME))}
    />
  )
}
