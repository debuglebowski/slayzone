import { type ReactNode, useRef, useState } from 'react'
import {
  FlatList,
  type HostInstance,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { type BoardProject, type BoardTask, type HubFeed, rowKey, type TaskRow } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import {
  type BoardColumn,
  type BoardFilter,
  boardColumns,
  neighbourStatuses,
  projectStatuses,
  treeColumns
} from './board-model'
import type { BoardView } from './board-prefs'
import { type DropTargets, dropTarget, type Rect } from './drag'
import { planDrop, planStatusChange } from './moves'
import { type CardMoves, TaskCard } from './TaskCard'
import { useBoardMoves } from './use-board-moves'

/** Measures a view in window coordinates (null = not on screen). Injected by tests. */
export type Measure = (view: HostInstance) => Promise<Rect | null>

export const measureInWindow: Measure = (view) =>
  new Promise((resolve) => {
    view.measureInWindow((x, y, width, height) =>
      resolve(width > 0 || height > 0 ? { x, y, width, height } : null)
    )
  })

/** A kanban column's width when columns sit side by side (iPad). */
export const COLUMN_WIDTH = 290

interface Drag {
  taskId: string
  title: string
  fromColumn: string
  point: { x: number; y: number }
  /** Measured once the drag starts; null = still measuring. */
  targets: DropTargets | null
  /** The board's own window position (for the dragged card's ghost). */
  origin: { x: number; y: number }
}

type Registered = { kind: 'column'; id: string } | { kind: 'row'; id: string; columnId: string }

/**
 * The views a drag can land on, kept by their ref callbacks (mounted = registered) and
 * read when a drag starts. A closure over its own map, not a ref: render only creates
 * the callbacks, it never reads what they keep.
 */
function createTargetRegistry() {
  const views = new Map<string, { info: Registered; view: HostInstance }>()
  return {
    register:
      (key: string, info: Registered) =>
      (node: HostInstance | null): void => {
        if (node) views.set(key, { info, view: node })
        else views.delete(key)
      },
    entries: () => [...views.values()]
  }
}

/**
 * One project's board, inside the `HubScope` of the hub that owns it (every write goes
 * there, `useBoardMoves`). Views: kanban (iPad: the columns side by side; phone: one
 * column at a time, picked from a strip of column chips — a horizontal page swipe would
 * fight the card swipe that changes status), list (every column as a section) and tree
 * (list + subtasks nested; no drag: a drop there would mean re-parenting). Long-press a
 * card or row, then drag: within a column it reorders, onto another column (or, on a
 * phone, onto its chip) it moves there.
 */
export function ProjectBoard({
  feed,
  project,
  view,
  filter,
  wide,
  severalHubs,
  selectedTaskId,
  measure = measureInWindow,
  onOpen,
  onNewTask,
  onRefresh
}: {
  feed: HubFeed
  project: BoardProject
  view: BoardView
  filter: BoardFilter
  /** iPad: kanban columns side by side. */
  wide: boolean
  severalHubs: boolean
  selectedTaskId?: string
  measure?: Measure
  onOpen: (row: TaskRow) => void
  /** "+" of a column: a new task with that status. */
  onNewTask: (status: string) => void
  onRefresh: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const move = useBoardMoves()
  const data = feed.board.data
  const [activeColumn, setActiveColumn] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [targets] = useState(createTargetRegistry)
  const rootRef = useRef<HostInstance>(null)

  if (!data) return null
  const columns =
    view === 'tree'
      ? treeColumns(data, project, filter).map(({ nodes, ...c }) => ({
          ...c,
          tasks: nodes.map((n) => n.task),
          depth: new Map(nodes.map((n) => [n.task.id, n.depth]))
        }))
      : boardColumns(data, project, filter).map((c) => ({ ...c, depth: null }))
  const statusLabel = new Map(projectStatuses(project).map((c) => [c.id, c.label]))
  const visibleOf = (columnId: string): string[] =>
    columns.find((c) => c.id === columnId)?.tasks.map((t) => t.id) ?? []

  const register = targets.register

  const rowOf = (task: BoardTask): TaskRow => ({
    key: rowKey(feed.hub.id, task.id),
    hubId: feed.hub.id,
    hubLabel: feed.hub.label,
    task,
    project
  })

  const canDrag = view !== 'tree'

  const startDrag = (task: BoardTask, fromColumn: string, point: { x: number; y: number }) => {
    setDrag({ taskId: task.id, title: task.title, fromColumn, point, targets: null, origin: point })
    const entries = targets.entries()
    const root = rootRef.current
    void Promise.all([
      root ? measure(root) : Promise.resolve(null),
      ...entries.map((e) => measure(e.view))
    ]).then(([rootRect, ...rects]) => {
      const targets: DropTargets = { columns: [], rows: [] }
      entries.forEach(({ info }, i) => {
        const rect = rects[i]
        if (!rect) return
        if (info.kind === 'column')
          (targets.columns as { id: string; rect: Rect }[]).push({ id: info.id, rect })
        else
          (targets.rows as { taskId: string; columnId: string; rect: Rect }[]).push({
            taskId: info.id,
            columnId: info.columnId,
            rect
          })
      })
      const origin = rootRect ? { x: rootRect.x, y: rootRect.y } : { x: 0, y: 0 }
      setDrag((d) => (d && d.taskId === task.id ? { ...d, targets, origin } : d))
    })
  }

  const endDrag = () => {
    const d = drag
    setDrag(null)
    if (!d?.targets) return
    const at = dropTarget(d.targets, d.point)
    if (!at) return
    const plan = planDrop(
      data,
      project.id,
      {
        taskId: d.taskId,
        fromColumn: d.fromColumn,
        toColumn: at.column,
        beforeTaskId: at.beforeTaskId
      },
      visibleOf(at.column)
    )
    if (plan) void move(plan)
  }

  const movesOf = (task: BoardTask, column: BoardColumn): CardMoves => {
    const { prev, next } = neighbourStatuses(project, task.status)
    const ids = column.tasks.map((t) => t.id)
    const i = ids.indexOf(task.id)
    return {
      prev,
      next,
      onStatus: (status) => void move(planStatusChange(task.id, status)),
      onStep: canDrag
        ? (delta) => {
            const before = delta < 0 ? ids[i - 1] : (ids[i + 2] ?? null)
            if (delta < 0 && before === undefined) return
            if (delta > 0 && i === ids.length - 1) return
            const plan = planDrop(
              data,
              project.id,
              { taskId: task.id, fromColumn: column.id, toColumn: column.id, beforeTaskId: before },
              ids
            )
            if (plan) void move(plan)
          }
        : undefined
    }
  }

  const card = (
    task: BoardTask,
    column: BoardColumn & { depth: Map<string, number> | null },
    variant: 'card' | 'row'
  ) => (
    <TaskCard
      key={task.id}
      task={task}
      variant={variant}
      depth={column.depth?.get(task.id) ?? 0}
      meta={[
        (column.depth?.get(task.id) ?? 0) > 0
          ? (statusLabel.get(task.status) ?? task.status)
          : null,
        severalHubs ? feed.hub.label : null
      ]
        .filter(Boolean)
        .join(' · ')}
      selected={task.id === selectedTaskId}
      moves={movesOf(task, column)}
      dragging={drag?.taskId === task.id}
      measureRef={register(`row:${column.id}:${task.id}`, {
        kind: 'row',
        id: task.id,
        columnId: column.id
      })}
      onPress={() => onOpen(rowOf(task))}
      onLongPress={canDrag ? (point) => startDrag(task, column.id, point) : undefined}
    />
  )

  const columnHead = (column: BoardColumn) => (
    <View style={styles.columnHead}>
      <Text style={styles.columnTitle} numberOfLines={1}>
        {column.title}
      </Text>
      <Text style={styles.count}>{column.tasks.length}</Text>
      {column.id.startsWith('__') ? null : (
        <Pressable
          onPress={() => onNewTask(column.id)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`New task in ${column.title}`}
          testID={`new-task-${column.id}`}
        >
          <Text style={styles.plus}>+</Text>
        </Pressable>
      )}
    </View>
  )

  const refresh = <RefreshControl refreshing={feed.board.refreshing} onRefresh={onRefresh} />
  const scrolls = drag === null

  let body: ReactNode
  if (view === 'kanban' && wide) {
    body = (
      <ScrollView horizontal scrollEnabled={scrolls} contentContainerStyle={styles.columns}>
        {columns.map((column) => (
          <View
            key={column.id}
            style={styles.column}
            ref={register(`column:${column.id}`, { kind: 'column', id: column.id })}
            testID={`column-${column.id}`}
          >
            {columnHead(column)}
            <ScrollView scrollEnabled={scrolls} contentContainerStyle={styles.columnBody}>
              {column.tasks.length === 0 ? <Text style={styles.empty}>No tasks</Text> : null}
              {column.tasks.map((t) => card(t, column, 'card'))}
            </ScrollView>
          </View>
        ))}
      </ScrollView>
    )
  } else if (view === 'kanban') {
    // Until one is picked: the first column with tasks in it.
    const shown =
      columns.find((c) => c.id === activeColumn) ??
      columns.find((c) => c.tasks.length > 0) ??
      columns[0]
    body = (
      <View style={styles.flex}>
        <ScrollView
          horizontal
          scrollEnabled={scrolls}
          showsHorizontalScrollIndicator={false}
          style={styles.chips}
          contentContainerStyle={styles.chipsContent}
        >
          {columns.map((column) => {
            const active = column.id === shown?.id
            return (
              <Pressable
                key={column.id}
                ref={register(`chip:${column.id}`, { kind: 'column', id: column.id })}
                onPress={() => setActiveColumn(column.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                testID={`column-chip-${column.id}`}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {column.title} {column.tasks.length}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
        {shown ? (
          <View
            style={styles.flex}
            ref={register(`column:${shown.id}`, { kind: 'column', id: shown.id })}
            testID={`column-${shown.id}`}
          >
            {columnHead(shown)}
            <FlatList
              data={shown.tasks}
              keyExtractor={(t) => t.id}
              scrollEnabled={scrolls}
              refreshControl={refresh}
              contentContainerStyle={styles.columnBody}
              ListEmptyComponent={<Text style={styles.empty}>No tasks</Text>}
              renderItem={({ item }) => card(item, shown, 'card')}
            />
          </View>
        ) : null}
      </View>
    )
  } else {
    body = (
      <ScrollView scrollEnabled={scrolls} refreshControl={refresh}>
        {columns.map((column) => (
          <View
            key={column.id}
            ref={register(`column:${column.id}`, { kind: 'column', id: column.id })}
            testID={`column-${column.id}`}
          >
            <View style={styles.section}>{columnHead(column)}</View>
            {column.tasks.map((t) => card(t, column, 'row'))}
          </View>
        ))}
      </ScrollView>
    )
  }

  return (
    <View
      ref={rootRef}
      style={styles.flex}
      testID="project-board"
      onMoveShouldSetResponderCapture={() => drag !== null}
      onResponderTerminationRequest={() => false}
      onResponderMove={(e) => {
        const point = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }
        setDrag((d) => (d ? { ...d, point } : d))
      }}
      onResponderRelease={endDrag}
      onResponderTerminate={() => setDrag(null)}
    >
      {body}
      {drag ? (
        <View
          pointerEvents="none"
          style={[
            styles.ghost,
            { left: drag.point.x - drag.origin.x - 20, top: drag.point.y - drag.origin.y - 20 }
          ]}
        >
          <Text style={styles.ghostText} numberOfLines={2}>
            {drag.title}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    columns: { padding: 8, gap: 8 },
    column: {
      width: COLUMN_WIDTH,
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    columnBody: { paddingBottom: 16 },
    columnHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10
    },
    columnTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: t.foreground },
    count: { flex: 1, fontSize: 13, color: t.mutedForeground },
    plus: { fontSize: 22, lineHeight: 24, color: t.foreground },
    section: {
      backgroundColor: t.surface1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    empty: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    chips: {
      flexGrow: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    chipsContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1
    },
    chipActive: { backgroundColor: t.primary, borderColor: t.primary },
    chipText: { fontSize: 13, color: t.foreground },
    chipTextActive: { color: t.primaryForeground },
    ghost: {
      position: 'absolute',
      width: 240,
      padding: 12,
      borderRadius: 10,
      backgroundColor: t.popover,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.ring,
      opacity: 0.95
    },
    ghostText: { fontSize: 15, color: t.popoverForeground }
  })
