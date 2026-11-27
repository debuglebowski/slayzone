import type { Dispatch, SetStateAction } from 'react'
import { LayoutGrid, Check, Monitor, Bot, Bell, RotateCw } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import { DropdownMenuItem, DropdownMenuSeparator } from '@slayzone/ui'
import { useDialogStore } from '@slayzone/dialogs'
import {
  type AgentStatusState,
  type IdleTask,
  type GlobalAgentPanelState
} from '@slayzone/agent-panels'

interface TreeToolbarMoreItemsProps {
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
  updateVersion: string | null
}

/**
 * The app's own entries in the tree toolbar's More menu. In the tree view there is no
 * tab bar, so explode mode, the agent panels and active terminals live here.
 */
export function TreeToolbarMoreItems({
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
  updateVersion
}: TreeToolbarMoreItemsProps): React.JSX.Element {
  const trpc = useTRPC()
  const restartForUpdate = useMutation(trpc.app.meta.restartForUpdate.mutationOptions())
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => setExplodeMode((p) => !p)}
        disabled={openTaskIds.length < 2}
      >
        <LayoutGrid className="size-4" />
        <span>Explode mode</span>
        {explodeMode && <Check className="size-4 col-start-3" />}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => useDialogStore.getState().openTerminals()}>
        <Monitor className="size-4" />
        <span className="flex items-center gap-2">
          <span>Active terminals</span>
          {activePtyCount > 0 && <Count n={activePtyCount} />}
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
        disabled={!selectedProjectId}
      >
        <Bot className="size-4" />
        <span>Global Agent panel</span>
        {globalAgentPanelState.isOpen && <Check className="size-4 col-start-3" />}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
      >
        <Bell className="size-4" />
        <span className="flex items-center gap-2">
          <span>Agent status panel</span>
          {idleTasks.length > 0 && <Count n={idleTasks.length} />}
        </span>
        {agentStatusState.isLocked && <Check className="size-4 col-start-3" />}
      </DropdownMenuItem>
      {updateVersion && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => restartForUpdate.mutate()} className="text-green-500">
            <RotateCw className="size-4 text-current" />
            <span>Restart to install v{updateVersion}</span>
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

function Count({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-foreground text-background text-[10px] font-medium tabular-nums">
      {n}
    </span>
  )
}
