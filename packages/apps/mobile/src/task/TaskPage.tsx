/**
 * One task, managed entirely from here — desktop's task page:
 *
 * - header: ‹ back to the board (named after the project), ⋯ (mark unread, archive,
 *   delete);
 * - the status icon (tap: change status) and the title (edit in place); priority, tags
 *   and due date under it (tap priority or due to change them);
 * - phone: a segmented control — Agent (the chat or the terminal, full height), Details
 *   (description, sub-tasks, the details list), Artifacts (with how many);
 * - iPad (`wide`): Agent and Details side by side (Artifacts as a tab of the right pane).
 *
 * Scopes itself to the task's hub: every read and write goes to the hub that owns it.
 */
import type { HubSession } from '../hub-session'
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AgentPanel } from '../agents/AgentPanel'
import { ArtifactsScreen } from '../artifacts/ArtifactsScreen'
import { useTaskArtifacts } from '../artifacts/use-task-artifacts'
import { cardModel, statusCategoryOf } from '../board/card-model'
import { TaskComputer } from '../computers/TaskComputer'
import type { HubFeed, TaskRow } from '../hub-board'
import { DescriptionSection } from '../task-edit/DescriptionSection'
import { dueLabel, priorityLabel, statusLabel } from '../task-edit/fields'
import { BlockersSection, SubtasksSection, TagsSection } from '../task-edit/OrganiseSections'
import { useTaskActions } from '../task-edit/TaskActions'
import { type TaskField, TitleInput, useFieldSheets } from '../task-edit/TaskFields'
import { makeStyles as editStyles } from '../task-edit/ui'
import { type TaskWrites, useTaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { BottomSheet } from '../ui-kit/Chrome'
import { PriorityIcon, StatusIcon, TagPills } from '../ui-kit/TaskGlyphs'
import { todayISO } from '@slayzone/tasks/board'

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
  segment: TaskSegment
  onSegment: (segment: TaskSegment) => void
  /** The agent tab shown; undefined = the main one. */
  agentTabId: string | undefined
  onSelectAgentTab: (tabId: string) => void
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
      <Page {...props} />
    </HubScope>
  )
}

function Page(props: TaskPageProps) {
  const { row, wide, segment, onSegment } = props
  const theme = useTheme()
  const styles = makeStyles(theme)
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const [menu, setMenu] = useState(false)
  const { artifacts } = useTaskArtifacts(row.task.id)
  const artifactsLabel = artifacts?.length ? `Artifacts ${artifacts.length}` : 'Artifacts'

  const segments = (shown: readonly TaskSegment[]) => (
    <View style={styles.segments} accessibilityRole="tablist">
      {shown.map((s) => {
        const on = s === segment || (!shown.includes(segment) && s === shown[0])
        return (
          <Pressable
            key={s}
            onPress={() => onSegment(s)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            testID={`segment-${s}`}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>
              {s === 'agent' ? 'Agent' : s === 'details' ? 'Details' : artifactsLabel}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )

  const agent = (
    <AgentPanel
      hubId={row.hubId}
      feed={props.feed}
      row={{ ...row, task: writes.task }}
      showHub={props.showHub}
      tabId={props.agentTabId}
      onSelectTab={props.onSelectAgentTab}
    />
  )
  const details = <DetailsPanel {...props} writes={writes} openField={fields.open} />
  const artifactList = (
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
  )

  let body: ReactNode
  if (wide) {
    const right = segment === 'artifacts' ? 'artifacts' : 'details'
    body = (
      <View style={styles.panes}>
        <View style={[styles.pane, styles.agentPane]} testID="pane-agent">
          {agent}
        </View>
        <View style={[styles.pane, styles.sidePane]} testID="pane-side">
          {segments(['details', 'artifacts'])}
          {right === 'details' ? details : artifactList}
        </View>
      </View>
    )
  } else {
    body = (
      <>
        {segments(TASK_SEGMENTS)}
        <View style={styles.flex}>
          {segment === 'agent' ? agent : segment === 'details' ? details : artifactList}
        </View>
      </>
    )
  }

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
        <Pressable
          onPress={() => setMenu(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Task actions"
          testID="task-menu"
          style={styles.iconButton}
        >
          <Text style={styles.iconGlyph}>⋯</Text>
        </Pressable>
      </View>
      <TitleBlock
        row={row}
        writes={writes}
        feed={props.feed}
        showHub={props.showHub}
        openField={fields.open}
      />
      {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
      {body}
      {fields.sheets}
      <TaskMenu
        visible={menu}
        writes={writes}
        onDeleted={props.onDeleted}
        onClose={() => setMenu(false)}
      />
    </View>
  )
}

function TitleBlock({
  row,
  writes,
  feed,
  showHub,
  openField
}: {
  row: TaskRow
  writes: TaskWrites
  feed: HubFeed
  showHub: boolean
  openField: (field: TaskField) => void
}) {
  const styles = makeStyles(useTheme())
  const { task } = writes
  const look = statusCategoryOf(task.status, row.project)
  const model = cardModel(feed, task, row.project)
  return (
    <View style={styles.titleBlock}>
      <View style={styles.titleRow}>
        <Pressable
          onPress={() => openField('status')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Status: ${look.label}`}
          testID="task-status-icon"
          style={styles.statusButton}
        >
          <StatusIcon category={look.category} tone={look.tone} size={18} />
        </Pressable>
        <TitleInput writes={writes} />
      </View>
      <View style={styles.meta}>
        <Pressable
          onPress={() => openField('priority')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Priority: ${priorityLabel(task.priority)}`}
          style={styles.metaChip}
        >
          <PriorityIcon priority={task.priority} />
          <Text style={styles.metaText}>{priorityLabel(task.priority)}</Text>
        </Pressable>
        <TagPills tags={model.tags} />
        {task.due_date ? (
          <Pressable
            onPress={() => openField('due')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Due ${task.due_date}`}
            style={[styles.metaChip, model.overdue && styles.overdue]}
          >
            <Text style={[styles.metaText, model.overdue && styles.overdueText]}>
              {task.due_date}
            </Text>
          </Pressable>
        ) : null}
        {model.blocked ? <Text style={styles.blocked}>Blocked</Text> : null}
        {task.archived_at ? <Text style={styles.metaText}>Archived</Text> : null}
        {showHub ? <Text style={styles.metaText}>{row.hubLabel}</Text> : null}
      </View>
    </View>
  )
}

/** Desktop's Settings panel: description, sub-tasks, then the details list. */
function DetailsPanel({
  row,
  feed,
  writes,
  openField,
  onOpenTask
}: TaskPageProps & { writes: TaskWrites; openField: (field: TaskField) => void }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const ui = editStyles(theme)
  const board = feed.board.data
  const { task } = writes
  const shownRow = { ...row, task }
  const detail = (label: string, value: string, field: TaskField) => (
    <Pressable
      onPress={() => openField(field)}
      accessibilityRole="button"
      testID={`task-${field}`}
      style={ui.detailRow}
    >
      <Text style={ui.detailLabel}>{label}</Text>
      <Text style={ui.detailValue} numberOfLines={1}>
        {value} ▾
      </Text>
    </Pressable>
  )
  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.details}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      testID="task-details"
    >
      <View style={ui.card}>
        <DescriptionSection row={shownRow} />
      </View>
      {board ? (
        <View style={ui.card}>
          <SubtasksSection row={shownRow} board={board} writes={writes} onOpenTask={onOpenTask} />
        </View>
      ) : null}
      <View style={[ui.card, styles.detailsCard]}>
        <Text style={ui.heading}>Details</Text>
        <View>
          {detail('Status', statusLabel(task.status, row.project), 'status')}
          {detail('Priority', priorityLabel(task.priority), 'priority')}
          {detail('Due', dueLabel(task.due_date ?? null, todayISO()), 'due')}
        </View>
        {board ? (
          <>
            <View style={styles.subsection}>
              <TagsSection row={shownRow} board={board} writes={writes} />
            </View>
            <View style={styles.subsection}>
              <BlockersSection row={shownRow} board={board} writes={writes} />
            </View>
          </>
        ) : null}
        <View style={styles.subsection}>
          <TaskComputer row={shownRow} />
        </View>
      </View>
    </ScrollView>
  )
}

function TaskMenu({
  visible,
  writes,
  onDeleted,
  onClose
}: {
  visible: boolean
  writes: TaskWrites
  onDeleted: () => void
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const client = useTRPCClient()
  const actions = useTaskActions(writes, onDeleted)
  const item = (label: string, onPress: () => void, destructive = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      onPress={() => {
        onClose()
        onPress()
      }}
      style={styles.menuRow}
    >
      <Text style={[styles.menuText, destructive && styles.menuDestructive]}>{label}</Text>
    </Pressable>
  )
  return (
    <BottomSheet visible={visible} onClose={onClose} testID="task-menu-sheet">
      {writes.task.needs_attention
        ? null
        : item(
            'Mark as unread',
            () =>
              void writes.run(() =>
                client.task.update.mutate({ id: writes.task.id, needsAttention: true })
              )
          )}
      {item(actions.archived ? 'Unarchive' : 'Archive', actions.toggleArchive)}
      {item('Delete', actions.remove, true)}
    </BottomSheet>
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
    iconButton: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    iconGlyph: { fontSize: 16, color: t.mutedForeground },
    titleBlock: { paddingHorizontal: 16, paddingBottom: 6, gap: 8 },
    titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    statusButton: { paddingTop: 4 },
    meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    metaChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: t.surface2
    },
    metaText: { fontSize: 12, color: t.mutedForeground },
    overdue: { borderWidth: 1, borderColor: t.destructive },
    overdueText: { color: t.destructive, fontWeight: '600' },
    blocked: {
      fontSize: 11,
      fontWeight: '600',
      color: t.warningForeground,
      borderWidth: 1,
      borderColor: t.warning,
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 1,
      overflow: 'hidden'
    },
    error: { color: t.destructive, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
    segments: {
      flexDirection: 'row',
      marginHorizontal: 14,
      marginVertical: 6,
      padding: 2,
      borderRadius: 10,
      backgroundColor: t.surface2
    },
    segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
    segmentOn: { backgroundColor: t.surface3 },
    segmentText: { fontSize: 13, fontWeight: '600', color: t.mutedForeground },
    segmentTextOn: { color: t.foreground },
    details: { padding: 14, gap: 12, paddingBottom: 48 },
    detailsCard: { gap: 6 },
    subsection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      paddingTop: 10,
      marginTop: 2
    },
    panes: { flex: 1, flexDirection: 'row', gap: 10, padding: 10 },
    pane: {
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      overflow: 'hidden'
    },
    agentPane: { flex: 3 },
    sidePane: { flex: 2 },
    menuRow: {
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    menuText: { fontSize: 16, color: t.foreground },
    menuDestructive: { color: t.destructive }
  })
