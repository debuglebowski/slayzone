import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArtifactSearchScreen } from '../artifacts/ArtifactSearchScreen'
import { artifactHref } from '../artifacts/routes'
import { useHubFeeds } from '../hub-connections'
import { useHubSessions } from '../hub-sessions'
import { taskHref } from '../routes'
import { TaskSearchResults } from './TaskSearchResults'

/**
 * `/artifacts` (the Search tab): one query over every signed-in hub — its tasks (titles
 * and descriptions, from the loaded boards) above its artifacts (the hubs' artifact
 * search). A result opens in the Search tab's own stack. `?q=`: what to search for at first.
 */
export function SearchRoute() {
  const router = useRouter()
  const { q } = useLocalSearchParams<{ q?: string }>()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  return (
    <ArtifactSearchScreen
      sessions={sessions}
      feeds={feeds}
      title="Search"
      largeTitle
      initialQuery={q ?? ''}
      placeholder="Search tasks and artifacts"
      before={(q) => (
        <TaskSearchResults
          feeds={feeds}
          q={q}
          onOpen={(r) => router.push(taskHref(r.hubLabel, r.task.id))}
        />
      )}
      onOpen={(r) => router.push(artifactHref(r.hubLabel, r.taskId, r.artifactId))}
    />
  )
}
