import { useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import type { TaskRow } from './hub-board'
import { useHubFeeds } from './hub-connections'
import { useHubSessions } from './hub-sessions'
import { PROJECTS } from './projects/routes'
import { agentHref, findSession, taskHref } from './routes'
import { SPLIT_MIN_WIDTH, TaskBrowser } from './TaskBrowser'

/**
 * The Tasks tab, wired to the app: every hub's feed, the signed-in sessions,
 * navigation (pushes stay in the tab). A phone opens a tapped task on its own screen;
 * a wide screen (iPad) shows it beside the list (`select`: the route keeps the choice
 * in its params, so a deep link to a task opens it the same way), its "Agent ›" opens
 * the agent screen.
 */
export function TasksScreen({
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
      onShowProjects={() => router.push(PROJECTS)}
      onOpenAgent={(row) => router.push(agentHref(row.hubLabel, row.task.id))}
    />
  )
}
