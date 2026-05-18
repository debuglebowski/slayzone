import { requestEnsureAlive, hasPty, type EnsureAliveResult } from '@slayzone/terminal/main'
import { markTabSpawned, ensureMainTab } from '@slayzone/task-terminals/main'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

const DEFAULT_TIMEOUT_MS = 5_000
const FAILURE_CACHE_TTL_MS = 5_000

export type StartMainPtyResult =
  | EnsureAliveResult
  | 'no-task'

const failureCache = new Map<string, { result: EnsureAliveResult; expiresAt: number }>()

interface TaskRow { id: string; terminal_mode: string | null }

/** Main-tab sessionId convention (see TaskDetailPage.getMainSessionId): the
 *  renderer composes sessionId as `${taskId}:${tabId}` and the main tab uses
 *  tabId === taskId. */
export function mainSessionIdFor(taskId: string): string {
  return `${taskId}:${taskId}`
}

/** Inverse of mainSessionIdFor — returns the taskId if `sessionId` matches the
 *  main-tab convention (taskId === tabId), else null. Used by write/submit
 *  handlers to decide whether to auto-start a cold main PTY. Split panes
 *  (taskId !== tabId) return null and keep their strict 404. */
export function extractMainTaskId(sessionId: string): string | null {
  const parts = sessionId.split(':')
  if (parts.length !== 2 || !parts[0] || parts[0] !== parts[1]) return null
  return parts[0]
}

/** Ensure a task's main PTY is alive.
 *  - Verifies the task exists.
 *  - Ensures the main tab row exists via the shared `ensureMainTab` (same impl
 *    the `tabs:ensureMain` IPC handler uses) so CLI-driven flows don't race
 *    the renderer's mount-time row creation.
 *  - Flips `was_spawned=1` so TerminalStarter skips its idle gate on next mount.
 *  - Broadcasts `tabs:changed` so any open useTaskTerminals re-fetches the row
 *    and propagates the new `wasSpawned` prop to TerminalStarter, which then
 *    auto-mounts <Terminal> → spawns via pty:create IPC.
 *  - Broadcasts `app:open-task` so a closed task tab still gets mounted.
 *  - Awaits the renderer's ack via requestEnsureAlive (force:false). Renderer
 *    polls pty.exists and acks when alive.
 *  - 5s in-memory failure cache short-circuits repeated cold-write storms when
 *    the renderer can't mount. */
export async function startMainPty(
  deps: RestApiDeps,
  taskId: string,
  opts: { timeoutMs?: number } = {}
): Promise<StartMainPtyResult> {
  if (hasPty(mainSessionIdFor(taskId))) return 'already-alive'

  const task = deps.db
    .prepare('SELECT id, terminal_mode FROM tasks WHERE id = ?')
    .get(taskId) as TaskRow | undefined
  if (!task) return 'no-task'

  const cached = failureCache.get(taskId)
  if (cached && cached.expiresAt > Date.now()) return cached.result

  ensureMainTab(deps.db, taskId, task.terminal_mode ?? 'terminal')
  markTabSpawned(deps.db, taskId, true)
  broadcastToWindows('tabs:changed', { taskId })
  broadcastToWindows('app:open-task', taskId)

  const result = await requestEnsureAlive(taskId, {
    force: false,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  })

  if (result === 'ok' || result === 'already-alive') {
    failureCache.delete(taskId)
  } else if (result === 'timeout' || result === 'error') {
    failureCache.set(taskId, { result, expiresAt: Date.now() + FAILURE_CACHE_TTL_MS })
  }
  return result
}
