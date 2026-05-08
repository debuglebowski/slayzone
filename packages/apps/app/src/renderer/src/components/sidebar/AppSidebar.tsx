import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  cn,
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'
import type { ReactNode } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import type { TerminalState } from '@slayzone/terminal/shared'
import type { OnboardingChecklistState } from '@/hooks/useOnboardingChecklist'
import { SidebarFooterIcons } from './SidebarFooterIcons'
import { SidebarViewSwitcher } from './SidebarViewSwitcher'
import { SidebarResizeHandle } from './SidebarResizeHandle'
import { TreeStatusFilter } from './TreeStatusFilter'
import { TreeDisplaySettings } from './TreeDisplaySettings'
import { getView } from './views/registry'
import logo from '@/assets/logo.svg'

interface AppSidebarProps {
  projects: Project[]
  tasks: Task[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onProjectSettings: (project: Project) => void
  onSettings: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onTaskClick?: (taskId: string) => void
  zenMode?: boolean
  onboardingChecklist: OnboardingChecklistState
  idleByProject?: Map<string, number>
  onReorderProjects: (projectIds: string[]) => void
  taskContextMenuRender?: (task: Task, child: ReactNode) => ReactNode
  terminalStates?: Map<string, TerminalState>
  taskProgress?: Map<string, number>
  doneTaskIds?: Set<string>
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
}

export function AppSidebar({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onProjectSettings,
  onSettings,
  onUsageAnalytics,
  onLeaderboard,
  onTaskClick,
  zenMode,
  onboardingChecklist,
  idleByProject,
  onReorderProjects,
  taskContextMenuRender,
  terminalStates,
  taskProgress,
  doneTaskIds,
  columnsByProjectId,
}: AppSidebarProps) {
  const sidebarView = useTabStore((s) => s.sidebarView)
  const setSidebarView = useTabStore((s) => s.setSidebarView)
  const sidebarWidth = useTabStore((s) => s.sidebarWidth)
  const setSidebarWidth = useTabStore((s) => s.setSidebarWidth)
  const sidebarAutoHide = useTabStore((s) => s.sidebarAutoHide)
  const setSidebarAutoHide = useTabStore((s) => s.setSidebarAutoHide)
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
      // Keep card open as long as a dropdown / context menu / popover is open
      // (Radix portals these to document.body so mouse leaves the card while
      // interacting with them).
      if (document.querySelector('[role="menu"], [role="dialog"]')) {
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
  const isResizable = !zenMode && !!view.resizable
  const effectiveWidth =
    isResizable
      ? sidebarWidth ?? view.defaultWidth ?? 288
      : null

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
      {sidebarView === 'tree' && (
        <div className="absolute top-0 left-0 right-0 h-11 flex items-center justify-end gap-1 pr-3 z-20">
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 pointer-events-none select-none text-xs font-medium tracking-wide text-foreground">
            <span>Slay</span>
            <img
              src={logo}
              alt=""
              aria-hidden
              draggable={false}
              className="h-4 w-auto"
            />
            <span>Zone</span>
          </div>
          <TreeStatusFilter />
          <TreeDisplaySettings />
        </div>
      )}
      <SidebarContent className="pb-4 pt-11 scrollbar-hide">
        <SidebarGroup>
          <SidebarGroupContent>
            {view.render({
              projects,
              tasks,
              selectedProjectId,
              onSelectProject,
              onProjectSettings,
              onTaskClick,
              onReorderProjects,
              idleByProject,
              taskContextMenuRender,
              terminalStates,
              taskProgress,
              doneTaskIds,
              columnsByProjectId,
            })}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="py-4 gap-3 border-t border-border/60">
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
                compact={false}
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
          className={cn(
            'fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out pr-10',
            hoverRevealed
              ? 'translate-x-0'
              : '-translate-x-full pointer-events-none'
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
