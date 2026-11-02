import { useRouter } from 'expo-router'
import { useHubFeeds } from '../../../hub-connections'
import { useHubSessions } from '../../../hub-sessions'
import { ADD_HUB } from '../../../routes'
import { SettingsScreen } from '../../../SettingsScreen'

/** `/settings` (the Settings tab): hubs (add, sign out, computers), theme, about. */
export default function SettingsRoute() {
  const { feeds } = useHubFeeds()
  const { sessions = [], signOut } = useHubSessions()
  const router = useRouter()
  return (
    <SettingsScreen
      feeds={feeds}
      sessions={sessions}
      onAdd={() => router.push(ADD_HUB)}
      onSignOut={signOut}
    />
  )
}
