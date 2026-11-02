import { columnToCreateTaskDraft } from '@slayzone/tasks/board'
import { type ReactNode, useRef, useState } from 'react'
import {
  FlatList,
  type HostInstance,
  Pressable,
  type ScrollViewInstance,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { type BoardProject, type BoardTask, type HubFeed, rowKey, type TaskRow } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { Pill } from '../ui-kit/Chrome'
import { PriorityIcon, StatusIcon } from '../ui-kit/TaskGlyphs'
import {
  type BoardColumn,
  type BoardFilter,
  boardColumns,
  displayGroup,
  neighbourStatuses,
  projectStatuses,
  treeColumns
} from './board-model'
import type { BoardView } from './board-prefs'
import { aliveTaskIds, cardModel, statusCategoryOf } from './card-model'
import { type DropTargets, dropTarget, type Rect } from './drag'
import { dragAllowed, type Grouping, planDrop, planStatusChange, reorderAllowed } from './moves'
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

/** A kanban column's width when columns sit side by side (iPad; desktop's w-72). */
export const COLUMN_WIDTH = 288
/** How close to a phone's edge a dragged card turns the page to the next column. */
const EDGE = 28
/** Room under the last card for the floating ＋ (iOS content inset). */
const FAB_ROOM = { top: 0, left: 0, right: 0, bottom: 76 }

interface Drag {
  taskId: string
  title: string
  fromColumn: string
  point: { x: number; y: number }
  /** Measured once the drag starts (again after a page turn); null = still measuring. */
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

type ShownColumn = BoardColumn & { depth: Map<string, number> | null }

/** What the floating ＋ starts a task with (desktop's `columnToCreateTaskDraft`). */
export interface NewTaskDraft {
  status?: string
  priority?: number
  dueDate?: string
}

/**
 * One project's board, inside the `HubScope` of the hub that owns it (every write goes
 * there, `useBoardMoves`) — desktop's board. Views:
 *
 * - kanban, iPad (`wide`): every column side by side (desktop's w-72 columns);
 * - kanban, phone: one column at a time, a page each — swipe sideways, or tap a column
 *   in the strip above (the only column navigation: status icon, name, count; the
 *   shown one highlighted and kept in view);
 * - list: every column as a section of rows (desktop's list view);
 * - tree (iPad only): the list with subtasks nested; no drag (a drop would re-parent).
 *
 * The columns are the Display options' groups (`filter.groupBy`: status, priority, due
 * date; the list also "No groups", "Activity"), sorted as they say (`filter.sortBy`).
 *
 * Long-press a card, then drag: within a column it reorders, onto another column (on a
 * phone: onto its pill in the strip, or to the screen's edge to turn the page) it moves
 * there — its status or priority (`planDrop`). As on desktop: no drag in due-date groups,
 * a reorder sticks only in Manual order (or Priority order, among the same priority).
 * `activeColumn`: the phone's page, kept by the screen across re-renders.
 *
 * A floating ＋ (bottom right) creates a task — on a phone's board in the shown column
 * (its status, priority or due date).
 */
export function ProjectBoard({
  feed,
  project,
  view,
  filter,
  wide,
  selectedTaskId,
  initialColumn,
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
  selectedTaskId?: string
  /** Phone: the column to show first (a link's `column`); else the first with tasks. */
  initialColumn?: string
  measure?: Measure
  onOpen: (row: TaskRow) => void
  /** The floating ＋: a new task, with the shown column's fields (phone board) if any. */
  onNewTask: (draft: NewTaskDraft) => void
  onRefresh: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const move = useBoardMoves()
  const { width: windowWidth } = useWindowDimensions()
  const data = feed.board.data
  const [activeColumn, setActiveColumn] = useState<string | null>(initialColumn ?? null)
  // A link asking for a column shows it, also when the board is already open
  // (render-time sync; the pager is keyed by it, so it opens at that page).
  const [linkedColumn, setLinkedColumn] = useState(initialColumn)
  if (initialColumn !== linkedColumn) {
    setLinkedColumn(initialColumn)
    if (initialColumn) setActiveColumn(initialColumn)
  }
  const [pageWidth, setPageWidth] = useState(windowWidth)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [targets] = useState(createTargetRegistry)
  const rootRef = useRef<HostInstance>(null)
  const pagerRef = useRef<ScrollViewInstance>(null)
  const stripRef = useRef<ScrollViewInstance>(null)
  // Where each chip sits in the strip, and the strip's width (to keep the shown chip in view).
  const chipFrames = useRef(new Map<string, { x: number; width: number }>())
  const stripWidth = useRef(0)
  // The edge a drag last turned the page at (one turn per visit to an edge).
  const turnedAt = useRef<'left' | 'right' | null>(null)

  if (!data) return null
  const activeTaskIds = aliveTaskIds(feed)
  const grouping: Grouping = {
    groupBy: displayGroup(view, filter.groupBy),
    sortBy: filter.sortBy,
    activeTaskIds
  }
  const columns: ShownColumn[] =
    view === 'tree' && wide
      ? treeColumns(data, project, filter, { activeTaskIds }).map(({ nodes, ...c }) => ({
          ...c,
          tasks: nodes.map((n) => n.task),
          depth: new Map(nodes.map((n) => [n.task.id, n.depth]))
        }))
      : boardColumns(data, project, filter, { view, activeTaskIds }).map((c) => ({
          ...c,
          depth: null
        }))
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

  const canDrag = !(view === 'tree' && wide) && dragAllowed(grouping.groupBy)
  const canReorder = canDrag && reorderAllowed(grouping.sortBy)
  const phonePages = view === 'kanban' && !wide
  const shownIndex = Math.max(
    0,
    columns.findIndex((c) => c.id === activeColumn) >= 0
      ? columns.findIndex((c) => c.id === activeColumn)
      : columns.findIndex((c) => c.tasks.length > 0)
  )
  const shown = columns[shownIndex]

  const measureTargets = (taskId: string) => {
    const entries = targets.entries()
    const root = rootRef.current
    void Promise.all([
      root ? measure(root) : Promise.resolve(null),
      ...entries.map((e) => measure(e.view))
    ]).then(([rootRect, ...rects]) => {
      const found: DropTargets = { columns: [], rows: [] }
      entries.forEach(({ info }, i) => {
        const rect = rects[i]
        if (!rect) return
        if (info.kind === 'column')
          (found.columns as { id: string; rect: Rect }[]).push({ id: info.id, rect })
        else
          (found.rows as { taskId: string; columnId: string; rect: Rect }[]).push({
            taskId: info.id,
            columnId: info.columnId,
            rect
          })
      })
      const origin = rootRect ? { x: rootRect.x, y: rootRect.y } : { x: 0, y: 0 }
      setDrag((d) => (d && d.taskId === taskId ? { ...d, targets: found, origin } : d))
    })
  }

  /** Scrolls the strip so a column's chip is in view (centred when it can be). */
  const revealChip = (columnId: string, animated = true) => {
    const frame = chipFrames.current.get(columnId)
    if (!frame) return
    const x = Math.max(0, frame.x - (stripWidth.current - frame.width) / 2)
    stripRef.current?.scrollTo({ x, animated })
  }

  const showColumn = (columnId: string) => {
    setActiveColumn(columnId)
    revealChip(columnId)
  }

  const goToPage = (index: number, animated = true) => {
    const column = columns[index]
    if (!column) return
    showColumn(column.id)
    pagerRef.current?.scrollTo({ x: index * pageWidth, animated })
  }

  const startDrag = (task: BoardTask, fromColumn: string, point: { x: number; y: number }) => {
    turnedAt.current = null
    setDrag({ taskId: task.id, title: task.title, fromColumn, point, targets: null, origin: point })
    measureTargets(task.id)
  }

  const dragMove = (point: { x: number; y: number }) => {
    setDrag((d) => (d ? { ...d, point } : d))
    if (!drag || !phonePages) return
    const edge = point.x < EDGE ? 'left' : point.x > windowWidth - EDGE ? 'right' : null
    if (edge === null) {
      turnedAt.current = null
      return
    }
    if (turnedAt.current === edge) return
    const next = shownIndex + (edge === 'left' ? -1 : 1)
    if (next < 0 || next >= columns.length) return
    turnedAt.current = edge
    goToPage(next)
    const taskId = drag.taskId
    setTimeout(() => measureTargets(taskId), 350)
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
      visibleOf(at.column),
      grouping
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
      onStep: canReorder
        ? (delta) => {
            const before = delta < 0 ? ids[i - 1] : (ids[i + 2] ?? null)
            if (delta < 0 && before === undefined) return
            if (delta > 0 && i === ids.length - 1) return
            const plan = planDrop(
              data,
              project.id,
              { taskId: task.id, fromColumn: column.id, toColumn: column.id, beforeTaskId: before },
              ids,
              grouping
            )
            if (plan) void move(plan)
          }
        : undefined
    }
  }

  const card = (task: BoardTask, column: ShownColumn, variant: 'card' | 'row') => {
    const depth = column.depth?.get(task.id) ?? 0
    return (
      <View key={task.id} style={depth > 0 ? { paddingLeft: depth * 18 } : undefined}>
        <TaskCard
          task={task}
          model={cardModel(feed, task, project)}
          status={variant === 'row' ? statusCategoryOf(task.status, project) : undefined}
          variant={variant}
          meta={depth > 0 ? (statusLabel.get(task.status) ?? task.status) : null}
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
      </View>
    )
  }

  /** A column's icon: its status's, or its priority's; none for the other groups. */
  const columnIcon = (column: BoardColumn, size?: number) => {
    if (column.id.startsWith('__')) return null
    if (grouping.groupBy === 'status') {
      const look = statusCategoryOf(column.id, project)
      return <StatusIcon category={look.category} tone={look.tone} size={size} />
    }
    const p = grouping.groupBy === 'priority' ? /^p([1-5])$/.exec(column.id) : null
    return p ? <PriorityIcon priority={Number(p[1])} size={size} /> : null
  }

  const columnHead = (column: BoardColumn) => {
    return (
      <View style={styles.columnHead}>
        {columnIcon(column)}
        <Text style={styles.columnTitle} numberOfLines={1}>
          {column.title}
        </Text>
        <View style={styles.count}>
          <Text style={styles.countText}>{column.tasks.length}</Text>
        </View>
      </View>
    )
  }

  const empty = <Text style={styles.empty}>No tasks</Text>
  const refresh = (
    <RefreshControl
      tintColor={theme.foreground}
      refreshing={feed.board.refreshing}
      onRefresh={onRefresh}
    />
  )
  const scrolls = drag === null
  // The phone's board creates in the shown column (its status, priority or due date);
  // the list and the iPad have no single column (the project's defaults).
  const newTaskColumn = phonePages && shown && !shown.id.startsWith('__') ? shown : null
  const created = newTaskColumn
    ? columnToCreateTaskDraft({ ...newTaskColumn, tasks: [] }, grouping.groupBy)
    : {}
  const newTaskDraft: NewTaskDraft = {
    status: created.status,
    priority: created.priority,
    dueDate: created.dueDate ?? undefined
  }

  let body: ReactNode
  if (view !== 'list' && wide) {
    body = (
      <ScrollView horizontal scrollEnabled={scrolls} contentContainerStyle={styles.columns}>
        {columns.map((column) => (
          <View
            key={column.id}
            style={styles.wideColumn}
            ref={register(`column:${column.id}`, { kind: 'column', id: column.id })}
            testID={`column-${column.id}`}
          >
            {columnHead(column)}
            <ScrollView
              scrollEnabled={scrolls}
              contentInset={FAB_ROOM}
              scrollIndicatorInsets={FAB_ROOM}
              style={styles.columnBody}
              contentContainerStyle={styles.columnBodyContent}
            >
              {column.tasks.length === 0 ? empty : null}
              {column.tasks.map((t) => card(t, column, view === 'tree' ? 'row' : 'card'))}
            </ScrollView>
          </View>
        ))}
      </ScrollView>
    )
  } else if (phonePages) {
    body = (
      <View style={styles.flex}>
        <ScrollView
          ref={stripRef}
          horizontal
          scrollEnabled={scrolls}
          showsHorizontalScrollIndicator={false}
          style={styles.strip}
          contentContainerStyle={styles.stripContent}
          accessibilityRole="tablist"
          onLayout={(e) => {
            stripWidth.current = e.nativeEvent.layout.width
          }}
        >
          {columns.map((column, index) => {
            const active = column.id === shown?.id
            const n = column.tasks.length
            return (
              <View
                key={column.id}
                ref={register(`chip:${column.id}`, { kind: 'column', id: column.id })}
                testID={`column-drop-${column.id}`}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout
                  chipFrames.current.set(column.id, { x, width })
                  if (active) revealChip(column.id, false)
                }}
              >
                <Pill
                  active={active}
                  accessibilityRole="tab"
                  accessibilityLabel={`${column.title}, ${n} ${n === 1 ? 'task' : 'tasks'}`}
                  onPress={() => goToPage(index)}
                  testID={`column-chip-${column.id}`}
                >
                  <View style={styles.chip}>
                    {columnIcon(column, 12)}
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {column.title}{' '}
                      <Text style={active ? styles.chipTextActive : styles.chipCount}>{n}</Text>
                    </Text>
                  </View>
                </Pill>
              </View>
            )
          })}
        </ScrollView>
        <ScrollView
          key={linkedColumn ?? ''}
          ref={pagerRef}
          horizontal
          pagingEnabled
          scrollEnabled={scrolls}
          showsHorizontalScrollIndicator={false}
          style={styles.flex}
          testID="column-pager"
          contentOffset={{ x: shownIndex * pageWidth, y: 0 }}
          onLayout={(e) => setPageWidth(e.nativeEvent.layout.width || windowWidth)}
          onMomentumScrollEnd={(e) => {
            const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth)
            const column = columns[index]
            if (column) showColumn(column.id)
          }}
        >
          {columns.map((column) => (
            <View
              key={column.id}
              style={[styles.page, { width: pageWidth }]}
              ref={
                column.id === shown?.id
                  ? register(`column:${column.id}`, { kind: 'column', id: column.id })
                  : undefined
              }
              testID={`column-${column.id}`}
            >
              <FlatList
                data={column.tasks}
                keyExtractor={(t) => t.id}
                scrollEnabled={scrolls}
                refreshControl={refresh}
                contentInset={FAB_ROOM}
                scrollIndicatorInsets={FAB_ROOM}
                style={styles.columnBody}
                contentContainerStyle={styles.columnBodyContent}
                ListEmptyComponent={empty}
                renderItem={({ item }) => card(item, column, 'card')}
              />
            </View>
          ))}
        </ScrollView>
      </View>
    )
  } else {
    body = (
      <ScrollView
        scrollEnabled={scrolls}
        refreshControl={refresh}
        contentInset={FAB_ROOM}
        scrollIndicatorInsets={FAB_ROOM}
      >
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
      onResponderMove={(e) => dragMove({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
      onResponderRelease={endDrag}
      onResponderTerminate={() => setDrag(null)}
    >
      {body}
      {drag ? null : (
        <Pressable
          onPress={() => onNewTask(newTaskDraft)}
          accessibilityRole="button"
          accessibilityLabel={newTaskColumn ? `New task in ${newTaskColumn.title}` : 'New task'}
          testID="new-task"
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        >
          <Text style={styles.fabGlyph}>＋</Text>
        </Pressable>
      )}
      {drag ? (
        <View
          pointerEvents="none"
          style={[
            styles.ghost,
            { left: drag.point.x - drag.origin.x - 24, top: drag.point.y - drag.origin.y - 24 }
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
    columns: { paddingHorizontal: 12, paddingBottom: 12, gap: 12 },
    wideColumn: { width: COLUMN_WIDTH },
    page: { paddingHorizontal: 12 },
    columnBody: { flex: 1 },
    columnBodyContent: { padding: 8, gap: 8, backgroundColor: t.surface2, borderRadius: 12 },
    columnHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 4,
      paddingVertical: 8
    },
    columnTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: t.mutedForeground },
    count: {
      backgroundColor: t.surface3,
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 1
    },
    countText: { fontSize: 11, color: t.mutedForeground },
    section: {
      paddingHorizontal: 12,
      backgroundColor: t.surface1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    empty: {
      color: t.mutedForeground,
      fontSize: 13,
      textAlign: 'center',
      paddingVertical: 16
    },
    strip: { flexGrow: 0 },
    stripContent: { paddingHorizontal: 14, paddingBottom: 6, gap: 6 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    chipText: { fontSize: 13, color: t.mutedForeground },
    chipTextActive: { color: t.foreground, fontWeight: '600' },
    chipCount: { color: t.mutedForeground },
    fab: {
      position: 'absolute',
      right: 18,
      bottom: 18,
      width: 54,
      height: 54,
      borderRadius: 27,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.primary,
      shadowColor: t.background,
      shadowOpacity: 0.5,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 }
    },
    fabPressed: { opacity: 0.8 },
    fabGlyph: { fontSize: 26, fontWeight: '500', color: t.primaryForeground, marginTop: -2 },
    ghost: {
      position: 'absolute',
      width: 240,
      padding: 12,
      borderRadius: 10,
      backgroundColor: t.surface3,
      borderWidth: 1,
      borderColor: t.ring,
      opacity: 0.95
    },
    ghostText: { fontSize: 14, fontWeight: '500', color: t.foreground }
  })
