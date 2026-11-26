import { useMemo } from 'react'
import { terminalGroupIdsOf } from '@slayzone/task-contracts'
import { TerminalContainer } from '@slayzone/task-terminals'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * Another agent or terminal panel (`agent:*`, `terminal:*`): the task's terminal
 * groups it claims (`settings.terminalGroupIds`), in their own container. Creating
 * the panel created its first group (a terminal_tabs row); a group made here (+, ⌘T)
 * is claimed by this panel too. The primary agent panel shows every group no other
 * panel claims, so a group is never shown twice.
 */
export function TerminalInstanceKind({ panelId, instance }: PanelKindProps): React.JSX.Element {
  const {
    task,
    isActive,
    shortcutActive,
    isResizing,
    mainAgentCwd,
    openDevServerInBrowser,
    panels,
    agent
  } = useTaskPageContext()
  const {
    terminalHandles,
    terminalShortcutOwner,
    mainTerminal,
    handleQuickOpenFile,
    handleChatOpenArtifact
  } = agent
  const claimed = terminalGroupIdsOf(instance)
  const claimedKey = claimed.join('\n')
  // Stable while the claimed groups are unchanged (a new filter re-filters every group).
  const groupFilter = useMemo(
    () => ({ only: claimedKey === '' ? [] : claimedKey.split('\n') }),
    [claimedKey]
  )
  const kind = instance.kind === 'terminal' ? 'terminal' : 'agent'
  return (
    <PanelFrame kind={kind} panelId={panelId} className="overflow-hidden flex flex-col">
      {mainAgentCwd ? (
        <TerminalContainer
          ref={terminalHandles.ref(panelId)}
          groupFilter={groupFilter}
          onGroupCreated={(groupId) =>
            panels.updateInstanceSettings(panelId, {
              terminalGroupIds: [...claimed.filter((id) => id !== groupId), groupId]
            })
          }
          emptyState={
            <div
              className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-muted-foreground"
              data-testid="terminal-panel-empty"
            >
              No terminal in this panel. Start one with +.
            </div>
          }
          paused={isResizing}
          taskId={task.id}
          isTemporary={task.is_temporary}
          isActive={isActive}
          hasShortcutFocus={shortcutActive && terminalShortcutOwner === panelId}
          cwd={mainAgentCwd}
          defaultMode={mainTerminal.mode}
          executionContext={mainTerminal.executionContext}
          onOpenUrl={openDevServerInBrowser}
          onOpenFile={handleQuickOpenFile}
          onOpenArtifact={handleChatOpenArtifact}
          onOpenTask={agent.handleChatOpenTask}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
          This task has no folder to run in yet
        </div>
      )}
    </PanelFrame>
  )
}
