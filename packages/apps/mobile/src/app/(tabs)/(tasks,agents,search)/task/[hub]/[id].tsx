import { HubScope } from '@slayzone/transport/client'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { agentHref, findSession, TASKS } from '../../../../../routes'
import { SPLIT_MIN_WIDTH } from '../../../../../TaskBrowser'
import { TaskScreen } from '../../../../../TaskScreen'
import { TasksScreen } from '../../../../../TasksScreen'

/**
 * `/task/<hub address>/<task id>` (deep link `slayzone://task/<hub>/<id>`). Phone: the
 * task on its own screen, inside its hub's scope (anything it writes goes to the hub
 * that owns the task). Wide screen: the tasks list with the task beside it.
 */
export default function TaskRoute() {
  const { hub, id } = useLocalSearchParams<{ hub: string; id: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()

  if (width >= SPLIT_MIN_WIDTH) {
    return (
      <TasksScreen
        selectedHub={hub}
        selectedTask={id}
        select={(row) => router.setParams({ hub: row.hubLabel, id: row.task.id })}
      />
    )
  }

  const back = () => (router.canGoBack() ? router.back() : router.replace(TASKS))
  const screen = (
    <TaskScreen
      hubAddress={hub}
      taskId={id}
      sessions={sessions}
      feeds={feeds}
      onBack={back}
      onOpenAgent={(taskId) => router.push(agentHref(hub, taskId))}
    />
  )
  const session = findSession(sessions, hub)
  return session ? <HubScope hubId={session.entry.id}>{screen}</HubScope> : screen
}
