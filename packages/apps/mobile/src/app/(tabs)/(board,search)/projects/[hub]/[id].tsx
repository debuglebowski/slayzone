import { useLocalSearchParams, useRouter } from 'expo-router'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { ProjectScreen } from '../../../../../projects/ProjectScreen'
import { HOME, taskHref } from '../../../../../routes'

/**
 * `/projects/<hub address>/<project id>`: a project's settings — its computer, its
 * folder on each computer, its tasks (it scopes itself to its hub: every write goes to
 * the hub that owns it). Opened from the project switcher's ⋯.
 */
export default function ProjectRoute() {
  const { hub, id } = useLocalSearchParams<{ hub: string; id: string }>()
  const router = useRouter()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  return (
    <ProjectScreen
      hubAddress={hub}
      projectId={id}
      sessions={sessions}
      feeds={feeds}
      onBack={back}
      onOpenTask={(row) => router.push(taskHref(row.hubLabel, row.task.id))}
    />
  )
}
