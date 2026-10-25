import { memo, Suspense, useDeferredValue, type ReactNode } from 'react'
import { HubScope } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { useTabStore, type Tab } from '@slayzone/settings'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { cn } from '@slayzone/ui'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TaskDetailDataLoader } from './lazy'

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
  return (
    <>
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
          : `absolute inset-0 ${!isViewActive ? 'invisible [&_*]:transition-none!' : 'z-10'}`
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
        </Suspense>
      </ErrorBoundary>
    </PaneFrame>
  )
})
