import { useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import { boardPrefsFile } from './board/board-prefs-file'
import { newTaskHref } from './board/routes'
import type { TaskRow } from './hub-board'
import { useHubFeeds } from './hub-connections'
import { useHubSessions } from './hub-sessions'
import { PROJECTS } from './projects/routes'
import { agentHref, findSession, taskHref, TASKS } from './routes'
import { SPLIT_MIN_WIDTH, TaskBrowser } from './TaskBrowser'

/**
 * The Tasks tab, wired to the app: every hub's feed, the signed-in sessions, the board's
 * remembered choices (`board-prefs-file.ts`), navigation (pushes stay in the tab). A
 * phone opens a tapped task on its own screen; a wide screen (iPad) shows it beside the
 * board (`select`: the route keeps the choice in its params, so a deep link to a task
 * opens it the same way), its "Agent ›" opens the agent screen. "+" opens the
 * create-task screen for the shown project.
 */
export function TasksScreen({
  selectedHub,
  selectedTask,
  select,
  deselect
}: {
  /** The hub address of the task shown beside the board (wide screens). */
  selectedHub: string | undefined
  selectedTask: string | undefined
  select: (row: TaskRow) => void
  /** Close the task beside the board; default: the Tasks tab's own route. */
  deselect?: () => void
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
      onDeselect={deselect ?? (() => router.replace(TASKS))}
      onRetry={retry}
      onSignOut={signOut}
      onShowProjects={() => router.push(PROJECTS)}
      onOpenAgent={(row) => router.push(agentHref(row.hubLabel, row.task.id))}
      onNewTask={(target) => router.push(newTaskHref(target))}
      prefs={boardPrefsFile}
    />
  )
}
