import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentRow } from './agents/hub-agents'
import {
  type BoardFilter,
  boardTags,
  DEFAULT_BOARD_FILTER,
  filterIsActive
} from './board/board-model'
import {
  BOARD_VIEWS,
  type BoardPrefs,
  type BoardPrefsStore,
  type BoardView
} from './board/board-prefs'
import { FilterSheet } from './board/FilterSheet'
import { type Measure, ProjectBoard } from './board/ProjectBoard'
import type { NewTaskParams } from './task-edit/routes'
import { HubBanners } from './HubBanner'
import { findTaskRow, type HubFeed, hubProblem, rowKey, type TaskRow } from './hub-board'
import { findProjectRow, mergeHubProjects, type ProjectRow } from './projects/hub-projects'
import { ProjectPicker } from './projects/ProjectPicker'
import { TaskDetail } from './TaskDetail'
import { type ChromeColors, useTheme } from './theme'

/** Wide enough for the board + the selected task beside it, columns side by side (iPad). */
export const SPLIT_MIN_WIDTH = 700

const VIEW_LABELS: Record<BoardView, string> = { kanban: 'Kanban', list: 'List', tree: 'Tree' }

export interface TaskBrowserProps {
  /** Every signed-in hub's feed, in sign-in order (`useHubFeeds`). */
  feeds: readonly HubFeed[]
  /** `split`: columns side by side, a tapped task beside the board (iPad); `list`: phone. */
  layout: 'list' | 'split'
  /** The task shown beside the board (`split`); null = none. */
  selected: { hubId: string; taskId: string } | null
  /** A task was tapped: phone opens it, iPad shows it beside the board. */
  onSelect: (row: TaskRow) => void
  /** iPad: close the task beside the board. */
  onDeselect: () => void
  onRetry: (hubId: string) => void
  onSignOut: (hubId: string) => void
  /** "Projects": every hub's projects. */
  onShowProjects: () => void
  /** Beside the board, the shown task's "Agent ›" was tapped: its agent screen. */
  onOpenAgent: (row: Pick<AgentRow, 'hubId' | 'hubLabel' | 'task'>) => void
  /** "+": create a task in the shown project (a column's "+": with its status). */
  onNewTask: (target: NewTaskParams) => void
  /** What the board remembers on this device (`board-prefs-file.ts`). */
  prefs: BoardPrefsStore
  /** Tests: how drop targets are measured. */
  measure?: Measure
}

/**
 * The Tasks tab: one project's board at a time — any project of any signed-in hub,
 * switched with the project picker (grouped by hub) — as kanban, list or tree, live from
 * the hub's change feed, with desktop's filters. The project, the view and each project's
 * filters are remembered on the device; with nothing remembered (or it is gone), the
 * first project of the first hub that has one. A hub that can't be reached gets a banner
 * with Retry and Sign out.
 */
export function TaskBrowser({
  feeds,
  layout,
  selected,
  onSelect,
  onDeselect,
  onRetry,
  onSignOut,
  onShowProjects,
  onOpenAgent,
  onNewTask,
  prefs,
  measure
}: TaskBrowserProps) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [kept, setKept] = useState<BoardPrefs>(() => prefs.load())
  const [picking, setPicking] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const update = (next: BoardPrefs) => {
    setKept(next)
    prefs.save(next)
  }

  const severalHubs = feeds.length > 1
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

  const filterKey = current ? rowKey(current.hubId, current.project.id) : ''
  const filter = kept.filters[filterKey] ?? DEFAULT_BOARD_FILTER
  const setFilter = (next: BoardFilter) =>
    update({ ...kept, filters: { ...kept.filters, [filterKey]: next } })

  const shownFeed = selected ? feeds.find((f) => f.hub.id === selected.hubId) : undefined
  const shown =
    layout === 'split' && selected && shownFeed ? findTaskRow(shownFeed, selected.taskId) : null

  const newTask = (status?: string) => {
    if (current) onNewTask({ hub: current.hubLabel, project: current.project.id, status })
  }

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Pressable
          style={styles.headerText}
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel="Switch project"
          testID="project-switcher"
        >
          <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
            {current ? `${current.project.name} ▾` : 'Tasks'}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {current && severalHubs ? current.hubLabel : 'Tasks'}
          </Text>
        </Pressable>
        <Pressable onPress={onShowProjects} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>Projects</Text>
        </Pressable>
        <Pressable
          onPress={() => newTask()}
          disabled={!current}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New task"
          testID="new-task"
        >
          <Text style={[styles.plus, !current && styles.disabled]}>+</Text>
        </Pressable>
      </View>
      <View style={styles.toolbar}>
        <View style={styles.segments} accessibilityRole="tablist">
          {BOARD_VIEWS.map((v) => (
            <Pressable
              key={v}
              onPress={() => update({ ...kept, view: v })}
              accessibilityRole="tab"
              accessibilityState={{ selected: kept.view === v }}
              testID={`view-${v}`}
              style={[styles.segment, kept.view === v && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, kept.view === v && styles.segmentTextActive]}>
                {VIEW_LABELS[v]}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          onPress={() => setFiltering(true)}
          disabled={!current}
          hitSlop={8}
          accessibilityRole="button"
          testID="filter-button"
        >
          <Text style={styles.link}>{filterIsActive(filter) ? 'Filter •' : 'Filter'}</Text>
        </Pressable>
      </View>
    </View>
  )

  let body: ReactNode
  if (loading) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.foreground} testID="board-loading" />
      </View>
    )
  } else if (!current || !feed) {
    body = <Text style={styles.note}>No projects</Text>
  } else {
    body = (
      <HubScope hubId={current.hubId}>
        <ProjectBoard
          key={current.key}
          feed={feed}
          project={current.project}
          view={kept.view}
          filter={filter}
          wide={layout === 'split'}
          severalHubs={severalHubs}
          selectedTaskId={shown && shown.hubId === current.hubId ? shown.task.id : undefined}
          measure={measure}
          onOpen={onSelect}
          onNewTask={(status) => newTask(status)}
          onRefresh={() => onRetry(current.hubId)}
        />
      </HubScope>
    )
  }

  return (
    <View style={styles.screen}>
      {header}
      <HubBanners feeds={feeds} onRetry={onRetry} onSignOut={onSignOut} />
      {shown ? (
        <View style={styles.split}>
          <View style={styles.flex}>{body}</View>
          <View style={styles.detailPane} testID="task-beside-board">
            <Pressable
              onPress={onDeselect}
              hitSlop={8}
              accessibilityRole="button"
              style={styles.close}
            >
              <Text style={styles.link}>Close</Text>
            </Pressable>
            <TaskDetail row={shown} showHub={severalHubs} onOpenAgent={() => onOpenAgent(shown)} />
          </View>
        </View>
      ) : (
        body
      )}
      <ProjectPicker
        visible={picking}
        selected={current ? { hubId: current.hubId, projectId: current.project.id } : null}
        onSelect={(row) =>
          update({ ...kept, project: { hubId: row.hubId, projectId: row.project.id } })
        }
        onClose={() => setPicking(false)}
      />
      {current && feed?.board.data ? (
        <FilterSheet
          visible={filtering}
          filter={filter}
          tags={boardTags(feed.board.data)}
          onChange={setFilter}
          onClose={() => setFiltering(false)}
        />
      ) : null}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    headerText: { flex: 1 },
    headerTitle: { fontSize: 22, fontWeight: '700', color: t.foreground },
    headerSub: { fontSize: 12, color: t.mutedForeground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    plus: { fontSize: 28, lineHeight: 30, color: t.foreground },
    disabled: { color: t.mutedForeground },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    segments: {
      flex: 1,
      flexDirection: 'row',
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      overflow: 'hidden'
    },
    segment: { flex: 1, alignItems: 'center', paddingVertical: 6, backgroundColor: t.surface1 },
    segmentActive: { backgroundColor: t.primary },
    segmentText: { fontSize: 13, color: t.foreground },
    segmentTextActive: { color: t.primaryForeground, fontWeight: '600' },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    split: { flex: 1, flexDirection: 'row' },
    detailPane: {
      width: 380,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: t.border,
      backgroundColor: t.card
    },
    close: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 12 }
  })
