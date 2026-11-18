/**
 * One task, managed entirely from here — desktop's task page.
 *
 * Phone (`PhoneTaskPage`): the page is the agent — the chat or the terminal, full height
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
import type { HubSession } from '../hub-session'
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AgentPanel } from '../agents/AgentPanel'
import { hubTarget } from '../artifacts/hub-rest'
import { ArtifactsScreen } from '../artifacts/ArtifactsScreen'
import { useTaskArtifacts } from '../artifacts/use-task-artifacts'
import { ChatUploadTargetContext } from '../chat/ChatUploadTarget'
import type { HubFeed, TaskRow } from '../hub-board'
import { useFieldSheets } from '../task-edit/TaskFields'
import { useTaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import { PhoneTaskPage } from './PhoneTaskPage'
import {
  artifactsLabel,
  DetailsPanel,
  KeptPart,
  PartSegments,
  TaskMenu,
  TaskMenuButton,
  TitleBlock
} from './task-parts'

export type TaskSegment = 'agent' | 'details' | 'artifacts'
export const TASK_SEGMENTS: readonly TaskSegment[] = ['agent', 'details', 'artifacts']
/** The parts of the iPad's right pane. */
export type InfoSegment = Exclude<TaskSegment, 'agent'>
export const INFO_SEGMENTS: readonly InfoSegment[] = ['details', 'artifacts']

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
  onDeleted: () => void
  /** A sub-task was tapped. */
  onOpenTask: (taskId: string) => void
  /** An artifact of the Artifacts tab was tapped. */
  onOpenArtifact: (artifactId: string, version: number | null) => void
}

export function TaskPage(props: TaskPageProps) {
  return (
    <HubScope hubId={props.row.hubId}>
      {props.wide ? <WidePage {...props} /> : <PhonePage {...props} />}
    </HubScope>
  )
}

/** Phone: the agent, the floating chrome around it, Details and Artifacts as tabs. */
function PhonePage(props: TaskPageProps) {
  const { row } = props
  const styles = makeStyles(useTheme())
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const uploadTarget = useMemo(() => hubTarget(props.session), [props.session])
  return (
    <View style={styles.screen} testID="task-page">
      <ChatUploadTargetContext.Provider value={uploadTarget}>
        <AgentPanel
          hubId={row.hubId}
          feed={props.feed}
          row={{ ...row, task: writes.task }}
          showHub={props.showHub}
          phone={(agent, body) => (
            <PhoneTaskPage page={props} agent={agent} body={body} writes={writes} fields={fields} />
          )}
        />
      </ChatUploadTargetContext.Provider>
      {fields.sheets}
    </View>
  )
}

/** iPad: the header, then Agent and Details side by side. */
function WidePage(props: TaskPageProps) {
  const { row, segment, onSegment } = props
  const theme = useTheme()
  const styles = makeStyles(theme)
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const [menu, setMenu] = useState(false)
  const { artifacts } = useTaskArtifacts(row.task.id)
  const uploadTarget = useMemo(() => hubTarget(props.session), [props.session])
  const shown: InfoSegment = segment === 'artifacts' ? 'artifacts' : 'details'
  // The parts shown so far: each stays mounted from its first showing on.
  const [visited, setVisited] = useState<ReadonlySet<InfoSegment>>(() => new Set([shown]))
  if (!visited.has(shown)) setVisited(new Set([...visited, shown]))

  const kept = (part: InfoSegment, node: ReactNode) =>
    visited.has(part) ? (
      <KeptPart key={part} shown={shown === part} testID={`part-${part}`}>
        {node}
      </KeptPart>
    ) : null

  return (
    <View style={styles.screen} testID="task-page">
      <View style={styles.header}>
        {props.onBack ? (
          <Pressable
            onPress={props.onBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to the board"
          >
            <Text style={styles.back} numberOfLines={1}>
              ‹ {row.project?.name ?? 'Board'}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.flex} />
        <TaskMenuButton onPress={() => setMenu(true)} />
      </View>
      <TitleBlock
        row={row}
        writes={writes}
        feed={props.feed}
        showHub={props.showHub}
        openField={fields.open}
      />
      {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
      <ChatUploadTargetContext.Provider value={uploadTarget}>
        <View style={styles.panes}>
          <View style={[styles.pane, styles.agentPane]} testID="pane-agent">
            <AgentPanel
              hubId={row.hubId}
              feed={props.feed}
              row={{ ...row, task: writes.task }}
              showHub={props.showHub}
            />
          </View>
          <View style={[styles.pane, styles.sidePane]} testID="pane-side">
            <PartSegments
              parts={INFO_SEGMENTS}
              shown={shown}
              labelOf={(part) =>
                part === 'details' ? 'Details' : artifactsLabel(artifacts?.length)
              }
              onShow={onSegment}
            />
            <View style={styles.flex}>
              {kept(
                'details',
                <DetailsPanel
                  row={row}
                  feed={props.feed}
                  writes={writes}
                  openField={fields.open}
                  onOpenTask={props.onOpenTask}
                />
              )}
              {kept(
                'artifacts',
                <ArtifactsScreen
                  session={props.session}
                  taskId={row.task.id}
                  layout="list"
                  selected={null}
                  embedded
                  onSelect={(id) => props.onOpenArtifact(id, null)}
                  onSelectVersion={props.onOpenArtifact}
                  onBack={() => onSegment('agent')}
                />
              )}
            </View>
          </View>
        </View>
      </ChatUploadTargetContext.Provider>
      {fields.sheets}
      <TaskMenu
        visible={menu}
        writes={writes}
        columns={row.project?.columns_config}
        onDeleted={props.onDeleted}
        onClose={() => setMenu(false)}
      />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingTop: 6,
      paddingBottom: 4,
      gap: 8
    },
    back: { fontSize: 16, color: t.primary, fontWeight: '500', maxWidth: 240 },
    error: { color: t.destructive, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
    panes: { flex: 1, flexDirection: 'row', gap: 10, padding: 10 },
    pane: {
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      overflow: 'hidden'
    },
    agentPane: { flex: 3 },
    sidePane: { flex: 2 }
  })
