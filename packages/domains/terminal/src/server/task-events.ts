/**
 * Cross-domain task agent lifecycle seam — electron-free.
 *
 * A task's agents can live in several places: PTYs and chat transports in the
 * process hosting the runtime, and chats owned by a computer. Only the host knows
 * them all, so it registers the lifecycle handler via `setTaskAgentsStopper` at boot.
 * Default is a no-op so the server package works headless until then.
 *
 * Callers: a task reaching a terminal status (`onTaskReachedTerminal`, e.g.
 * integrations sync) and closing a scratch terminal's tab (`pty.killTask`).
 * Status completion preserves chat sessions so an agent can finish its own turn.
 * Explicit stop closes every agent. Saved conversations are never touched.
 */
export type TaskAgentStopReason = 'terminal-status' | 'explicit-stop'
type TaskAgentsStopper = (taskId: string, reason: TaskAgentStopReason) => void | Promise<void>

let stopper: TaskAgentsStopper = () => {
  // No-op until the host registers the real teardown: headless server callers
  // have no PTYs or chat transports to tear down.
}

export function setTaskAgentsStopper(fn: TaskAgentsStopper): void {
  stopper = fn
}

/** Stop every PTY and chat agent of a task; resolves once the teardown is sent. */
export async function stopTaskAgents(taskId: string): Promise<void> {
  await dispatchStop(taskId, 'explicit-stop')
}

async function dispatchStop(taskId: string, reason: TaskAgentStopReason): Promise<void> {
  await stopper(taskId, reason)
}

/** Completion stops PTYs; chat agents finish normally and remain available. */
export function onTaskReachedTerminal(taskId: string): void {
  void dispatchStop(taskId, 'terminal-status').catch((err: unknown) => {
    console.error('[task-events] failed to stop agents of task', taskId, err)
  })
}
