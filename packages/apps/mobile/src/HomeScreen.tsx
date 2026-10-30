import { useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import type { TaskRow } from './hub-board'
import { useHubFeeds } from './hub-connections'
import { useHubSessions } from './hub-sessions'
import { ARTIFACT_SEARCH } from './artifacts/routes'
import { AGENTS, agentHref, findSession, HUBS, taskHref } from './routes'
import { SPLIT_MIN_WIDTH, TaskBrowser } from './TaskBrowser'

/**
 * Home, wired to the app: every hub's feed, the signed-in sessions, navigation. A
 * tapped agent opens its agent screen. A phone opens a tapped task on its own
 * screen; a wide screen (iPad) shows it beside the list (`select`: the route keeps the choice in its params, so a deep link to a
 * task opens it the same way).
 */
export function HomeScreen({
  selectedHub,
  selectedTask,
  select
}: {
  /** The hub address of the task shown beside the list (wide screens). */
  selectedHub: string | undefined
  selectedTask: string | undefined
  select: (row: TaskRow) => void
}) {
  const { feeds, retry } = useHubFeeds()
  const { sessions = [], signOut } = useHubSessions()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const layout = width >= SPLIT_MIN_WIDTH ? 'split' : 'list'
  const hubId = findSession(sessions, selectedHub)?.entry.id

  return (
    <TaskBrowser
      feeds={feeds}
      layout={layout}
      selected={hubId && selectedTask ? { hubId, taskId: selectedTask } : null}
      onSelect={(row) =>
        layout === 'split' ? select(row) : router.push(taskHref(row.hubLabel, row.task.id))
      }
      onRetry={retry}
      onSignOut={signOut}
      onManageHubs={() => router.push(HUBS)}
      onSearchArtifacts={() => router.push(ARTIFACT_SEARCH)}
      onOpenAgent={(row) => router.push(agentHref(row.hubLabel, row.task.id))}
      onShowAgents={() => router.push(AGENTS)}
    />
  )
}
