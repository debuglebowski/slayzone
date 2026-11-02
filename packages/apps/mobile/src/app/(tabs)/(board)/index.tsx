import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import { artifactHref } from '../../../artifacts/routes'
import { boardPrefsFile } from '../../../board/board-prefs-file'
import { useHubFeeds } from '../../../hub-connections'
import { useHubSessions } from '../../../hub-sessions'
import { useWide } from '../../../layout'
import { BoardHome } from '../../../home/BoardHome'
import { projectHref } from '../../../projects/routes'
import { taskHref } from '../../../routes'
import { newTaskHref } from '../../../task-edit/routes'

/**
 * `/` (the Board tab, where the app opens): the last project's board.
 * `?sheet=attention` opens the 🔔 sheet (`projects`: the project switcher; `menu`: ⋯;
 * `filter` / `display`: the board's Filter / Display sheet);
 * `?column=<status>` shows that column first on a phone.
 */
export default function BoardRoute() {
  const router = useRouter()
  const { sheet, column } = useLocalSearchParams<{ sheet?: string; column?: string }>()
  const wide = useWide()
  const focused = useIsFocused()
  const { feeds, retry } = useHubFeeds()
  const { sessions = [], signOut } = useHubSessions()
  return (
    <BoardHome
      feeds={feeds}
      sessions={sessions}
      wide={wide}
      onRetry={retry}
      onSignOut={signOut}
      onOpenTask={(row, segment) =>
        router.push(taskHref(row.hubLabel, row.task.id, segment ? { segment } : {}))
      }
      onNewTask={(target) => router.push(newTaskHref(target))}
      onOpenProject={(hubLabel, projectId) => router.push(projectHref(hubLabel, projectId))}
      onOpenArtifact={(hubLabel, taskId, artifactId, version) =>
        router.push(artifactHref(hubLabel, taskId, artifactId, version === null ? {} : { version }))
      }
      focused={focused}
      sheetParam={sheet}
      columnParam={column}
      prefs={boardPrefsFile}
    />
  )
}
