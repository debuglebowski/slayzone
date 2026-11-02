import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { useOpenTasks } from '../../../../../home/OpenTasksProvider'
import { artifactHref } from '../../../../../artifacts/routes'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { useWide } from '../../../../../layout'
import { findSession, HOME, taskHref } from '../../../../../routes'
import { segmentParam, TaskScreen } from '../../../../../task/TaskScreen'

/**
 * `/task/<hub address>/<task id>[?segment=agent|details|artifacts][&tab=<agent tab>]`
 * (deep link `slayzone://task/<hub>/<id>`): the task's page on that hub, Agent first.
 * The shown part and agent tab live in the params, so a link opens the same view.
 * iPad: the task opens as a tab on the board instead (desktop's tab bar).
 */
export default function TaskRoute() {
  const { hub, id, segment, tab } = useLocalSearchParams<{
    hub: string
    id: string
    segment?: string
    tab?: string
  }>()
  const router = useRouter()
  const wide = useWide()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  const open = useOpenTasks()
  const hubId = findSession(sessions, hub)?.entry.id
  const asTab = wide && hubId !== undefined
  useEffect(() => {
    if (!asTab || !hubId) return
    open.open(
      { hubId, taskId: id },
      { segment: segment === 'artifacts' ? 'artifacts' : 'details', agentTabId: tab || undefined }
    )
    router.replace(HOME)
  }, [asTab, hubId, id, segment, tab, open, router])
  if (asTab) return null
  return (
    <TaskScreen
      hubAddress={hub}
      taskId={id}
      sessions={sessions}
      feeds={feeds}
      wide={wide}
      segment={segmentParam(segment)}
      agentTabId={tab || undefined}
      onSegment={(next) => router.setParams({ segment: next })}
      onSelectAgentTab={(next) => router.setParams({ tab: next })}
      onBack={back}
      onOpenTask={(taskId) => router.push(taskHref(hub, taskId))}
      onOpenArtifact={(artifactId, version) =>
        router.push(artifactHref(hub, id, artifactId, version === null ? {} : { version }))
      }
    />
  )
}
