import type { ColumnConfig } from '@slayzone/tasks/board'
import { PRIORITY_LABELS } from '@slayzone/tasks/board'
import { type Ref, useRef, useState } from 'react'
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type HostInstance,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import type { BoardTask } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'

/** How far a card must travel sideways to change its status. */
export const SWIPE_THRESHOLD = 80
/** Sideways movement that starts a swipe (and wins over a vertical scroll). */
const SWIPE_START = 12

export interface CardMoves {
  /** Swipe left / the "Move to <next>" action. */
  next: ColumnConfig | null
  /** Swipe right / the "Move to <previous>" action. */
  prev: ColumnConfig | null
  onStatus: (status: string) => void
  /** Move one place up/down in its column; absent = not reorderable here. */
  onStep?: (delta: -1 | 1) => void
}

/**
 * A task on the board (kanban card, list or tree row). Tap opens it. Swipe left moves
 * it to the next status of its project, swipe right to the previous one (what it will
 * become shows underneath while swiping). Long-press starts a drag (`onLongPress`, with
 * where the finger is). The same moves are accessibility actions (VoiceOver: Move to …,
 * Move up/down).
 */
export function TaskCard({
  task,
  depth = 0,
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
  /** Tree view: the subtask level (indents the row). */
  depth?: number
  /** The line under the title (e.g. the hub, with several). */
  meta?: string | null
  moves: CardMoves
  /** This card is the one being dragged (dimmed in place). */
  dragging?: boolean
  /** Shown beside the board (iPad). */
  selected?: boolean
  /** Where the board measures the card for drops. */
  measureRef?: Ref<HostInstance>
  variant: 'card' | 'row'
  onPress: () => void
  onLongPress?: (point: { x: number; y: number }) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const start = useRef({ x: 0, y: 0 })
  const [dx, setDx] = useState(0)

  const target = dx < 0 ? moves.next : dx > 0 ? moves.prev : null
  const armed = Math.abs(dx) >= SWIPE_THRESHOLD && target !== null

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

  const sideways = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.pageX - start.current.x
    const y = e.nativeEvent.pageY - start.current.y
    return { x, y }
  }

  const priority = task.priority <= 2 ? PRIORITY_LABELS[task.priority] : null
  const due = task.due_date ? `Due ${task.due_date}` : null
  const line = [priority, due, meta].filter(Boolean).join(' · ')

  return (
    <View
      style={[styles.wrap, variant === 'card' ? styles.wrapCard : styles.wrapRow]}
      onTouchStart={(e) => {
        start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }
      }}
      onMoveShouldSetResponder={(e) => {
        const { x, y } = sideways(e)
        if (Math.abs(x) < SWIPE_START || Math.abs(x) < 2 * Math.abs(y)) return false
        return (x < 0 ? moves.next : moves.prev) !== null
      }}
      onResponderTerminationRequest={() => false}
      onResponderMove={(e) => setDx(sideways(e).x)}
      onResponderRelease={() => {
        if (armed && target) moves.onStatus(target.id)
        setDx(0)
      }}
      onResponderTerminate={() => setDx(0)}
      testID={`task-card-${task.id}`}
    >
      {dx !== 0 ? (
        <View
          style={[
            styles.under,
            dx < 0 ? styles.underNext : styles.underPrev,
            armed && styles.armed
          ]}
        >
          <Text style={[styles.underText, armed && styles.armedText]}>
            {target ? (dx < 0 ? `${target.label} ›` : `‹ ${target.label}`) : ''}
          </Text>
        </View>
      ) : null}
      <Pressable
        ref={measureRef}
        testID={`task-${task.id}`}
        onPress={onPress}
        onLongPress={
          onLongPress
            ? (e) => onLongPress({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
            : undefined
        }
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={task.title}
        accessibilityActions={actions}
        onAccessibilityAction={onAction}
        style={[
          variant === 'card' ? styles.card : styles.row,
          { transform: [{ translateX: dx }], paddingLeft: 12 + depth * 18 },
          selected && styles.selected,
          dragging && styles.dragging
        ]}
        accessibilityState={{ selected }}
      >
        <Text style={styles.title} numberOfLines={3}>
          {task.title}
        </Text>
        {line ? (
          <Text style={styles.meta} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </Pressable>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    wrap: { position: 'relative' },
    wrapCard: { marginHorizontal: 8, marginBottom: 8 },
    wrapRow: {},
    card: {
      backgroundColor: t.card,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingVertical: 10,
      paddingRight: 12
    },
    row: {
      backgroundColor: t.background,
      paddingVertical: 12,
      paddingRight: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    dragging: { opacity: 0.35 },
    selected: { backgroundColor: t.accent },
    title: { fontSize: 15, color: t.foreground },
    meta: { fontSize: 12, color: t.mutedForeground, marginTop: 3 },
    under: {
      ...StyleSheet.absoluteFill,
      borderRadius: 10,
      justifyContent: 'center',
      paddingHorizontal: 16,
      backgroundColor: t.muted
    },
    underNext: { alignItems: 'flex-end' },
    underPrev: { alignItems: 'flex-start' },
    armed: { backgroundColor: t.primary },
    underText: { fontSize: 14, fontWeight: '600', color: t.mutedForeground },
    armedText: { color: t.primaryForeground }
  })
