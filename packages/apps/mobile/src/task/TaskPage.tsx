/**
 * One task, managed entirely from here — desktop's task page.
 *
 * Phone (`TaskPageLayout`): the page is the agent — the chat or the terminal, full height
 * — under a floating glass top bar (‹ back, the title, the status island: the agent's
 * state, Stop / Start, a tap opening the agent card with the agent's controls and the
 * task's actions) and over a floating tab bar (Agent · Details · Artifacts, the part
 * shown in the route's `segment`), a chat's composer on it. The app's own tab bar is
 * hidden meanwhile (the route).
 *
 * iPad (`wide`): the header — ‹ back, ⋯ (mark unread, archive, delete), the status icon
 * (tap: change status), the title (edit in place), priority, tags and due date under it
 * — then Agent and Details side by side (Artifacts as a tab of the right pane). A part,
 * once shown, stays mounted while another is shown (hidden: not drawn to touch, not read
 * by VoiceOver); each mounts the first time it is shown.
 *
 * Scopes itself to the task's hub: every read and write goes to the hub that owns it.
 */
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { type AgentNav, AgentPanel } from '../agents/AgentPanel'
import { hubTarget } from '../artifacts/hub-rest'
import { ChatUploadTargetContext } from '../chat/ChatUploadTarget'
import type { HubFeed, TaskRow } from '../hub-board'
import type { HubSession } from '../hub-session'
import { useFieldSheets } from '../task-edit/TaskFields'
import { useTaskWrites } from '../task-edit/use-task-writes'
import { TaskPageLayout } from './TaskPageLayout'

export type TaskSegment = 'agent' | 'details' | 'artifacts'
export const TASK_SEGMENTS: readonly TaskSegment[] = ['agent', 'details', 'artifacts']

export interface TaskPageProps {
  row: TaskRow
  /** The feed of the hub that owns the task. */
  feed: HubFeed
  session: HubSession
  showHub: boolean
  /** iPad: Agent and Details side by side. */
  wide: boolean
  /** The part shown: phone, the tab; iPad, the right pane's (`agent`: Details). */
  segment: TaskSegment
  onSegment: (segment: TaskSegment) => void
  /** Back to the board; absent = no back (an iPad tab). */
  onBack?: () => void
  backDestination?: string
  onDeleted: () => void
  /** A sub-task was tapped. */
  onOpenTask: (taskId: string) => void
  /** An artifact of the Artifacts tab was tapped. */
  onOpenArtifact: (artifactId: string, version: number | null) => void
}

export function TaskPage(props: TaskPageProps) {
  return (
    <HubScope hubId={props.row.hubId}>
      <ScopedTaskPage {...props} />
    </HubScope>
  )
}

function ScopedTaskPage(props: TaskPageProps) {
  const { row, session, wide } = props
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const uploadTarget = useMemo(() => hubTarget(session), [session])
  const renderLayout = (body: ReactNode, agent?: AgentNav) => (
    <TaskPageLayout page={props} agent={agent} body={body} writes={writes} fields={fields} />
  )

  return (
    <View style={styles.screen} testID="task-page">
      <ChatUploadTargetContext.Provider value={uploadTarget}>
        <AgentPanel
          hubId={row.hubId}
          feed={props.feed}
          row={{ ...row, task: writes.task }}
          showHub={props.showHub}
          {...(wide
            ? { renderWide: renderLayout }
            : { phone: (agent, body) => renderLayout(body, agent) })}
        />
      </ChatUploadTargetContext.Provider>
      {fields.sheets}
    </View>
  )
}

const styles = StyleSheet.create({ screen: { flex: 1 } })
