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
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { useTabStore, type Tab } from '@slayzone/settings'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { TaskPaneEventCatcher } from '@slayzone/task/client/TaskPaneEventCatcher'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { mruRank } from '@slayzone/terminal/client/terminal-mru'
import { cn } from '@slayzone/ui'
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
  hubId: string
  children: ReactNode
}

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
  hubId,
  children
}: PaneFrameProps): React.JSX.Element {
  return (
    <div
      data-explode-task-id={explodeMode ? explodeTaskId : undefined}
      className={
        explodeMode
          ? cn(
              'rounded overflow-hidden border min-h-0 relative',
              isExplodeFocused ? 'border-primary/60 ring-2 ring-primary/40' : 'border-border'
            )
          : `absolute inset-0 ${
              !isViewActive
                ? 'invisible [&_*]:transition-none! [&_*]:[animation-play-state:paused]!'
                : 'z-10'
            }`
      }
      inert={!explodeMode && !isViewActive ? true : undefined}
    >
      <HubScope hubId={hubId}>{children}</HubScope>
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
  const hydrated = usePaneHydrated(
    taskId,
    hubId,
    task?.panel_visibility?.browser === true,
    explodeMode || isViewActive
  )
  return (
    <PaneFrame
      isViewActive={isViewActive}
      explodeMode={explodeMode}
      isExplodeFocused={isExplodeFocused}
      explodeTaskId={taskId}
      hubId={hubId}
    >
      <ErrorBoundary onReset={() => taskDetailCache.invalidate('taskDetail', taskId, hubId)}>
        <Suspense fallback={<TaskShell />}>
          {hydrated ? (
            <div className={explodeMode ? 'absolute inset-0' : 'h-full'}>
              <TaskDetailDataLoader
                taskId={taskId}
                task={task}
                project={project}
                isActive={explodeMode || isViewActive}
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
            </div>
          ) : (
            <TaskShell />
          )}
        </Suspense>
      </ErrorBoundary>
    </PaneFrame>
  )
})

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
