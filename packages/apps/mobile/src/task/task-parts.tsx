/**
 * The parts of a task's page that show it rather than its agent, shared by the iPad's
 * task page (beside the agent) and the phone's Details / Artifacts sheet (`TaskInfoSheet`):
 *
 * - `TitleBlock`: the status icon (tap: change status), the title (edit in place), and
 *   under it priority, tags, due date (tap priority or due to change them), blocked,
 *   archived, the hub;
 * - `PartSegments`: the segmented control between the parts shown (Details, Artifacts —
 *   with how many);
 * - `DetailsPanel`: desktop's Settings panel — description, sub-tasks, the details list;
 * - `TaskMenu`: the task's ⋯ (keep a temporary task, mark unread, archive, delete);
 * - `KeptPart`: a part kept mounted while another is shown.
 */
import { keepScratchTaskInput, todayISO } from '@slayzone/tasks/board'
import type { ColumnConfig } from '@slayzone/workflow'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { cardModel, statusCategoryOf } from '../board/card-model'
import { TaskComputer } from '../computers/TaskComputer'
import type { HubFeed, TaskRow } from '../hub-board'
import { DescriptionSection } from '../task-edit/DescriptionSection'
import { dueLabel, priorityLabel, statusLabel } from '../task-edit/fields'
import { BlockersSection, SubtasksSection, TagsSection } from '../task-edit/OrganiseSections'
import { useTaskActions } from '../task-edit/TaskActions'
import { type TaskField, TitleInput } from '../task-edit/TaskFields'
import { makeStyles as editStyles } from '../task-edit/ui'
import type { TaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { BottomSheet } from '../ui-kit/Chrome'
import { PriorityIcon, StatusIcon, TagPills } from '../ui-kit/TaskGlyphs'

/**
 * A part of the page kept mounted while hidden: laid out in place (its views keep their
 * size — a terminal is never resized to nothing), but transparent, untouchable and
 * hidden from VoiceOver.
 */
export function KeptPart({
  shown,
  testID,
  children
}: {
  shown: boolean
  testID: string
  children: ReactNode
}) {
  const styles = makeStyles(useTheme())
  return (
    <View
      style={[StyleSheet.absoluteFill, !shown && styles.hiddenPart]}
      pointerEvents={shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      testID={testID}
    >
      {children}
    </View>
  )
}

/** A segmented control: one segment per part, the shown one selected. */
export function PartSegments<Part extends string>({
  parts,
  shown,
  labelOf,
  onShow
}: {
  parts: readonly Part[]
  shown: Part
  labelOf: (part: Part) => string
  onShow: (part: Part) => void
}) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.segments} accessibilityRole="tablist">
      {parts.map((part) => {
        const on = part === shown
        return (
          <Pressable
            key={part}
            onPress={() => onShow(part)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            testID={`segment-${part}`}
            hitSlop={SEGMENT_SLOP}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{labelOf(part)}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** A segment (36pt) reaches 44pt to a finger. */
const SEGMENT_SLOP = { top: 4, bottom: 4 }

/** "Artifacts", or "Artifacts 3" once the task has some. */
export function artifactsLabel(count: number | undefined): string {
  return count ? `Artifacts ${count}` : 'Artifacts'
}

export function TitleBlock({
  row,
  writes,
  feed,
  showHub,
  openField,
  trailing
}: {
  row: TaskRow
  writes: TaskWrites
  feed: HubFeed
  showHub: boolean
  openField: (field: TaskField) => void
  /** Beside the title, at its end (the sheet's ⋯ and Done). */
  trailing?: ReactNode
}) {
  const styles = makeStyles(useTheme())
  const { task } = writes
  const look = statusCategoryOf(task.status, row.project)
  const model = cardModel(feed, task, row.project)
  const due = task.due_date ? dueLabel(task.due_date, todayISO()) : null
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
        {trailing}
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
            accessibilityLabel={due ?? undefined}
            style={[styles.metaChip, model.overdue && styles.overdue]}
          >
            <Text style={[styles.metaText, model.overdue && styles.overdueText]}>{due}</Text>
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
export function DetailsPanel({
  row,
  feed,
  writes,
  openField,
  onOpenTask
}: {
  row: TaskRow
  feed: HubFeed
  writes: TaskWrites
  openField: (field: TaskField) => void
  /** A sub-task was tapped. */
  onOpenTask: (taskId: string) => void
}) {
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
      accessibilityLabel={`${label}, ${value}`}
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

export function TaskMenu({
  visible,
  writes,
  columns,
  onDeleted,
  onClose
}: {
  visible: boolean
  writes: TaskWrites
  /** The task's project's columns ("Keep as task" moves it to the first started one). */
  columns: ColumnConfig[] | null | undefined
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
      {writes.task.is_temporary
        ? item(
            'Keep as task',
            () =>
              void writes.run(() =>
                client.task.update.mutate(keepScratchTaskInput(writes.task.id, columns))
              )
          )
        : null}
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

/** The task's ⋯: a 34pt square reaching 44pt to a finger. */
export function TaskMenuButton({ onPress }: { onPress: () => void }) {
  const styles = makeStyles(useTheme())
  return (
    <Pressable
      onPress={onPress}
      hitSlop={5}
      accessibilityRole="button"
      accessibilityLabel="Task actions"
      testID="task-menu"
      style={styles.iconButton}
    >
      <Text style={styles.iconGlyph}>⋯</Text>
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
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
    segments: {
      flexDirection: 'row',
      marginHorizontal: 14,
      marginVertical: 6,
      padding: 2,
      borderRadius: 10,
      backgroundColor: t.surface2
    },
    segment: {
      flex: 1,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 7,
      borderRadius: 8
    },
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
    hiddenPart: { opacity: 0 },
    menuRow: {
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    menuText: { fontSize: 16, color: t.foreground },
    menuDestructive: { color: t.destructive }
  })
