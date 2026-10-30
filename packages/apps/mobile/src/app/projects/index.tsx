import { useLocalSearchParams, useRouter } from 'expo-router'
import { useWindowDimensions } from 'react-native'
import { useHubFeeds } from '../../hub-connections'
import { useHubSessions } from '../../hub-sessions'
import { projectHref } from '../../projects/routes'
import { ProjectsScreen } from '../../projects/ProjectsScreen'
import { findSession, HOME, taskHref } from '../../routes'
import { SPLIT_MIN_WIDTH } from '../../TaskBrowser'

/** `/projects`: every hub's projects; on a wide screen `?hub=&project=` is the one beside the list. */
export default function ProjectsRoute() {
  const { hub, project } = useLocalSearchParams<{ hub?: string; project?: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { feeds } = useHubFeeds()
  const { sessions = [] } = useHubSessions()
  const layout = width >= SPLIT_MIN_WIDTH ? 'split' : 'list'
  const hubId = findSession(sessions, hub)?.entry.id
  return (
    <ProjectsScreen
      feeds={feeds}
      layout={layout}
      selected={hubId && project ? { hubId, projectId: project } : null}
      onSelect={(row) =>
        layout === 'split'
          ? router.setParams({ hub: row.hubLabel, project: row.project.id })
          : router.push(projectHref(row.hubLabel, row.project.id))
      }
      onOpenTask={(row) => router.push(taskHref(row.hubLabel, row.task.id))}
      onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME))}
    />
  )
}
