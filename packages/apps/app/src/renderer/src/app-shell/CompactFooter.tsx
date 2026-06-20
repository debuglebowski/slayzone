import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import {
  Settings,
  MoreHorizontal,
  LayoutGrid,
  Check,
  Monitor,
  Bot,
  Bell,
  Trophy,
  BarChart3,
  Megaphone,
  ListTree,
  Kanban,
  PanelLeftClose
} from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@slayzone/ui'
import { useTabStore, useDialogStore } from '@slayzone/settings'
import { UsagePopover } from '@/components/usage/UsagePopover'
import {
  type AgentStatusState,
  type IdleTask,
  type GlobalAgentPanelState
} from '@slayzone/agent-panels'

interface CompactFooterProps {
  usageData: ComponentProps<typeof UsagePopover>['data']
  refreshUsage: ComponentProps<typeof UsagePopover>['onRefresh']
  handleOpenSettings: () => void
  explodeMode: boolean
  setExplodeMode: Dispatch<SetStateAction<boolean>>
  openTaskIds: string[]
  activePtyCount: number
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  selectedProjectId: string | null
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  idleTasks: IdleTask[]
  sidebarView: string
  sidebarAutoHide: boolean
  updateVersion: string | null
}

export function CompactFooter({
  usageData,
  refreshUsage,
  handleOpenSettings,
  explodeMode,
  setExplodeMode,
  openTaskIds,
  activePtyCount,
  globalAgentPanelState,
  setGlobalAgentPanelState,
  selectedProjectId,
  agentStatusState,
  setAgentStatusState,
  idleTasks,
  sidebarView,
  sidebarAutoHide,
  updateVersion
}: CompactFooterProps): React.JSX.Element {
  const trpc = useTRPC()
  const restartForUpdate = useMutation(trpc.app.meta.restartForUpdate.mutationOptions())
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1">
      <div className="min-w-0 flex items-center">
        <UsagePopover data={usageData} onRefresh={refreshUsage} />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleOpenSettings}
          className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="min-w-[240px]">
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Layout
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setExplodeMode((p) => !p)}
              disabled={openTaskIds.length < 2}
              className="cursor-pointer"
            >
              <LayoutGrid className="size-4" />
              <span>Explode mode</span>
              {explodeMode && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Panels
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useDialogStore.getState().openTerminals()}
              className="cursor-pointer"
            >
              <Monitor className="size-4" />
              <span className="flex items-center gap-2">
                <span>Active terminals</span>
                {activePtyCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-foreground text-background text-[10px] font-medium tabular-nums">
                    {activePtyCount}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
              disabled={!selectedProjectId}
              className="cursor-pointer"
            >
              <Bot className="size-4" />
              <span>Global Agent panel</span>
              {globalAgentPanelState.isOpen && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
              className="cursor-pointer"
            >
              <Bell className="size-4" />
              <span className="flex items-center gap-2">
                <span>Agent status panel</span>
                {idleTasks.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-foreground text-background text-[10px] font-medium tabular-nums">
                    {idleTasks.length}
                  </span>
                )}
              </span>
              {agentStatusState.isLocked && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Insights
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setActiveView('leaderboard')}
              className="cursor-pointer"
            >
              <Trophy className="size-4" />
              <span>Leaderboard</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setActiveView('usage-analytics')}
              className="cursor-pointer"
            >
              <BarChart3 className="size-4" />
              <span>Usage Analytics</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useDialogStore.getState().openChangelog()}
              className="cursor-pointer"
            >
              <Megaphone className="size-4" />
              <span>What's New</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Sidebar
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setSidebarView('tree')}
              className="cursor-pointer"
            >
              <ListTree className="size-4" />
              <span>Tree view</span>
              {sidebarView === 'tree' && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setSidebarView('projects')}
              className="cursor-pointer"
            >
              <Kanban className="size-4" />
              <span>Projects view</span>
              {sidebarView === 'projects' && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                useTabStore.getState().setSidebarAutoHide(!sidebarAutoHide)
              }}
              className="cursor-pointer"
            >
              <PanelLeftClose className="size-4" />
              <span>Auto-hide sidebar</span>
              {sidebarAutoHide && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            {updateVersion && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => restartForUpdate.mutate()}
                  className="cursor-pointer text-green-500"
                >
                  <span>Restart to install v{updateVersion}</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
