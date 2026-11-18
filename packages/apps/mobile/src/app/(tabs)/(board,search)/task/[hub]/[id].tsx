import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useOpenTasks } from '../../../../../home/OpenTasksProvider'
import { artifactHref } from '../../../../../artifacts/routes'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { useWide } from '../../../../../layout'
import { findSession, HOME, taskHref, taskInfoHref } from '../../../../../routes'
import { useHideTabBar } from '../../../../../tab-bar'
import { segmentParam, TaskScreen } from '../../../../../task/TaskScreen'

/**
 * `/task/<hub address>/<task id>[?segment=agent|details|artifacts]`
 * (deep link `slayzone://task/<hub>/<id>`): the task's page on that hub, Agent first —
 * the task's main agent (the app shows no agent tabs; an older link's `&tab=` is
 * ignored). The shown part lives in the params, so a link opens the same view.
 * Phone: the page is the conversation, the app's tab bar hidden while it shows; its ⓘ
 * opens Details / Artifacts as a sheet over it (`./[id]/info`) — and so does a link
 * naming either, its `segment` handed over to the sheet.
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
  // This route's own navigation: its params are the ones set (see the link below).
  const navigation = useNavigation<{ setParams: (params: { segment: string }) => void }>()
  const wide = useWide()
  const [openedWide] = useState(wide)
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  const open = useOpenTasks()
  const hubId = findSession(sessions, hub)?.entry.id
  const asTab = openedWide && hubId !== undefined
  useHideTabBar(!wide)
  // Phone: a link naming Details or Artifacts opens the page with that sheet over it.
  const linkedInfo =
    !openedWide && (segment === 'details' || segment === 'artifacts') ? segment : null
  useEffect(() => {
    if (!linkedInfo) return
    // Handed over: the page under the sheet shows the agent. This route's own params
    // (`router.setParams` names the focused route, on a cold link not this one yet);
    // `agent`, as an unset param would read "undefined" in the URL.
    navigation.setParams({ segment: 'agent' })
    router.push(taskInfoHref(hub, id, linkedInfo))
  }, [linkedInfo, hub, id, router, navigation])
  useEffect(() => {
    if (!asTab || !hubId) return
    open.open({ hubId, taskId: id }, { segment: segment === 'artifacts' ? 'artifacts' : 'details' })
    router.replace(HOME)
  }, [asTab, hubId, id, segment, open, router])
  if (asTab) return null
  return (
    <TaskScreen
      hubAddress={hub}
      taskId={id}
      sessions={sessions}
      feeds={feeds}
      wide={wide}
      segment={segmentParam(segment)}
      onSegment={(next) => router.setParams({ segment: next })}
      onOpenInfo={(part) => router.push(taskInfoHref(hub, id, part))}
      onBack={back}
      onOpenTask={(taskId) => router.push(taskHref(hub, taskId))}
      onOpenArtifact={(artifactId, version) =>
        router.push(artifactHref(hub, id, artifactId, version === null ? {} : { version }))
      }
    />
  )
}
