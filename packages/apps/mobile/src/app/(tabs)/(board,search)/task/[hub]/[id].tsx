import { useLocalSearchParams, useNavigation, useRoute, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useOpenTasks } from '../../../../../home/OpenTasksProvider'
import { artifactHref } from '../../../../../artifacts/routes'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { useWide } from '../../../../../layout'
import { findSession, HOME, previousStackRoute, taskHref } from '../../../../../routes'
import { useHideTabBar } from '../../../../../tab-bar'
import { segmentParam, TaskScreen } from '../../../../../task/TaskScreen'

/**
 * `/task/<hub address>/<task id>[?segment=agent|details|artifacts]`
 * (deep link `slayzone://task/<hub>/<id>`): the task's page on that hub, Agent first —
 * the task's main agent (the app shows no agent tabs; an older link's `&tab=` is
 * ignored). The shown part lives in the params, so a link opens the same view.
 * Phone: the page's own tab bar shows Agent, Details or Artifacts (`segment`); the app's
 * tab bar is hidden while the page shows.
 * iPad: a task opened wide opens as a tab on the board instead (desktop's tab bar).
 * Only how it OPENS decides that: a page opened narrow (Split View, Slide Over) stays a
 * page when the window later widens or rotates — a resize never navigates away.
 */
export default function TaskRoute() {
  const { hub, id, segment } = useLocalSearchParams<{
    hub: string
    id: string
    segment?: string
  }>()
  const router = useRouter()
  // This route's own navigation: `router.setParams` names the focused route, which is
  // not this one while a screen pushed over it (an artifact) is still on its way out.
  const navigation = useNavigation()
  const routeKey = useRoute().key
  const previous = previousStackRoute(navigation.getState(), routeKey)
  const backDestination =
    previous === 'artifacts/index'
      ? 'Search'
      : previous?.startsWith('artifacts/')
        ? 'Artifacts'
        : previous?.startsWith('task/')
          ? 'the parent task'
          : undefined
  const wide = useWide()
  const [openedWide] = useState(wide)
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  const open = useOpenTasks()
  const hubId = findSession(sessions, hub)?.entry.id
  const asTab = openedWide && hubId !== undefined
  useHideTabBar(!wide)
  useEffect(() => {
    if (!asTab || !hubId) return
    open.open({ hubId, taskId: id }, { segment: segment === 'artifacts' ? 'artifacts' : 'details' })
    router.replace(HOME)
  }, [asTab, hubId, id, segment, open, router])
  // A task screen of its own (iPhone): open it on the desktop too.
  const { share } = open
  useEffect(() => {
    if (!asTab && hubId) share({ hubId, taskId: id })
  }, [asTab, hubId, id, share])
  if (asTab) return null
  return (
    <TaskScreen
      hubAddress={hub}
      taskId={id}
      sessions={sessions}
      feeds={feeds}
      wide={wide}
      segment={segmentParam(segment)}
      onSegment={(next) =>
        navigation.dispatch({
          type: 'SET_PARAMS',
          source: routeKey,
          payload: { params: { segment: next } }
        })
      }
      onBack={back}
      {...(backDestination ? { backDestination } : {})}
      onOpenTask={(taskId) => router.push(taskHref(hub, taskId))}
      onOpenArtifact={(artifactId, version) =>
        router.push(artifactHref(hub, id, artifactId, version === null ? {} : { version }))
      }
    />
  )
}
