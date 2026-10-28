import {
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { HubScope } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { useTabStore, type Tab } from '@slayzone/tabs-state'
import { TaskPaneFallback, useTerminalFirstHolding } from '@slayzone/task/client/TerminalFirstShell'
import { TaskPaneEventCatcher } from '@slayzone/task/client/TaskPaneEventCatcher'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { mruRank } from '@slayzone/terminal/client/terminal-mru'
import { cn } from '@slayzone/ui'
import type { ExplodeCellRect } from '@slayzone/app-shell/client'
import { GripVertical, Minimize2 } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TaskDetailDataLoader } from './lazy'
import { paneHydrator } from './pane-hydration'

/** Handlers every task pane shares. Each must be stable, or every pane re-renders. */
export interface TaskPaneHandlers {
  onBack: () => void
  onTaskUpdated: (task: Task) => void
  onArchiveTask: (taskId: string) => Promise<void>
  onDeleteTask: (taskId: string) => Promise<void>
  onNavigateToTask: (taskId: string) => void
  onConvertTask: (task: Task) => Promise<Task>
  onCloseTab: (taskId: string) => void
  onTerminalFocusRequestHandled: (taskId: string, requestId: number) => void
}

interface TabPanesProps extends TaskPaneHandlers {
  tabs: Tab[]
  activeView: string
  explodeMode: boolean
  focusedExplodeTaskId: string | null
  /** Explode-mode cell rect per task id. A task with no rect is minimized (parked
   *  in the header tray): it stays mounted, hidden and inert. */
  explodeRects: ReadonlyMap<string, ExplodeCellRect>
  /** Must be stable (handed to every memoized task pane). */
  onMinimizeExplodeTask: (taskId: string) => void
  toVisibleIndex: (fullIndex: number) => number
  hubIdByTask: Map<string, string>
  defaultHubId: string
  selectedProjectHubId: string
  tasksMap: Map<string, Task>
  projectsMap: Map<string, Project>
  zenMode: boolean
  settingsRevision: number
  terminalFocusRequests: Record<string, number>
  isSidePanelResizing: boolean
  /**
   * The home tab's content, given whether home is the visible view (deferred) and
   * whether home is the active tab (urgent, regardless of the active view).
   */
  renderHome: (isViewActive: boolean, isHomeTabActive: boolean) => ReactNode
}

/**
 * Every open tab's content, all mounted (hidden tabs stay alive). A switch must
 * cost the same with 3 tabs open as with 50: each pane is memoized on its own
 * props, so only the tab leaving and the tab arriving re-render.
 *
 * A hidden task pane mounts its detail page a moment later than an on-screen one
 * — one per idle slice after boot (see pane-hydration.ts) — and from then on
 * stays mounted like any other.
 *
 * The content swap trails the tab bar: it reads the active index deferred, so
 * the highlight moves at once and the swap renders at transition priority —
 * re-rendering only these panes, not the whole shell.
 */
export const TabPanes = memo(function TabPanes({
  tabs,
  activeView,
  explodeMode,
  focusedExplodeTaskId,
  explodeRects,
  onMinimizeExplodeTask,
  toVisibleIndex,
  hubIdByTask,
  defaultHubId,
  selectedProjectHubId,
  tasksMap,
  projectsMap,
  zenMode,
  settingsRevision,
  terminalFocusRequests,
  isSidePanelResizing,
  renderHome,
  ...handlers
}: TabPanesProps): React.JSX.Element {
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const deferredActiveTabIndex = useDeferredValue(activeTabIndex)
  const isHomeTabActive = tabs[activeTabIndex]?.type === 'home'
  // Task-targeted events for tabs whose page is not mounted yet: one listener
  // per hub that owns an open task tab.
  const openTaskIds = useMemo(
    () => new Set(tabs.flatMap((t) => (t.type === 'task' ? [t.taskId] : []))),
    [tabs]
  )
  const catcherHubIds = useMemo(
    () => [...new Set([...openTaskIds].map((id) => hubIdByTask.get(id) ?? defaultHubId))],
    [openTaskIds, hubIdByTask, defaultHubId]
  )
  const isOpenTask = useCallback((taskId: string) => openTaskIds.has(taskId), [openTaskIds])
  return (
    <>
      {catcherHubIds.map((hubId) => (
        <HubScope key={`catcher:${hubId}`} hubId={hubId}>
          <TaskPaneEventCatcher isOpenTask={isOpenTask} onWake={paneHydrator.hydrateNow} />
        </HubScope>
      ))}
      {tabs.map((tab, i) => {
        if (explodeMode && (tab.type !== 'task' || toVisibleIndex(i) < 0)) return null
        const isViewActive = activeView === 'tabs' && i === deferredActiveTabIndex
        if (tab.type === 'home') {
          return (
            <HomePane
              key="home"
              hubId={selectedProjectHubId}
              isViewActive={isViewActive}
              isHomeTabActive={isHomeTabActive}
              explodeMode={explodeMode}
              renderHome={renderHome}
            />
          )
        }
        const task = tasksMap.get(tab.taskId) ?? null
        return (
          <TaskPane
            key={tab.taskId}
            taskId={tab.taskId}
            task={task}
            project={projectsMap.get(task?.project_id ?? '') ?? null}
            hubId={hubIdByTask.get(tab.taskId) ?? defaultHubId}
            isViewActive={isViewActive}
            explodeMode={explodeMode}
            isExplodeFocused={explodeMode && focusedExplodeTaskId === tab.taskId}
            explodeRect={explodeMode ? explodeRects.get(tab.taskId) : undefined}
            onMinimizeExplodeTask={onMinimizeExplodeTask}
            zenMode={zenMode}
            settingsRevision={settingsRevision}
            terminalFocusRequestId={terminalFocusRequests[tab.taskId] ?? 0}
            isSidePanelResizing={isSidePanelResizing}
            {...handlers}
          />
        )
      })}
    </>
  )
})

interface PaneFrameProps {
  isViewActive: boolean
  explodeMode: boolean
  isExplodeFocused?: boolean
  explodeTaskId?: string
  /** Explode-mode cell rect; absent in explode mode = minimized to the tray. */
  explodeRect?: ExplodeCellRect
  onMinimizeExplodeTask?: (taskId: string) => void
  hubId: string
  children: ReactNode
}

/** Custom DnD mime so an explode-cell drag is distinguishable from dragged text
 *  or files, which terminals and editors must keep handling themselves. The drop
 *  side lives on the grid (App.tsx), in the capture phase. */
export const EXPLODE_DRAG_TYPE = 'application/x-slayzone-explode-cell'

/** Explode grid's `p-1` frame: cell rects are laid out inside it. */
export const EXPLODE_GRID_PAD = 4

/**
 * Inactive tabs hide via `invisible` (visibility:hidden). CSS does not interpolate
 * `visibility`, so a descendant carrying a `transition` (e.g. Button's
 * `transition-all`) stays fully painted for the whole transition duration before
 * snapping off — that was the "Turn into task" button lingering on tab switch.
 * Hidden tabs are inert, so their descendant transitions are killed too
 * (`[&_*]:transition-none!`) → the hide is instant for every element.
 *
 * visibility:hidden does NOT stop CSS animations either: every spinner, pulse and
 * loader in every hidden tab kept ticking, and a non-composited one restyles its
 * element each frame (two hidden browser loaders alone cost ~60% of a core).
 * Hidden tabs pause them (`animation-play-state: paused`) — paused, not removed,
 * so nothing restarts or replays its entry animation on reveal; a loop simply
 * resumes where it stopped. (Radix overlays that wait on `animationend` portal
 * out of the pane, so none of them is held here.)
 *
 * Explode mode: each cell is an explicit pixel rect from `computeExplodeLayout`
 * (not CSS grid tracks), so the pane tree is identical in both modes and toggling
 * never remounts a terminal. A minimized cell has no rect: it stays MOUNTED and is
 * hidden exactly like an inactive tab — unmounting would tear down its xterm and
 * lose the scrollback the user minimized to keep.
 *
 * Multi-hub: each tab's content is scoped to the hub that owns it, so ambient
 * useTRPC() (TaskDetailPage/HomeDetail + the hub-keyed taskDetailCache) resolves
 * to the right hub. Single-hub → HubScope(default) is the same client the app is
 * already wrapped in.
 */
function PaneFrame({
  isViewActive,
  explodeMode,
  isExplodeFocused = false,
  explodeTaskId,
  explodeRect,
  onMinimizeExplodeTask,
  hubId,
  children
}: PaneFrameProps): React.JSX.Element {
  const hidden = explodeMode ? !explodeRect : !isViewActive
  return (
    <div
      data-explode-task-id={explodeMode && explodeRect ? explodeTaskId : undefined}
      className={
        explodeMode && explodeRect
          ? cn(
              'group absolute rounded overflow-hidden border min-h-0',
              isExplodeFocused ? 'border-primary/60 ring-2 ring-primary/40 z-10' : 'border-border'
            )
          : `absolute inset-0 ${
              hidden
                ? 'invisible [&_*]:transition-none! [&_*]:[animation-play-state:paused]!'
                : 'z-10'
            }`
      }
      style={
        explodeMode && explodeRect
          ? {
              left: explodeRect.left + EXPLODE_GRID_PAD,
              top: explodeRect.top + EXPLODE_GRID_PAD,
              width: explodeRect.width,
              height: explodeRect.height
            }
          : undefined
      }
      inert={hidden ? true : undefined}
    >
      {explodeMode && explodeRect && explodeTaskId && onMinimizeExplodeTask ? (
        <ExplodeCellChrome taskId={explodeTaskId} onMinimize={onMinimizeExplodeTask} />
      ) : null}
      <HubScope hubId={hubId}>{children}</HubScope>
    </div>
  )
}

/**
 * Hover-revealed explode-cell chrome: drag grip (swap) + minimize. Absolutely
 * positioned over the content rather than inset above it, so showing it never
 * resizes the terminal underneath (an xterm reflow on hover would reflow output).
 */
function ExplodeCellChrome({
  taskId,
  onMinimize
}: {
  taskId: string
  onMinimize: (taskId: string) => void
}): React.JSX.Element {
  return (
    <div className="absolute top-0 right-0 z-20 flex items-center gap-0.5 rounded-bl bg-surface-2/90 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(EXPLODE_DRAG_TYPE, taskId)
          e.dataTransfer.effectAllowed = 'move'
        }}
        title="Drag onto another terminal to swap places"
        aria-label="Drag to swap position"
        data-testid="explode-drag-handle"
        className="cursor-grab p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onMinimize(taskId)}
        title="Minimize to the header tray (keeps running)"
        aria-label="Minimize terminal"
        data-testid="explode-minimize"
        className="p-1 text-muted-foreground hover:text-foreground"
      >
        <Minimize2 className="size-3.5" />
      </button>
    </div>
  )
}

const HomePane = memo(function HomePane({
  hubId,
  isViewActive,
  isHomeTabActive,
  explodeMode,
  renderHome
}: {
  hubId: string
  isViewActive: boolean
  isHomeTabActive: boolean
  explodeMode: boolean
  renderHome: TabPanesProps['renderHome']
}): React.JSX.Element {
  return (
    <PaneFrame isViewActive={isViewActive} explodeMode={explodeMode} hubId={hubId}>
      {renderHome(isViewActive, isHomeTabActive)}
    </PaneFrame>
  )
})

interface TaskPaneProps extends TaskPaneHandlers {
  taskId: string
  task: Task | null
  project: Project | null
  hubId: string
  isViewActive: boolean
  explodeMode: boolean
  isExplodeFocused: boolean
  explodeRect: ExplodeCellRect | undefined
  onMinimizeExplodeTask: (taskId: string) => void
  zenMode: boolean
  settingsRevision: number
  terminalFocusRequestId: number
  isSidePanelResizing: boolean
}

const TaskPane = memo(function TaskPane({
  taskId,
  task,
  project,
  hubId,
  isViewActive,
  explodeMode,
  isExplodeFocused,
  explodeRect,
  onMinimizeExplodeTask,
  zenMode,
  settingsRevision,
  terminalFocusRequestId,
  isSidePanelResizing,
  onBack,
  onTaskUpdated,
  onArchiveTask,
  onDeleteTask,
  onNavigateToTask,
  onConvertTask,
  onCloseTab,
  onTerminalFocusRequestHandled
}: TaskPaneProps): React.JSX.Element {
  // On screen: the active tab, or an explode cell that is not minimized. A minimized
  // cell is treated exactly like a hidden tab (mounted, inactive) until restored.
  const onScreen = explodeMode ? explodeRect !== undefined : isViewActive
  const hydrated = usePaneHydrated(
    taskId,
    hubId,
    task?.panel_visibility?.browser === true,
    onScreen
  )
  // A task opened terminal-first keeps showing its terminal until the agent is up.
  const holdForTerminal = useTerminalFirstHolding(taskId)
  return (
    <PaneFrame
      isViewActive={isViewActive}
      explodeMode={explodeMode}
      isExplodeFocused={isExplodeFocused}
      explodeTaskId={taskId}
      explodeRect={explodeRect}
      onMinimizeExplodeTask={onMinimizeExplodeTask}
      hubId={hubId}
    >
      <ErrorBoundary onReset={() => taskDetailCache.invalidate('taskDetail', taskId, hubId)}>
        <Suspense fallback={<TaskPaneFallback taskId={taskId} />}>
          {hydrated && !holdForTerminal ? (
            <div className={explodeMode ? 'absolute inset-0' : 'h-full'}>
              <TaskDetailDataLoader
                taskId={taskId}
                task={task}
                project={project}
                isActive={onScreen}
                hasShortcutFocus={explodeMode ? isExplodeFocused : isViewActive}
                compact={explodeMode}
                zenMode={zenMode}
                onBack={onBack}
                onTaskUpdated={onTaskUpdated}
                onArchiveTask={onArchiveTask}
                onDeleteTask={onDeleteTask}
                onNavigateToTask={onNavigateToTask}
                onConvertTask={onConvertTask}
                onCloseTab={onCloseTab}
                settingsRevision={settingsRevision}
                terminalFocusRequestId={terminalFocusRequestId}
                onTerminalFocusRequestHandled={onTerminalFocusRequestHandled}
                isSidePanelResizing={isSidePanelResizing}
              />
              {isViewActive && !explodeMode ? <ActiveDetailMark /> : null}
            </div>
          ) : (
            <TaskPaneFallback taskId={taskId} />
          )}
        </Suspense>
      </ErrorBoundary>
    </PaneFrame>
  )
})

/**
 * Marked once per page load when the on-screen task's detail page first commits
 * (its Suspense boundary resolved). Read by the renderer boot telemetry.
 */
export const ACTIVE_DETAIL_MARK = 'sz:activeTab:detail'
let activeDetailMarked = false
function ActiveDetailMark(): null {
  useEffect(() => {
    if (activeDetailMarked) return
    activeDetailMarked = true
    performance.mark(ACTIVE_DETAIL_MARK)
  }, [])
  return null
}

// Same specifier as lazy.ts's TaskDetailDataLoader → the same chunk.
let detailChunk: Promise<unknown> | null = null
const loadDetailChunk = (): Promise<unknown> =>
  (detailChunk ??= import('@slayzone/task/client/TaskDetailDataLoader'))

/**
 * Hydration order for hidden panes: tabs with an open browser panel first (their
 * WebContentsView only exists once the page mounts, and `slay tasks browser`
 * looks it up), then most recently viewed first (the terminal MRU — the same
 * order the hidden-terminal init queue uses).
 */
function paneRank(taskId: string, browserOpen: boolean): number {
  const mru = mruRank(`${taskId}:${taskId}`)
  const recency = mru === Number.MAX_SAFE_INTEGER ? 10_000 : mru
  return browserOpen ? recency : 100_000 + recency
}

/**
 * Whether the pane's detail page is mounted. On screen → at once (and for good);
 * hidden → after its turn in the idle queue, once its data and chunk are loaded.
 */
function usePaneHydrated(
  taskId: string,
  hubId: string,
  browserOpen: boolean,
  onScreen: boolean
): boolean {
  const subscribe = useCallback((cb: () => void) => paneHydrator.subscribe(taskId, cb), [taskId])
  const hydrated = useSyncExternalStore(subscribe, () => paneHydrator.isHydrated(taskId))
  const browserOpenRef = useRef(browserOpen)
  useEffect(() => {
    browserOpenRef.current = browserOpen
  }, [browserOpen])
  useEffect(() => {
    if (onScreen) {
      paneHydrator.hydrateNow(taskId)
      return
    }
    return paneHydrator.enqueue(taskId, {
      rank: () => paneRank(taskId, browserOpenRef.current),
      // `hubId` matches what TaskDetailDataLoader reads from this pane's HubScope,
      // so this is the very cache entry the page will render from.
      ready: Promise.all([loadDetailChunk(), taskDetailCache.prefetch('taskDetail', taskId, hubId)])
    })
  }, [taskId, hubId, onScreen])
  return hydrated || onScreen
}
