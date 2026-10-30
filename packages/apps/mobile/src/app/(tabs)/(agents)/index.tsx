import { useRouter } from 'expo-router'
import { AgentsScreen } from '../../../agents/AgentsScreen'
import { useHubFeeds } from '../../../hub-connections'
import { useHubSessions } from '../../../hub-sessions'
import { agentHref } from '../../../routes'

/** `/` (the Agents tab, where the app opens): every hub's agents, grouped by what they need. */
export default function AgentsRoute() {
  const router = useRouter()
  const { feeds, retry } = useHubFeeds()
  const { signOut } = useHubSessions()
  return (
    <AgentsScreen
      feeds={feeds}
      onRetry={retry}
      onSignOut={signOut}
      onOpen={(row) => router.push(agentHref(row.hubLabel, row.task.id))}
    />
  )
}
