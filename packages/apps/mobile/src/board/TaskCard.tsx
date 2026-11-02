import type { ColumnConfig } from '@slayzone/tasks/board'
import type { Ref } from 'react'
import {
  type AccessibilityActionEvent,
  type HostInstance,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import type { BoardTask } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { AgentDot, PriorityIcon, StatusIcon, SubtaskRing, TagPills } from '../ui-kit/TaskGlyphs'
import type { CardModel, StatusLook } from './card-model'

export interface CardMoves {
  /** The "Move to <next>" action. */
  next: ColumnConfig | null
  /** The "Move to <previous>" action. */
  prev: ColumnConfig | null
  onStatus: (status: string) => void
  /** Move one place up/down in its column; absent = not reorderable here. */
  onStep?: (delta: -1 | 1) => void
}

/**
 * A task on the board — desktop's `KanbanCard` (kanban) or `KanbanListRow` (list):
 * priority icon, title (3 lines), agent dot; under it the subtask ring, the first tag
 * as a pill and the rest as dots, Blocked, the due date (red when overdue, and the card
 * gets a red border). Tap opens the task; long-press starts a drag (`onLongPress`, with
 * where the finger is). Moves are accessibility actions too (VoiceOver: Move to …,
 * Move up/down).
 */
export function TaskCard({
  task,
  model,
  status,
  meta,
  moves,
  dragging = false,
  selected = false,
  measureRef,
  variant,
  onPress,
  onLongPress
}: {
  task: BoardTask
  model: CardModel
  /** List rows show the status icon first (desktop's list row). */
  status?: StatusLook
  /** A line under the title (e.g. the hub, with several). */
  meta?: string | null
  moves: CardMoves
  /** This card is the one being dragged (dimmed in place). */
  dragging?: boolean
  /** Open beside the board (iPad). */
  selected?: boolean
  /** Where the board measures the card for drops. */
  measureRef?: Ref<HostInstance>
  variant: 'card' | 'row'
  onPress: () => void
  onLongPress?: (point: { x: number; y: number }) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)

  const actions = [
    ...(moves.next ? [{ name: 'next', label: `Move to ${moves.next.label}` }] : []),
    ...(moves.prev ? [{ name: 'prev', label: `Move to ${moves.prev.label}` }] : []),
    ...(moves.onStep
      ? [
          { name: 'up', label: 'Move up' },
          { name: 'down', label: 'Move down' }
        ]
      : [])
  ]
  const onAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName
    if (name === 'next' && moves.next) moves.onStatus(moves.next.id)
    else if (name === 'prev' && moves.prev) moves.onStatus(moves.prev.id)
    else if (name === 'up') moves.onStep?.(-1)
    else if (name === 'down') moves.onStep?.(1)
  }

  const bottom =
    model.subtasks || model.tags.length > 0 || model.blocked || task.due_date ? (
      <View style={styles.bottom}>
        {model.subtasks ? <SubtaskRing {...model.subtasks} /> : null}
        <TagPills tags={model.tags} />
        {model.blocked ? (
          <View style={styles.blocked}>
            <Text style={styles.blockedText}>Blocked</Text>
          </View>
        ) : null}
        {task.due_date ? (
          <View style={[styles.due, model.overdue && styles.dueOver]} testID="card-due">
            <Text style={[styles.dueText, model.overdue && styles.dueTextOver]}>
              {task.due_date}
            </Text>
          </View>
        ) : null}
      </View>
    ) : null

  return (
    <Pressable
      ref={measureRef}
      testID={`task-${task.id}`}
      onPress={onPress}
      onLongPress={
        onLongPress
          ? (e) => onLongPress({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
          : undefined
      }
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityActions={actions}
      onAccessibilityAction={onAction}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        variant === 'card' ? styles.card : styles.row,
        model.overdue && variant === 'card' && styles.overdue,
        selected && styles.selected,
        pressed && styles.pressed,
        dragging && styles.dragging
      ]}
    >
      <View style={styles.top}>
        {status ? (
          <View style={styles.glyph}>
            <StatusIcon category={status.category} tone={status.tone} />
          </View>
        ) : null}
        <View style={styles.glyph}>
          <PriorityIcon priority={task.priority} />
        </View>
        <View style={styles.titleBox}>
          <Text style={styles.title} numberOfLines={variant === 'card' ? 3 : 2}>
            {task.title}
          </Text>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {model.dot ? (
          <View style={styles.dot}>
            <AgentDot kind={model.dot} />
          </View>
        ) : null}
      </View>
      {bottom}
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.surface3,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 11,
      paddingVertical: 12
    },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    overdue: { borderColor: t.destructive, borderWidth: 1 },
    selected: { borderColor: t.primary, borderWidth: 1.5 },
    pressed: { opacity: 0.7 },
    dragging: { opacity: 0.35 },
    top: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
    glyph: { paddingTop: 2 },
    titleBox: { flex: 1 },
    title: { fontSize: 14, fontWeight: '500', lineHeight: 19, color: t.foreground },
    meta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    dot: { paddingTop: 5 },
    bottom: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 8,
      marginTop: 10
    },
    blocked: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: t.warning,
      paddingHorizontal: 7,
      paddingVertical: 1
    },
    blockedText: { fontSize: 11, fontWeight: '600', color: t.warningForeground },
    due: {
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 7,
      paddingVertical: 1
    },
    dueOver: { borderColor: t.destructive },
    dueText: { fontSize: 11, color: t.mutedForeground },
    dueTextOver: { color: t.destructive, fontWeight: '600' }
  })
