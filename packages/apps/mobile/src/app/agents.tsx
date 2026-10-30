import { useRouter } from 'expo-router'
import { AgentsScreen } from '../agents/AgentsScreen'
import { useHubFeeds } from '../hub-connections'
import { agentHref, HOME } from '../routes'

/** `/agents`: every hub's agents, grouped by what they need. */
export default function AgentsRoute() {
  const router = useRouter()
  const { feeds } = useHubFeeds()
  return (
    <AgentsScreen
      feeds={feeds}
      onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME))}
      onOpen={(row) => router.push(agentHref(row.hubLabel, row.task.id))}
    />
  )
}
