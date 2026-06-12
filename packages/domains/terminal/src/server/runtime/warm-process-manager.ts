import { existsSync } from 'fs'
import type { IPty, IDisposable } from 'node-pty'
import type { SlayzoneDb } from '@slayzone/platform'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { spawnLoginShell } from './pty-manager'
import { buildMcpEnv } from '../mcp-env'

/**
 * Keeps ONE warm (idle, rc-initialized) login shell ready per project, so the first
 * agent a task opens skips shell-init cold start. A warm shell is held OUTSIDE the
 * pty-manager `sessions` map — it is a bare shell, not a registered terminal. It only
 * enters the session machinery at adopt time (`claimWarmShell` → `createPty({ adoptPty })`),
 * registered under its real `taskId:tabId` from the start, so terminal identity is never
 * renamed and the core I/O path is untouched.
 *
 * Gate: a project keeps a warm shell while it has ≥1 open task tab (unioned across windows).
 * The agent is launched (with the task-scoped env exported) only at adopt — so task identity
 * (`SLAYZONE_TASK_ID`, read by the `slay` CLI) is always correct. Shell-only warming means
 * flags / conversationId / prompt are applied at adopt and never need to match the warm shell.
 */

const WARM_MODE = 'claude-code' // default provider; only this mode is pre-warmed
const RECONCILE_DEBOUNCE_MS = 150
const MAX_SEED_BYTES = 64 * 1024 // cap the captured warm prompt; a bare shell emits ~hundreds of bytes

interface WarmHandle {
  pty: IPty
  cwd: string
  seedBuffer: string
  state: 'ready' | 'adopting'
  dataDisposable?: IDisposable
  exitDisposable?: IDisposable
}

interface WarmDeps {
  db: SlayzoneDb
  isEnabled: () => boolean
  getProjectRoot: (projectId: string) => Promise<string | null>
  /** Injectable for tests; defaults to the real shell spawn so cold + warm can't drift. */
  spawnShell?: typeof spawnLoginShell
}

let deps: WarmDeps | null = null
let shuttingDown = false
const warm = new Map<string /* projectId */, WarmHandle>()
const spawning = new Set<string /* projectId */>()
// Full per-window snapshot of open-task-tab counts keyed by projectId (renderer-sourced).
const tabCountsByWindow = new Map<number /* windowId */, Record<string, number>>()
let reconcileTimer: NodeJS.Timeout | undefined

export function initWarmProcessManager(d: WarmDeps): void {
  deps = d
  shuttingDown = false
}

/** Receive a window's full open-task-tab snapshot (keyed by projectId) and reconcile. */
export function setProjectTabCounts(windowId: number, counts: Record<string, number>): void {
  tabCountsByWindow.set(windowId, counts)
  scheduleReconcile()
}

/** Drop a window's contribution (on window close) and reconcile. */
export function clearWindowTabCounts(windowId: number): void {
  if (tabCountsByWindow.delete(windowId)) scheduleReconcile()
}

/**
 * Called from the `pty:create` handler before `createPty`. Returns the warm shell to adopt
 * (and re-arms a fresh one) if one is ready for this project and the spawn matches, else null.
 * Shell-only warming: only mode + cwd + fresh-start need to match — flags/conversation are
 * applied by createPty at adopt.
 */
export function claimWarmShell(criteria: {
  projectId: string
  mode: string
  cwd: string
  resuming: boolean
}): { pty: IPty; seedBuffer: string } | null {
  if (!deps || shuttingDown || !deps.isEnabled()) return null
  if (criteria.mode !== WARM_MODE) return null
  if (criteria.resuming) return null
  const handle = warm.get(criteria.projectId)
  if (!handle || handle.state !== 'ready') return null
  if (handle.cwd !== criteria.cwd) return null

  // Hand it off: stop draining its output, remove from the pool, re-arm.
  handle.state = 'adopting'
  handle.dataDisposable?.dispose()
  handle.exitDisposable?.dispose()
  warm.delete(criteria.projectId)
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.adopted',
    payload: { projectId: criteria.projectId, cwd: criteria.cwd }
  })
  // The task being opened still counts as ≥1 open tab, so re-arm immediately.
  void spawnWarm(criteria.projectId)
  return { pty: handle.pty, seedBuffer: handle.seedBuffer }
}

/** Kill every held warm shell. Call on app quit (also suppresses further spawns). */
export function teardownAllWarm(): void {
  shuttingDown = true
  if (reconcileTimer) {
    clearTimeout(reconcileTimer)
    reconcileTimer = undefined
  }
  for (const projectId of [...warm.keys()]) killWarm(projectId)
  tabCountsByWindow.clear()
}

/** Test/diagnostic hook: current warm state per project. */
export function getWarmStatus(): Record<string, WarmHandle['state']> {
  const out: Record<string, WarmHandle['state']> = {}
  for (const [projectId, handle] of warm) out[projectId] = handle.state
  return out
}

/** Test-only: kill all warm shells and clear every module-level bit of state. */
export function __resetForTests(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer)
    reconcileTimer = undefined
  }
  for (const projectId of [...warm.keys()]) killWarm(projectId)
  warm.clear()
  spawning.clear()
  tabCountsByWindow.clear()
  shuttingDown = false
}

function scheduleReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined
    void reconcile()
  }, RECONCILE_DEBOUNCE_MS)
}

async function reconcile(): Promise<void> {
  if (!deps || shuttingDown) return
  if (!deps.isEnabled()) {
    for (const projectId of [...warm.keys()]) killWarm(projectId)
    return
  }
  const desired = new Set<string>()
  for (const counts of tabCountsByWindow.values()) {
    for (const [projectId, count] of Object.entries(counts)) {
      if (count > 0) desired.add(projectId)
    }
  }
  // Tear down warm shells for projects with no open tabs.
  for (const projectId of [...warm.keys()]) {
    if (!desired.has(projectId)) killWarm(projectId)
  }
  // Spawn warm shells for newly active projects.
  for (const projectId of desired) {
    if (!warm.has(projectId) && !spawning.has(projectId)) void spawnWarm(projectId)
  }
}

async function spawnWarm(projectId: string): Promise<void> {
  if (!deps || shuttingDown || !deps.isEnabled()) return
  if (warm.has(projectId) || spawning.has(projectId)) return
  spawning.add(projectId)
  try {
    const cwd = await deps.getProjectRoot(projectId)
    if (!cwd || !existsSync(cwd)) return
    // Bare shell env: task-scoped vars (SLAYZONE_TASK_ID/PROJECT_ID) are omitted here and
    // exported at adopt. Same buildMcpEnv source as a cold spawn → no drift.
    const extraEnv = await buildMcpEnv(deps.db, undefined, WARM_MODE)
    // Re-check after awaits (gate may have closed / shutdown / raced).
    if (shuttingDown || warm.has(projectId)) return
    const result = (deps.spawnShell ?? spawnLoginShell)({ cwd, extraEnv })
    const handle: WarmHandle = { pty: result.pty, cwd, seedBuffer: '', state: 'ready' }
    // Drain the rc prompt into seedBuffer so it doesn't flash on adopt, and so RingBuffer
    // history stays consistent once the shell is registered.
    handle.dataDisposable = result.pty.onData((d) => {
      handle.seedBuffer = (handle.seedBuffer + d).slice(-MAX_SEED_BYTES)
    })
    handle.exitDisposable = result.pty.onExit(() => {
      if (warm.get(projectId) === handle) warm.delete(projectId)
    })
    warm.set(projectId, handle)
    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'warm.spawned',
      payload: { projectId, cwd }
    })
  } catch (err) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'warm.spawn_failed',
      message: (err as Error).message,
      payload: { projectId }
    })
  } finally {
    spawning.delete(projectId)
  }
}

function killWarm(projectId: string): void {
  const handle = warm.get(projectId)
  if (!handle) return
  warm.delete(projectId)
  handle.dataDisposable?.dispose()
  handle.exitDisposable?.dispose()
  try {
    handle.pty.kill()
  } catch {
    // Best-effort
  }
}
