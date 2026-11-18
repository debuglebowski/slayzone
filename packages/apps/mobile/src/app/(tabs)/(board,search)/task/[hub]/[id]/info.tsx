import { useLocalSearchParams, useRouter } from 'expo-router'
import { artifactHref } from '../../../../../../artifacts/routes'
import { useHubFeeds } from '../../../../../../hub-connections'
import { useHubSessions } from '../../../../../../hub-sessions'
import { HOME, taskHref } from '../../../../../../routes'
import { useHideTabBar } from '../../../../../../tab-bar'
import { infoSegmentParam, TaskInfoScreen } from '../../../../../../task/TaskScreen'

/**
 * `/task/<hub address>/<task id>/info?segment=details|artifacts`: the phone's Details /
 * Artifacts sheet over the task's page (`TabStack` presents it as iOS's sheet, medium
 * then large). The page stays mounted under it, its draft and terminal with it; the
 * part shown lives in the params. Leaving for a sub-task or an artifact closes the sheet
 * first, so they push onto the page, not into the sheet.
 */
export default function TaskInfoRoute() {
  const { hub, id, segment } = useLocalSearchParams<{
    hub: string
    id: string
    segment?: string
  }>()
  const router = useRouter()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  useHideTabBar(true)
  const close = () => (router.canGoBack() ? router.back() : router.replace(taskHref(hub, id)))
  const leaveFor = (href: string) => {
    close()
    router.push(href)
  }
  return (
    <TaskInfoScreen
      hubAddress={hub}
      taskId={id}
      sessions={sessions}
      feeds={feeds}
      segment={infoSegmentParam(segment)}
      onSegment={(next) => router.setParams({ segment: next })}
      onClose={close}
      // Deleted: the sheet and the task's page go — back to where the task was opened.
      onDeleted={() => (router.canDismiss() ? router.dismiss(2) : router.replace(HOME))}
      onOpenTask={(taskId) => leaveFor(taskHref(hub, taskId))}
      onOpenArtifact={(artifactId, version) =>
        leaveFor(artifactHref(hub, id, artifactId, version === null ? {} : { version }))
      }
    />
  )
}
