import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  cn
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'
import { useTRPCClient } from '@slayzone/transport/client'
import type { ReactNode } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project, ProjectGroup, ColumnConfig, TopLevelEntryRef } from '@slayzone/projects/shared'
import type { OnboardingChecklistState } from '@/hooks/useOnboardingChecklist'
import { SidebarFooterIcons } from './SidebarFooterIcons'
import { SidebarViewSwitcher } from './SidebarViewSwitcher'
import { SidebarResizeHandle } from './SidebarResizeHandle'
import { getView } from './views/registry'

interface AppSidebarProps {
  projects: Project[]
  projectGroups: ProjectGroup[]
  tasks: Task[]
  selectedProjectId: string
  onSelectProject: (id: string, opts?: { home?: boolean }) => void
  onProjectSettings: (project: Project) => void
  onSettings: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onTaskClick?: (taskId: string) => void
  onCloseTab?: (taskId: string) => void
  onOpenTaskInBackground?: (taskId: string) => void
  onCreateTemporaryTask?: (projectId: string) => void
  zenMode?: boolean
  onboardingChecklist: OnboardingChecklistState
  idleByProject?: Map<string, number>
  onReorderProjects: (projectIds: string[]) => void
  onCreateProjectGroup?: (name?: string) => void
  onCreateFolderWithProjects?: (projectIds: string[]) => void
  onRenameProjectGroup?: (id: string, name: string) => void
  onDeleteProjectGroup?: (id: string) => void
  onSetGroupCollapsed?: (id: string, collapsed: boolean) => void
  onReorderTopLevel?: (entries: TopLevelEntryRef[]) => void
  onMoveProjectToGroup?: (projectId: string, groupId: string | null, targetIndex: number) => void
  onReorderProjectsInGroup?: (groupId: string, projectIds: string[]) => void
  onTaskReorder?: (taskIds: string[]) => void
  onTaskMove?: (
    taskId: string,
    newColumnId: string,
    targetIndex: number,
    groupBy: 'none' | 'status' | 'priority'
  ) => void
  onTaskReparent?: (taskId: string, newParentId: string | null, newSiblingTaskIds: string[]) => void
  onTaskBulkReparent?: (
    taskIds: string[],
    newParentId: string | null,
    newSiblingTaskIds: string[]
  ) => void
  onTaskFieldUpdate?: (taskId: string, updates: Partial<Task>) => void
  onTaskBulkFieldUpdate?: (taskIds: string[], updates: Partial<Task>) => void
  onSetTasksPinned?: (taskIds: string[], pinned: boolean) => void
  onSetCollapsed?: (taskId: string, collapsed: boolean) => void
  onPinnedReorder?: (taskIds: string[]) => void
  taskContextMenuRender?: (task: Task, child: ReactNode) => ReactNode
  taskBulkContextMenuRender?: (taskIds: string[], child: ReactNode) => ReactNode
  taskProgress?: Map<string, number>
  doneTaskIds?: Set<string>
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
  compactFooter?: ReactNode
  updateState?: UpdateState | null
}

type UpdateState =
  | { phase: 'downloading'; percent: number; version: string | null }
  | { phase: 'ready'; version: string; onRestart: () => void }

function UpdateStatusCard({ state }: { state: UpdateState }) {
  const [restarting, setRestarting] = useState(false)
  const downloading = state.phase === 'downloading'
  const disabled = downloading || restarting
  const handleClick = () => {
    if (state.phase !== 'ready' || restarting) return
    setRestarting(true)
    state.onRestart()
  }
  const showSpinner = downloading || restarting
  return (
    <div className="px-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          'relative w-full flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2 text-left transition-colors overflow-hidden',
          state.phase === 'ready' && !restarting ? 'hover:bg-surface-3' : 'cursor-default'
        )}
      >
        {showSpinner ? (
          <Loader2 className="size-3 text-green-500 animate-spin shrink-0" />
        ) : (
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inset-0 rounded-full bg-green-500 opacity-75 animate-ping" />
            <span className="relative rounded-full bg-green-500 size-2" />
          </span>
        )}
        <span className="flex flex-col leading-tight flex-1 min-w-0">
          <span className="text-xs font-medium text-foreground">
            {downloading ? 'Downloading update' : restarting ? 'Restarting…' : 'Update ready'}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {downloading ? `${state.percent}%` : restarting ? 'Installing' : 'Click to restart'}
          </span>
        </span>
        {state.version && (
          <span className="shrink-0 rounded-full bg-green-500/15 text-green-500 px-2 py-0.5 text-[10px] font-medium tabular-nums">
            v{state.version}
          </span>
        )}
        {downloading && (
          <span
            aria-hidden
            className="absolute bottom-0 left-0 h-0.5 bg-green-500 transition-[width] duration-300"
            style={{ width: `${state.percent}%` }}
          />
        )}
      </button>
    </div>
  )
}

export function AppSidebar({
  projects,
  projectGroups,
  tasks,
  selectedProjectId,
  onSelectProject,
  onProjectSettings,
  onSettings,
  onUsageAnalytics,
  onLeaderboard,
  onTaskClick,
  onCloseTab,
  onOpenTaskInBackground,
  onCreateTemporaryTask,
  zenMode,
  onboardingChecklist,
  idleByProject,
  onReorderProjects,
  onCreateProjectGroup,
  onCreateFolderWithProjects,
  onRenameProjectGroup,
  onDeleteProjectGroup,
  onSetGroupCollapsed,
  onReorderTopLevel,
  onMoveProjectToGroup,
  onReorderProjectsInGroup,
  onTaskReorder,
  onTaskMove,
  onTaskReparent,
  onTaskBulkReparent,
  onTaskFieldUpdate,
  onTaskBulkFieldUpdate,
  onSetTasksPinned,
  onSetCollapsed,
  onPinnedReorder,
  taskContextMenuRender,
  taskBulkContextMenuRender,
  taskProgress,
  doneTaskIds,
  columnsByProjectId,
  compactFooter,
  updateState
}: AppSidebarProps) {
  const sidebarView = useTabStore((s) => s.sidebarView)
  const setSidebarView = useTabStore((s) => s.setSidebarView)
  const sidebarWidth = useTabStore((s) => s.sidebarWidth)
  const setSidebarWidth = useTabStore((s) => s.setSidebarWidth)
  const sidebarAutoHide = useTabStore((s) => s.sidebarAutoHide)
  const setSidebarAutoHide = useTabStore((s) => s.setSidebarAutoHide)
  const trpcClient = useTRPCClient()
  const view = getView(sidebarView)

  const [hoverRevealed, setHoverRevealed] = useState(false)
  const [resizing, setResizing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    const tick = () => {
      // Keep card open while a dropdown / context menu / popover / dialog is
      // *actually open*. Radix lazy-mounted dialogs stay in DOM after close
      // with data-state="closed", so filter by data-state="open" — otherwise
      // any once-opened dialog blocks auto-close forever.
      if (
        document.querySelector(
          '[role="menu"][data-state="open"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      ) {
        closeTimerRef.current = setTimeout(tick, 200)
        return
      }
      setHoverRevealed(false)
      closeTimerRef.current = null
    }
    closeTimerRef.current = setTimeout(tick, 400)
  }, [cancelClose])

  useEffect(() => () => cancelClose(), [cancelClose])

  const autoHideActive = sidebarAutoHide && !zenMode
  const buttonsVisible = !zenMode && (!autoHideActive || hoverRevealed)
  useEffect(() => {
    void trpcClient.app.window.setWindowButtonVisibility.mutate({ visible: buttonsVisible })
  }, [buttonsVisible, trpcClient])
  const isResizable = !zenMode && !!view.resizable
  const effectiveWidth = isResizable ? (sidebarWidth ?? view.defaultWidth ?? 288) : null

  const sidebarBody = (
    <Sidebar
      collapsible="none"
      style={effectiveWidth != null ? { width: effectiveWidth } : undefined}
      className={cn(
        'relative h-svh',
        zenMode && '!w-0 overflow-hidden',
        !zenMode && effectiveWidth == null && view.width,
        autoHideActive && 'shadow-[0_0_60px_-10px_rgba(0,0,0,0.6)]'
      )}
    >
      <SidebarContent className={cn('pb-4 scrollbar-hide', sidebarView === 'tree' ? '' : 'pt-11')}>
        <SidebarGroup className={sidebarView === 'tree' ? 'pt-0' : undefined}>
          <SidebarGroupContent>
            {view.render({
              projects,
              projectGroups,
              tasks,
              selectedProjectId,
              onSelectProject,
              onProjectSettings,
              onTaskClick,
              onCloseTab,
              onOpenTaskInBackground,
              onCreateTemporaryTask,
              onReorderProjects,
              onCreateProjectGroup,
              onCreateFolderWithProjects,
              onRenameProjectGroup,
              onDeleteProjectGroup,
              onSetGroupCollapsed,
              onReorderTopLevel,
              onMoveProjectToGroup,
              onReorderProjectsInGroup,
              onTaskReorder,
              onTaskMove,
              onTaskReparent,
              onTaskBulkReparent,
              onTaskFieldUpdate,
              onTaskBulkFieldUpdate,
              onSetTasksPinned,
              onSetCollapsed,
              onPinnedReorder,
              idleByProject,
              taskContextMenuRender,
              taskBulkContextMenuRender,
              taskProgress,
              doneTaskIds,
              columnsByProjectId
            })}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className={cn('py-4 gap-3', !compactFooter && 'border-t border-border/60')}>
        {compactFooter ? (
          compactFooter
        ) : (
          <>
            <SidebarFooterIcons
              layout={view.footerLayout}
              tasks={tasks}
              onTaskClick={onTaskClick}
              onSettings={onSettings}
              onUsageAnalytics={onUsageAnalytics}
              onLeaderboard={onLeaderboard}
              onboardingChecklist={onboardingChecklist}
              trailing={
                view.footerLayout === 'horizontal' ? (
                  <SidebarViewSwitcher
                    current={sidebarView}
                    onChange={setSidebarView}
                    compact
                    autoHide={sidebarAutoHide}
                    onToggleAutoHide={() => setSidebarAutoHide(!sidebarAutoHide)}
                  />
                ) : null
              }
            />
            {view.footerLayout === 'vertical' && (
              <div className="flex justify-center">
                <SidebarViewSwitcher
                  current={sidebarView}
                  onChange={setSidebarView}
                  compact
                  autoHide={sidebarAutoHide}
                  onToggleAutoHide={() => setSidebarAutoHide(!sidebarAutoHide)}
                />
              </div>
            )}
          </>
        )}
        {updateState && <UpdateStatusCard state={updateState} />}
      </SidebarFooter>
      {isResizable && effectiveWidth != null && (
        <SidebarResizeHandle
          currentWidth={effectiveWidth}
          minWidth={view.minWidth ?? 200}
          maxWidth={view.maxWidth ?? 600}
          defaultWidth={view.defaultWidth ?? 288}
          onChange={setSidebarWidth}
          onReset={() => setSidebarWidth(null)}
          onDragStateChange={setResizing}
        />
      )}
    </Sidebar>
  )

  if (autoHideActive) {
    return (
      <>
        {/* Zero-width height anchor so the parent flex row keeps its h-svh height
            (the floating sidebar below is `fixed` and contributes no flow height). */}
        <div className="h-svh w-0 shrink-0" aria-hidden />
        {/* Hover trigger strip on far left edge */}
        <div
          className="fixed inset-y-0 left-0 w-2 z-30"
          onMouseEnter={() => {
            cancelClose()
            setHoverRevealed(true)
          }}
        />
        {/* Floating card overlay (with right-edge spatial grace buffer) */}
        <div
          // Marks the card as a popover-class overlay so the browser
          // WebContentsView hides itself while the card covers it (native
          // views always render above renderer DOM — z-index can't beat them).
          data-slot={hoverRevealed ? 'sidebar-reveal-overlay' : undefined}
          className={cn(
            'fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out pr-10',
            hoverRevealed ? 'translate-x-0' : '-translate-x-full pointer-events-none'
          )}
          onMouseEnter={() => {
            cancelClose()
            setHoverRevealed(true)
          }}
          onMouseLeave={() => {
            if (!resizing) scheduleClose()
          }}
        >
          {sidebarBody}
        </div>
      </>
    )
  }

  return sidebarBody
}
