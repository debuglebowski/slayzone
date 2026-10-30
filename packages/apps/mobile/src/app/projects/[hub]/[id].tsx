import { useLocalSearchParams, useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import { useHubFeeds } from '../../../hub-connections'
import { useHubSessions } from '../../../hub-sessions'
import { ProjectScreen } from '../../../projects/ProjectScreen'
import { ProjectsScreen } from '../../../projects/ProjectsScreen'
import { PROJECTS } from '../../../projects/routes'
import { findSession, taskHref } from '../../../routes'
import { SPLIT_MIN_WIDTH } from '../../../TaskBrowser'

/**
 * `/projects/<hub address>/<project id>`. Phone: the project on its own screen (it
 * scopes itself to its hub: every write goes to the hub that owns it). Wide screen: the
 * projects list with this one beside it.
 */
export default function ProjectRoute() {
  const { hub, id } = useLocalSearchParams<{ hub: string; id: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(PROJECTS))
  const openTask = (row: { hubLabel: string; task: { id: string } }) =>
    router.push(taskHref(row.hubLabel, row.task.id))

  if (width >= SPLIT_MIN_WIDTH) {
    const hubId = findSession(sessions, hub)?.entry.id
    return (
      <ProjectsScreen
        feeds={feeds}
        layout="split"
        selected={hubId ? { hubId, projectId: id } : null}
        onSelect={(row) => router.setParams({ hub: row.hubLabel, id: row.project.id })}
        onOpenTask={openTask}
        onBack={back}
      />
    )
  }
  return (
    <ProjectScreen
      hubAddress={hub}
      projectId={id}
      sessions={sessions}
      feeds={feeds}
      onBack={back}
      onOpenTask={openTask}
    />
  )
}
