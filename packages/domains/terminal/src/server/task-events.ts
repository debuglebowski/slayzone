/**
 * Cross-domain "stop every agent of a task" seam — electron-free.
 *
 * A task's agents can live in several places: PTYs and chat transports in the
 * process hosting the runtime, and chats owned by a computer. Only the host knows
 * them all, so it registers the real teardown via `setTaskAgentsStopper` at boot.
 * Default is a no-op so the server package works headless until then.
 *
 * Callers: a task reaching a terminal status (`onTaskReachedTerminal`, e.g.
 * integrations sync) and closing a scratch terminal's tab (`pty.killTask`). The
 * task itself and its saved conversations are never touched.
 */
type TaskAgentsStopper = (taskId: string) => void | Promise<void>

let stopper: TaskAgentsStopper = () => {
  // No-op until the host registers the real teardown: headless server callers
  // have no PTYs or chat transports to tear down.
}

export function setTaskAgentsStopper(fn: TaskAgentsStopper): void {
  stopper = fn
}

/** Stop every PTY and chat agent of a task; resolves once the teardown is sent. */
export async function stopTaskAgents(taskId: string): Promise<void> {
  await stopper(taskId)
}

/** A task reached a terminal status (done/canceled): its agents stop. */
export function onTaskReachedTerminal(taskId: string): void {
  void stopTaskAgents(taskId).catch((err: unknown) => {
    console.error('[task-events] failed to stop agents of task', taskId, err)
  })
}
