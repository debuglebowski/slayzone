import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Skeleton } from '@slayzone/ui'
import { Terminal } from '@slayzone/terminal/client/LazyTerminal'
import { useTerminalModes } from '@slayzone/terminal/client'
import { requestAgentStart } from '@slayzone/task-terminals'
import { TaskShell } from './TaskShell'
import { mainTerminalProps } from '../shared/main-terminal'
import { useHubId } from '@slayzone/transport/client'
import {
  getTerminalFirst,
  isTerminalFirstHolding,
  markTerminalFirstReady,
  subscribeTerminalFirst,
  type TerminalFirstEntry
} from './terminal-first'
import { taskDetailCache } from './taskDetailCache'

export { markTerminalFirst } from './terminal-first'

/**
 * Suspense fallback for a task page. A task marked terminal-first
 * (`markTerminalFirst`) gets its main terminal at once; any other task the skeleton.
 */
/**
 * Whether the task page must wait for this task's terminal-first pane (its agent
 * not up yet — see `TERMINAL_FIRST_HOLD_MAX_MS`). The pane renders meanwhile.
 */
export function useTerminalFirstHolding(taskId: string): boolean {
  return useSyncExternalStore(subscribeTerminalFirst, () => isTerminalFirstHolding(taskId))
}

export function TaskPaneFallback({ taskId }: { taskId: string }): React.JSX.Element {
  const entry = useSyncExternalStore(subscribeTerminalFirst, () => getTerminalFirst(taskId))
  return entry ? <TerminalFirstShell entry={entry} /> : <TaskShell />
}

/**
 * The task's main terminal, mounted while the task page loads. Spawns the session
 * exactly as the page would (`mainTerminalProps`, same cwd), so when the page mounts
 * its own terminal it reattaches this one's live xterm (terminal cache) — the agent
 * keeps running and the user keeps typing across the swap.
 */
function TerminalFirstShell({ entry }: { entry: TerminalFirstEntry }): React.JSX.Element {
  const { task, project, cwd } = entry
  const sessionId = `${task.id}:${task.id}`
  const { modes } = useTerminalModes()
  const props = mainTerminalProps(task, project, modes)

  useEffect(
    () => () => {
      // The page's terminal starter may mount right after this unmounts: hand it
      // the running agent so it reattaches at once instead of asking whether to
      // start. The mark itself stays until the page mounts (`TaskDetailDataLoader`)
      // — this pane can unmount and remount as the pane hydrates and suspends.
      requestAgentStart(sessionId)
    },
    [sessionId]
  )

  // Focus as soon as the xterm exists (before its session is up — input typed
  // meanwhile is held, see input-gate.ts), not when the agent is ready.
  const focusOnAttach = useCallback((api: { focus: () => void }) => api.focus(), [])
  // The agent is up: let the page mount (its data is already loading, below).
  const releasePage = useCallback(() => markTerminalFirstReady(task.id), [task.id])
  const hubId = useHubId() ?? undefined
  useEffect(() => {
    void taskDetailCache.prefetch('taskDetail', task.id, hubId)
  }, [task.id, hubId])

  return (
    <div className="flex flex-col h-full" data-terminal-first={task.id}>
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Skeleton className="h-5 w-40" />
        <div className="flex-1" />
      </div>
      <div className="flex-1 min-h-0 relative">
        <Terminal
          sessionId={sessionId}
          cwd={cwd}
          mode={props.mode}
          conversationId={props.conversationId}
          existingConversationId={props.existingConversationId}
          supportsSessionId={props.supportsSessionId}
          providerFlags={props.providerFlags}
          executionContext={props.executionContext}
          isActive
          onAttached={focusOnAttach}
          onReady={releasePage}
        />
      </div>
    </div>
  )
}
