import type { Dispatch, SetStateAction } from 'react'
import { FolderClosed, Focus, LayoutGrid, TerminalSquare } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
  withShortcut,
  UpdateButton
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'
import {
  AgentStatusButton,
  type AgentStatusState,
  GlobalAgentPanelButton,
  type GlobalAgentPanelState
} from '@slayzone/agent-panels'

interface AppHeaderActionsProps {
  compact: boolean
  projectScopedTabs: boolean
  projectTabsShortcut: string | null
  zenMode: boolean
  setZenMode: Dispatch<SetStateAction<boolean>>
  zenModeShortcut: string | null
  explodeMode: boolean
  setExplodeMode: Dispatch<SetStateAction<boolean>>
  explodeModeShortcut: string | null
  openTaskIds: string[]
  selectedProjectId: string | null
  durationLocked: boolean
  handleCreateScratchTerminal: () => void | Promise<void>
  newTempTaskShortcut: string | null
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  attentionTaskIds: ReadonlySet<string>
  agentStatusPanelShortcut: string | null
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  globalAgentPanelShortcut: string | null
  updateVersion: string | null
  updateDownloadPercent: number | null
}

export function AppHeaderActions({
  compact,
  projectScopedTabs,
  projectTabsShortcut,
  zenMode,
  setZenMode,
  zenModeShortcut,
  explodeMode,
  setExplodeMode,
  explodeModeShortcut,
  openTaskIds,
  selectedProjectId,
  durationLocked,
  handleCreateScratchTerminal,
  newTempTaskShortcut,
  agentStatusState,
  setAgentStatusState,
  attentionTaskIds,
  agentStatusPanelShortcut,
  globalAgentPanelState,
  setGlobalAgentPanelState,
  globalAgentPanelShortcut,
  updateVersion,
  updateDownloadPercent
}: AppHeaderActionsProps): React.JSX.Element {
  const trpc = useTRPC()
  const restartForUpdate = useMutation(trpc.app.meta.restartForUpdate.mutationOptions())
  const btnSize = compact ? 'h-7 w-7' : 'size-10 rounded-lg'
  const iconSize = compact ? 'size-3.5' : 'size-5'
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => useTabStore.getState().toggleProjectScopedTabs()}
            className={cn(
              btnSize,
              'flex items-center justify-center transition-colors border-b-2',
              projectScopedTabs
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            )}
          >
            <FolderClosed className={iconSize} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {projectScopedTabs ? 'Show all tabs' : 'Show project tabs only'} ({projectTabsShortcut})
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setZenMode((prev) => !prev)}
            className={cn(
              btnSize,
              'flex items-center justify-center transition-colors border-b-2',
              zenMode
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            )}
          >
            <Focus className={iconSize} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {zenMode ? 'Exit zen mode' : 'Zen mode'} ({zenModeShortcut})
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            disabled={openTaskIds.length < 2}
            onClick={() => setExplodeMode((prev) => !prev)}
            className={cn(
              btnSize,
              'flex items-center justify-center transition-colors border-b-2',
              explodeMode
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground',
              openTaskIds.length < 2 && 'opacity-30 pointer-events-none'
            )}
          >
            <LayoutGrid className={iconSize} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {explodeMode ? 'Exit explode mode' : 'Explode mode'} ({explodeModeShortcut})
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="New temporary task"
            onClick={
              selectedProjectId && !durationLocked
                ? () => {
                    void handleCreateScratchTerminal()
                  }
                : undefined
            }
            disabled={!selectedProjectId || durationLocked}
            className={cn(
              btnSize,
              'flex items-center justify-center transition-colors',
              selectedProjectId && !durationLocked
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-muted-foreground/40 cursor-not-allowed'
            )}
          >
            <TerminalSquare className={iconSize} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-64">
          {!selectedProjectId ? (
            <p>Select a project first</p>
          ) : durationLocked ? (
            <p>Project locked</p>
          ) : (
            <div className="space-y-1">
              <p>{withShortcut('New temporary task', newTempTaskShortcut)}</p>
              <p className="text-muted-foreground">Temporary tasks auto-delete on close.</p>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <AgentStatusButton
        active={agentStatusState.isLocked}
        count={attentionTaskIds.size}
        onClick={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
        shortcutHint={agentStatusPanelShortcut}
        size={compact ? 'sm' : 'lg'}
      />
      <GlobalAgentPanelButton
        active={globalAgentPanelState.isOpen}
        disabled={!selectedProjectId}
        onClick={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
        shortcutHint={globalAgentPanelShortcut}
        size={compact ? 'sm' : 'lg'}
      />
      <UpdateButton
        version={updateVersion}
        downloadPercent={updateDownloadPercent}
        onRestart={() => restartForUpdate.mutate()}
        size={compact ? 'sm' : 'lg'}
      />
    </>
  )
}
