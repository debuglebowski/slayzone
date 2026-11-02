/**
 * Home: the board of the last project (desktop's HomeDetail). The app opens here.
 *
 * Phone: one header row — the project's avatar and name ▾ (switch project: every project
 * of every hub), 🔔 with how many agents wait for you (all hubs), ⋯ (`BoardMenu`: Filter…,
 * Display…, Board/List, Archive all; a dot while a filter narrows the board); then the
 * board (`ProjectBoard`: its column strip, one column at a time, swipe sideways; a
 * floating ＋ creates a task in the shown column). A tapped card opens the task on its
 * own screen (`onOpenTask`).
 *
 * iPad (`wide`): desktop's layout — the projects rail on the left (avatars, amber
 * waiting counts), open tasks as tabs on top (the board is the first tab), every column
 * side by side (🔔 and ⋯ at the end of the tab bar); a tapped card opens its task as a tab,
 * Agent and Details side by side.
 *
 * The project, the view and each project's filters and Display options (group by, sort,
 * show completed / archived / sub-tasks / empty / blocked) are remembered on the device
 * (`board-prefs`); with nothing remembered (or it is gone), the first project of the
 * first hub that has one. A hub that can't be reached gets a banner (Retry, Sign out).
 */
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AttentionSheet } from '../attention/AttentionSheet'
import type { AgentRow } from '../agents/hub-agents'
import { isCompletedCategory } from '@slayzone/workflow'
import {
  type BoardFilter,
  boardColumns,
  boardTags,
  clearNarrowing,
  DEFAULT_BOARD_FILTER,
  displayGroup,
  filterNarrows
} from '../board/board-model'
import {
  type ArchivableColumn,
  BoardMenuButton,
  type BoardMenuProps,
  ScopedBoardMenuButton
} from '../board/BoardMenu'
import type { BoardPrefs, BoardPrefsStore, BoardView } from '../board/board-prefs'
import {
  projectWaitingCounts,
  statusCategoryOf,
  taskAgentDot,
  waitingAgentCount
} from '../board/card-model'
import { FilterSheet } from '../board/FilterSheet'
import { type Measure, type NewTaskDraft, ProjectBoard } from '../board/ProjectBoard'
import { findTaskRow, type HubFeed, hubProblem, rowKey, type TaskRow } from '../hub-board'
import type { HubSession } from '../hub-session'
import { HubBanners } from '../HubBanner'
import {
  findProjectRow,
  mergeHubProjects,
  type ProjectRef,
  type ProjectRow
} from '../projects/hub-projects'
import { ProjectSwitcher } from '../projects/ProjectSwitcher'
import type { NewTaskParams } from '../task-edit/routes'
import { TaskPage, type TaskSegment } from '../task/TaskPage'
import { type ChromeColors, useTheme } from '../theme'
import { IconButton, Pill, ProjectAvatar } from '../ui-kit/Chrome'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import { sameTask, type TaskRef } from './open-tasks'
import { useOpenTasks } from './OpenTasksProvider'

export interface BoardHomeProps {
  /** Every signed-in hub's feed, in sign-in order (`useHubFeeds`). */
  feeds: readonly HubFeed[]
  sessions: readonly HubSession[]
  /** iPad: rail, tabs, columns side by side. */
  wide: boolean
  onRetry: (hubId: string) => void
  onSignOut: (hubId: string) => void
  /** Phone: a card (or a 🔔 row, `segment` agent) was tapped — its task's screen. */
  onOpenTask: (row: Pick<TaskRow, 'hubLabel' | 'task'>, segment?: TaskSegment) => void
  /** The floating ＋: create a task in the shown project (and column, if one is shown). */
  onNewTask: (target: NewTaskParams) => void
  /** A project's settings (folders, computer). */
  onOpenProject: (hubLabel: string, projectId: string) => void
  /** iPad, inside a task tab: an artifact was tapped. */
  onOpenArtifact: (
    hubLabel: string,
    taskId: string,
    artifactId: string,
    version: number | null
  ) => void
  /** What the board remembers on this device (`board-prefs-file.ts`). */
  prefs: BoardPrefsStore
  /** The Board tab's screen is the one shown; false = its sheets close (another tab or
   * screen took over: a sheet is a window over the whole app). Default true. */
  focused?: boolean
  /** A link asked for a sheet (`/?sheet=attention|projects|menu|filter|display`, e.g. from a notification). */
  sheetParam?: string
  /** A link asked for a column (`/?column=<status>`): the phone shows it first. */
  columnParam?: string
  /** Tests: how drop targets are measured. */
  measure?: Measure
}

/** `menu`: ⋯ asked for by a link (iOS's action sheet, opened by the button itself). */
type Sheet = 'projects' | 'attention' | 'filter' | 'display' | 'menu'
const LINK_SHEETS: readonly string[] = ['projects', 'attention', 'menu', 'filter', 'display']

const VIEW_LABELS: Record<BoardView, string> = { kanban: 'Board', list: 'List', tree: 'Tree' }

export function BoardHome(props: BoardHomeProps) {
  const { feeds, wide, prefs } = props
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [kept, setKept] = useState<BoardPrefs>(() => prefs.load())
  const [sheet, setSheet] = useState<Sheet | null>(null)
  if (props.focused === false && sheet !== null) setSheet(null)
  // A link's sheet opens once per link (render-time sync, not an effect).
  const [linkedSheet, setLinkedSheet] = useState<string | undefined>(undefined)
  if (props.sheetParam !== linkedSheet) {
    setLinkedSheet(props.sheetParam)
    if (props.focused !== false && props.sheetParam && LINK_SHEETS.includes(props.sheetParam)) {
      setSheet(props.sheetParam as Sheet)
    }
  }
  const open = useOpenTasks()
  const update = (next: BoardPrefs) => {
    setKept(next)
    prefs.save(next)
  }

  const groups = mergeHubProjects(feeds)
  const chosenFeed = kept.project ? feeds.find((f) => f.hub.id === kept.project?.hubId) : undefined
  const chosen: ProjectRow | null =
    chosenFeed && kept.project ? findProjectRow(chosenFeed, kept.project.projectId) : null
  // The remembered project's hub has not delivered yet: wait for it, don't jump elsewhere.
  const waiting =
    !chosen &&
    chosenFeed !== undefined &&
    chosenFeed.board.data === undefined &&
    hubProblem(chosenFeed) === null
  const current = chosen ?? (waiting ? null : (groups.flatMap((g) => g.projects)[0] ?? null))
  const feed = current ? feeds.find((f) => f.hub.id === current.hubId) : undefined
  const loading = !current && (waiting || groups.some((g) => g.loading))
  const currentRef: ProjectRef | null = current
    ? { hubId: current.hubId, projectId: current.project.id }
    : null

  const filterKey = current ? rowKey(current.hubId, current.project.id) : ''
  const filter = kept.filters[filterKey] ?? DEFAULT_BOARD_FILTER
  const setFilter = (next: BoardFilter) =>
    update({ ...kept, filters: { ...kept.filters, [filterKey]: next } })
  // The phone has no tree (desktop keeps its tree in the sidebar): Board instead.
  const view: BoardView = !wide && kept.view === 'tree' ? 'kanban' : kept.view
  const views: BoardView[] = wide ? ['kanban', 'list', 'tree'] : ['kanban', 'list']
  const narrows = filterNarrows(filter)
  const bell = waitingAgentCount(feeds)
  const waitingByProject = projectWaitingCounts(feeds)

  const newTask = (draft: NewTaskDraft) => {
    if (!current) return
    props.onNewTask({
      hub: current.hubLabel,
      project: current.project.id,
      status: draft.status,
      priority: draft.priority,
      due: draft.dueDate
    })
  }
  const selectProject = (ref: ProjectRef) => {
    update({ ...kept, project: ref })
    open.activate(null)
  }

  const showTask = (ref: TaskRef, segment?: TaskSegment) =>
    open.open(ref, segment ? { segment } : undefined)
  const onCard = (row: TaskRow) =>
    wide ? showTask({ hubId: row.hubId, taskId: row.task.id }) : props.onOpenTask(row)
  const onAttention = (row: AgentRow) => {
    if (wide) {
      update({ ...kept, project: { hubId: row.hubId, projectId: row.task.project_id } })
      showTask({ hubId: row.hubId, taskId: row.task.id }, 'agent')
    } else props.onOpenTask(row, 'agent')
  }

  let board: ReactNode
  if (loading) {
    board = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.foreground} testID="board-loading" />
      </View>
    )
  } else if (!current || !feed) {
    board = (
      <View style={styles.center}>
        <Text style={styles.note}>No projects yet</Text>
        <Pill label="＋ New project" onPress={() => setSheet('projects')} />
      </View>
    )
  } else {
    const active = open.active
    board = (
      <HubScope hubId={current.hubId}>
        <ProjectBoard
          key={current.key}
          feed={feed}
          project={current.project}
          view={view}
          filter={filter}
          wide={wide}
          selectedTaskId={active && active.hubId === current.hubId ? active.taskId : undefined}
          initialColumn={props.columnParam}
          measure={props.measure}
          onOpen={onCard}
          onNewTask={newTask}
          onRefresh={() => props.onRetry(current.hubId)}
        />
      </HubScope>
    )
  }

  const sheets = (
    <>
      <ProjectSwitcher
        visible={sheet === 'projects'}
        selected={currentRef}
        onSelect={selectProject}
        onOpenSettings={({ hubLabel, projectId }) => props.onOpenProject(hubLabel, projectId)}
        onClose={() => setSheet(null)}
      />
      <AttentionSheet
        feeds={feeds}
        visible={sheet === 'attention'}
        project={current && currentRef ? { ...currentRef, name: current.project.name } : null}
        onOpen={onAttention}
        onClose={() => setSheet(null)}
      />
      {current && feed?.board.data ? (
        <>
          <FilterSheet
            kind="filter"
            visible={sheet === 'filter'}
            filter={filter}
            tags={boardTags(feed.board.data)}
            onChange={setFilter}
            onClose={() => setSheet(null)}
          />
          <FilterSheet
            kind="display"
            visible={sheet === 'display'}
            filter={filter}
            tags={[]}
            views={views.map((id) => ({ id, label: VIEW_LABELS[id] }))}
            view={view}
            onView={(v) => update({ ...kept, view: v })}
            onChange={setFilter}
            onClose={() => setSheet(null)}
          />
        </>
      ) : null}
    </>
  )

  const banners = <HubBanners feeds={feeds} onRetry={props.onRetry} onSignOut={props.onSignOut} />
  const bellButton = (
    <IconButton
      label="Agents"
      glyph="🔔"
      badge={bell || undefined}
      onPress={() => setSheet('attention')}
      testID="bell"
    />
  )
  // Desktop's "Archive all" of a completed column, for each one that shows tasks not yet
  // archived (status columns only: other groupings have none).
  const archivable: ArchivableColumn[] =
    current && feed?.board.data && displayGroup(view, filter.groupBy) === 'status'
      ? boardColumns(feed.board.data, current.project, filter, { view })
          .map((c) => ({ ...c, tasks: c.tasks.filter((t) => !t.archived_at) }))
          .filter(
            (c) =>
              c.tasks.length > 0 &&
              !c.id.startsWith('__') &&
              isCompletedCategory(statusCategoryOf(c.id, current.project).category)
          )
          .map((c) => ({ id: c.id, title: c.title, taskIds: c.tasks.map((t) => t.id) }))
      : []
  const menuProps: BoardMenuProps = {
    title: current?.project.name ?? 'Board',
    narrows,
    canFilter: !!(current && feed?.board.data),
    view,
    views: views.map((id) => ({ id, label: VIEW_LABELS[id] })),
    archivable,
    onFilter: () => setSheet('filter'),
    onClearFilters: () => setFilter(clearNarrowing(filter)),
    onDisplay: () => setSheet('display'),
    onView: (v) => {
      update({ ...kept, view: v })
      if (wide) open.activate(null)
    }
  }
  // A link's ⋯ opens once the board has loaded (its entries need the board).
  const menuAsked = {
    requested: sheet === 'menu' && menuProps.canFilter,
    onRequested: () => setSheet(null)
  }
  const menuButton = current ? (
    <HubScope hubId={current.hubId} fallback={<BoardMenuButton {...menuProps} {...menuAsked} />}>
      <ScopedBoardMenuButton {...menuProps} {...menuAsked} />
    </HubScope>
  ) : (
    <BoardMenuButton {...menuProps} />
  )

  if (!wide) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable
            style={styles.project}
            onPress={() => setSheet('projects')}
            accessibilityRole="button"
            accessibilityLabel="Switch project"
            testID="project-switcher"
          >
            {current ? (
              <ProjectAvatar name={current.project.name} color={current.project.color} />
            ) : null}
            <Text style={styles.projectName} numberOfLines={1} accessibilityRole="header">
              {current ? current.project.name : 'SlayZone'}
            </Text>
            <Text style={styles.chevron}>▾</Text>
          </Pressable>
          {bellButton}
          {menuButton}
        </View>
        {banners}
        {board}
        {sheets}
      </View>
    )
  }

  // iPad: rail · tabs · board or task.
  const activeRef = open.active
  const activeFeed = activeRef ? feeds.find((f) => f.hub.id === activeRef.hubId) : undefined
  const activeRow = activeRef && activeFeed ? findTaskRow(activeFeed, activeRef.taskId) : null
  const activeSession = activeRef
    ? props.sessions.find((s) => s.entry.id === activeRef.hubId)
    : undefined
  const activeKey = activeRef ? rowKey(activeRef.hubId, activeRef.taskId) : ''
  const activeTab = activeRef ? open.viewOf(activeRef) : null

  return (
    <View style={[styles.screen, styles.row]}>
      <ScrollView
        style={styles.rail}
        contentContainerStyle={styles.railContent}
        testID="projects-rail"
      >
        {groups.flatMap((g) =>
          g.projects.map((p) => {
            const on = currentRef?.hubId === p.hubId && currentRef.projectId === p.project.id
            return (
              <Pressable
                key={p.key}
                onPress={() => selectProject({ hubId: p.hubId, projectId: p.project.id })}
                onLongPress={() => props.onOpenProject(p.hubLabel, p.project.id)}
                accessibilityRole="button"
                accessibilityLabel={p.project.name}
                accessibilityState={{ selected: on }}
                testID={`rail-${p.project.id}`}
              >
                <ProjectAvatar
                  name={p.project.name}
                  color={p.project.color}
                  size={40}
                  selected={on}
                  badge={waitingByProject.get(rowKey(p.hubId, p.project.id))}
                />
              </Pressable>
            )
          })
        )}
        <Pressable
          onPress={() => setSheet('projects')}
          accessibilityRole="button"
          accessibilityLabel="All projects"
          style={styles.railAdd}
        >
          <Text style={styles.railAddText}>＋</Text>
        </Pressable>
      </ScrollView>
      <View style={styles.flex}>
        <View style={styles.tabBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabs}
          >
            <Pressable
              onPress={() => open.activate(null)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeRef === null }}
              style={[styles.tab, activeRef === null && styles.tabOn]}
              testID="open-tab-board"
            >
              <Text style={[styles.tabText, activeRef === null && styles.tabTextOn]}>
                ⌂ {current?.project.name ?? 'Board'}
              </Text>
            </Pressable>
            {open.tabs.map((ref) => {
              const tabFeed = feeds.find((f) => f.hub.id === ref.hubId)
              const row = tabFeed ? findTaskRow(tabFeed, ref.taskId) : null
              const on = sameTask(ref, activeRef)
              const dot = tabFeed && row ? taskAgentDot(tabFeed, row.task) : null
              return (
                <Pressable
                  key={rowKey(ref.hubId, ref.taskId)}
                  onPress={() => open.activate(ref)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  style={[styles.tab, on && styles.tabOn]}
                  testID={`open-tab-task-${ref.taskId}`}
                >
                  {dot ? <AgentDot kind={dot} size={8} /> : null}
                  <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
                    {row?.task.title ?? '…'}
                  </Text>
                  <Pressable
                    onPress={() => open.close(ref)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${row?.task.title ?? 'task'}`}
                  >
                    <Text style={styles.tabClose}>✕</Text>
                  </Pressable>
                </Pressable>
              )
            })}
          </ScrollView>
          {bellButton}
          {menuButton}
        </View>
        {banners}
        {activeRef && activeTab && activeRow && activeFeed && activeSession ? (
          <TaskPage
            key={activeKey}
            row={activeRow}
            feed={activeFeed}
            session={activeSession}
            showHub={feeds.length > 1}
            wide
            segment={activeTab.segment}
            onSegment={(segment) => open.setView(activeRef, { segment })}
            agentTabId={activeTab.agentTabId}
            onSelectAgentTab={(agentTabId) => open.setView(activeRef, { agentTabId })}
            onDeleted={() => open.close(activeRef)}
            onOpenTask={(taskId) => showTask({ hubId: activeRef.hubId, taskId })}
            onOpenArtifact={(artifactId, version) =>
              props.onOpenArtifact(activeRow.hubLabel, activeRow.task.id, artifactId, version)
            }
          />
        ) : (
          board
        )}
      </View>
      {sheets}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    row: { flexDirection: 'row' },
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
    note: { color: t.mutedForeground, fontSize: 15 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingTop: 6,
      paddingBottom: 10
    },
    project: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9 },
    projectName: { flexShrink: 1, fontSize: 22, fontWeight: '700', color: t.foreground },
    chevron: { fontSize: 13, color: t.mutedForeground, fontWeight: '600' },
    rail: {
      width: 68,
      flexGrow: 0,
      backgroundColor: t.surface1,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.border
    },
    railContent: { alignItems: 'center', gap: 14, paddingVertical: 14 },
    railAdd: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: t.border
    },
    railAddText: { fontSize: 18, color: t.mutedForeground },
    tabBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    tabs: { gap: 6, alignItems: 'center' },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: 240,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: t.surface2
    },
    tabOn: { backgroundColor: t.surface3 },
    tabText: { flexShrink: 1, fontSize: 13, color: t.mutedForeground },
    tabTextOn: { color: t.foreground, fontWeight: '600' },
    tabClose: { fontSize: 11, color: t.mutedForeground }
  })
