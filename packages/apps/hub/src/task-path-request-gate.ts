/**
 * The ONE place a task's staged paths reach its computer before task-scoped work
 * there (robustness plan §9, P0; review 2 S3). The computer judges every task-scoped
 * request — a terminal, process, warm agent or exec started for a task, a file or git
 * request in its scope — against the task's folders, which it knows only once the
 * hub's staged `task-path` row has landed. Without this, work started right after a
 * connect (processes restarted on connect, an agent resumed) races the reconnect
 * handoff: the task's worktree is not yet one of its roots and the request is refused.
 *
 * Runs in the gateway's `beforeRequest`, so every routed request goes through it,
 * whatever backend sent it. It delivers only `task-path` rows (never a task's
 * history), and only rows whose computer is the request's (a task's paths go to the
 * computer holding its folders).
 *
 * @module hub/task-path-request-gate
 */
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { currentPathScope } from '@slayzone/platform/path-scope'

/** Spawns that name their task in their params (the computer's implicit spawn scope). */
const TASK_SPAWNS: ReadonlySet<string> = new Set([
  HubToComputerMethods.ptySpawn,
  HubToComputerMethods.ptyWarmSpawn,
  HubToComputerMethods.ptyWarmAdopt,
  HubToComputerMethods.procSpawn
])

/** The task a request to a computer is scoped to, or null. */
export function requestTaskScope(method: string, params: unknown): string | null {
  // The handoff itself travels as chat requests: never gate them (they deliver).
  if (method === HubToComputerMethods.chatRequest) return null
  const scope = currentPathScope()
  if (scope) return scope.kind === 'task' ? scope.taskId : null
  if (!TASK_SPAWNS.has(method) || typeof params !== 'object' || params === null) return null
  const taskId = (params as { taskId?: unknown }).taskId
  return typeof taskId === 'string' && taskId ? taskId : null
}

export function createTaskPathRequestGate(opts: {
  /** Deliver the task's staged `task-path` row to `computerId` (handoff `flushTask`). */
  flushTaskPaths(taskId: string, computerId: string): Promise<void>
}) {
  return async (computerId: string, method: string, params: unknown): Promise<void> => {
    const taskId = requestTaskScope(method, params)
    if (taskId) await opts.flushTaskPaths(taskId, computerId)
  }
}
