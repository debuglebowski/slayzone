import { randomUUID } from 'node:crypto'
import { existsSync } from 'fs'
import type { IPty, IDisposable } from 'node-pty'
import type { SlayzoneDb } from '@slayzone/platform'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { recordSessionSpawn, markSessionDead } from '@slayzone/task/server'
import { spawnLoginShell } from './pty-manager'
import { buildMcpEnv } from '../mcp-env'
import { buildExecCommand } from '../shell-env'
import { interpolateTemplate } from '../adapters/template-interpolation'
import { parseShellArgs } from '../adapters/flag-parser'

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
  /** Runtime session id of the pre-warmed agent (= `agent_sessions.id`,
   *  `status='pooled'`). Exported into the agent as `SLAYZONE_SESSION_ID` so its
   *  `slay` CLI + conversation hook resolve the task via session→task once the
   *  pool binds it (plans/agent-sessions.md slice 4/B). */
  sessionId: string
  /** Pre-minted conversation id for `{id}`-template agents (claude-code), so the
   *  warm agent's transcript + resume id are known before adoption. Null when the
   *  provider mints its own. */
  conversationId: string | null
  /** The mode default flags baked into the running agent. Adoption requires the
   *  task's flags to match (a live agent can't be re-flagged). */
  flags: string | null
  dataDisposable?: IDisposable
  exitDisposable?: IDisposable
}

/**
 * Data seam for every DB touchpoint of the warm pool (hub/runner split, wave 1).
 * The default impl (`createDbWarmPoolDataOps`) runs the same SQL / barrel calls
 * against the local db; an exec-side runner can inject a remote impl instead.
 */
export interface WarmPoolDataOps {
  /** The warmed mode's command template (`terminal_modes` row), or null if unknown. */
  getModeSpawnConfig(modeId: string): Promise<{
    initial_command: string | null
    default_flags: string | null
  } | null>
  /** Record the pooled session entity at warm spawn (status='pooled', no task/tab yet). */
  recordSessionSpawn(input: {
    id: string
    taskId: string | null
    tabId: string | null
    mode: string
    cwd: string
    expectedConversationId: string | null
    usedResume: boolean
    status: 'pooled'
  }): Promise<void>
  /** Mark a pooled session's process dead (reap/crash) so it never lingers as resumable. */
  markSessionDead(sessionId: string): Promise<void>
}

/** Default local-DB impl — same SQL / `@slayzone/task/server` calls as before the seam. */
export function createDbWarmPoolDataOps(db: SlayzoneDb): WarmPoolDataOps {
  return {
    async getModeSpawnConfig(modeId) {
      const row = await db.get<{
        initial_command: string | null
        default_flags: string | null
      }>(`SELECT initial_command, default_flags FROM terminal_modes WHERE id = ?`, [modeId])
      return row ?? null
    },
    recordSessionSpawn: (input) => recordSessionSpawn(db, input),
    markSessionDead: (sessionId) => markSessionDead(db, sessionId)
  }
}

interface WarmDeps {
  db: SlayzoneDb
  /** Data seam; defaults to the local-DB impl (`createDbWarmPoolDataOps(db)`) when omitted. */
  ops?: WarmPoolDataOps
  isEnabled: () => boolean
  getProjectRoot: (projectId: string) => Promise<string | null>
  /** Injectable for tests; defaults to the real shell spawn so cold + warm can't drift. */
  spawnShell?: typeof spawnLoginShell
}

type ResolvedWarmDeps = WarmDeps & { ops: WarmPoolDataOps }

let deps: ResolvedWarmDeps | null = null
let shuttingDown = false
const warm = new Map<string /* projectId */, WarmHandle>()
const spawning = new Set<string /* projectId */>()
// Full per-window snapshot of open-task-tab counts keyed by projectId (renderer-sourced).
const tabCountsByWindow = new Map<number /* windowId */, Record<string, number>>()
let reconcileTimer: NodeJS.Timeout | undefined

export function initWarmProcessManager(d: WarmDeps): void {
  deps = { ...d, ops: d.ops ?? createDbWarmPoolDataOps(d.db) }
  shuttingDown = false
}

/** Receive a window's full open-task-tab snapshot (keyed by projectId) and reconcile. */
export function setProjectTabCounts(windowId: number, counts: Record<string, number>): void {
  tabCountsByWindow.set(windowId, counts)
  // Diagnostic (d6efb204): confirms the renderer's report reaches THIS process,
  // and captures isEnabled + whether counts are non-empty — the three prime
  // suspects for "warm pass never fires".
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.tab_counts',
    payload: { windowId, counts, enabled: deps ? deps.isEnabled() : null, hasDeps: !!deps }
  })
  scheduleReconcile()
}

/** Drop a window's contribution (on window close) and reconcile. */
export function clearWindowTabCounts(windowId: number): void {
  if (tabCountsByWindow.delete(windowId)) scheduleReconcile()
}

/**
 * Called from the `pty:create` handler before `createPty`. Returns the warm agent to adopt
 * (and re-arms a fresh one) if one is ready for this project and the spawn matches, else null.
 * The agent is pre-booted with the mode's DEFAULT flags + a pre-minted conversation id, so a
 * spawn matches only when mode + cwd + fresh-start + flags all line up (a task overriding flags
 * cold-spawns). Returns the pooled `sessionId`/`conversationId` so createPty can bind + resume.
 */
export function claimWarmShell(criteria: {
  projectId: string
  mode: string
  cwd: string
  resuming: boolean
  /** The task's effective provider flags. Must equal the warm agent's baked
   *  default flags (it can't be re-flagged after boot) or there's no match.
   *  Optional: omitted ⇒ treated as no-flags (only matches a no-flags warm). */
  flags?: string | null
}): {
  pty: IPty
  seedBuffer: string
  preWarmedAgent: true
  sessionId: string
  conversationId: string | null
} | null {
  if (!deps || shuttingDown || !deps.isEnabled()) return null
  if (criteria.mode !== WARM_MODE) return null
  if (criteria.resuming) return null
  const handle = warm.get(criteria.projectId)
  if (!handle || handle.state !== 'ready') return null
  if (handle.cwd !== criteria.cwd) return null
  // Flags are baked into the running agent — adopt only on an exact match.
  if ((handle.flags ?? '') !== (criteria.flags ?? '')) return null

  // Hand it off: stop draining its output, remove from the pool, re-arm.
  handle.state = 'adopting'
  handle.dataDisposable?.dispose()
  handle.exitDisposable?.dispose()
  warm.delete(criteria.projectId)
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.adopted',
    sessionId: handle.sessionId,
    payload: { projectId: criteria.projectId, cwd: criteria.cwd }
  })
  // The task being opened still counts as ≥1 open tab, so re-arm immediately.
  void spawnWarm(criteria.projectId)
  return {
    pty: handle.pty,
    seedBuffer: handle.seedBuffer,
    preWarmedAgent: true,
    sessionId: handle.sessionId,
    conversationId: handle.conversationId
  }
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
    // Diagnostic (d6efb204): disabled → skip. Distinguishes "off" from "on but
    // never triggered".
    recordDiagnosticEvent({ level: 'info', source: 'pty', event: 'warm.reconcile_skip_disabled' })
    for (const projectId of [...warm.keys()]) killWarm(projectId)
    return
  }
  const desired = new Set<string>()
  for (const counts of tabCountsByWindow.values()) {
    for (const [projectId, count] of Object.entries(counts)) {
      if (count > 0) desired.add(projectId)
    }
  }
  const willSpawn = [...desired].filter((p) => !warm.has(p) && !spawning.has(p))
  // Diagnostic (d6efb204): the reconcile decision — desired projects, already-warm
  // keys, and which will actually spawn. Empty willSpawn with empty desired ⇒ no
  // counts reached us; empty desired with counts ⇒ projectId mapping issue.
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.reconcile',
    payload: { desired: [...desired], warmKeys: [...warm.keys()], willSpawn }
  })
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
    if (!cwd || !existsSync(cwd)) {
      // Diagnostic (d6efb204): project root missing/nonexistent → silent bail.
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'warm.spawn_skip_no_cwd',
        payload: { projectId, cwd: cwd ?? null }
      })
      return
    }
    // The warmed agent's command template (claude-code initial_command + flags).
    const modeRow = await deps.ops.getModeSpawnConfig(WARM_MODE)

    const sessionId = randomUUID()
    // claude-code pre-mints the conversation id (its initial_command has the
    // `{id}` placeholder), so the warm agent's transcript + resume id are known
    // before adoption. Providers without `{id}` mint their own → null here.
    const conversationId = modeRow?.initial_command?.includes('{id}') ? randomUUID() : null

    // Pooled env: SLAYZONE_SESSION_ID (no SLAYZONE_TASK_ID — there's no task yet),
    // but SLAYZONE_PROJECT_ID IS already known (the pool is per-project) — pass it
    // explicitly so it's set regardless of task binding. The agent's slay CLI +
    // conversation hook resolve the task via session→task once the pool binds it.
    // Same buildMcpEnv source as a cold spawn → no drift.
    const extraEnv = await buildMcpEnv(deps.db, undefined, WARM_MODE, sessionId, projectId)
    // Re-check after awaits (gate may have closed / shutdown / raced).
    if (shuttingDown || warm.has(projectId)) return
    const result = (deps.spawnShell ?? spawnLoginShell)({ cwd, extraEnv })
    const handle: WarmHandle = {
      pty: result.pty,
      cwd,
      seedBuffer: '',
      state: 'ready',
      sessionId,
      conversationId,
      flags: modeRow?.default_flags ?? null
    }
    // Drain the agent's boot output into seedBuffer so it replays on adopt and
    // RingBuffer history stays consistent once the session is registered.
    handle.dataDisposable = result.pty.onData((d) => {
      handle.seedBuffer = (handle.seedBuffer + d).slice(-MAX_SEED_BYTES)
    })
    handle.exitDisposable = result.pty.onExit(() => {
      if (warm.get(projectId) === handle) warm.delete(projectId)
      // The pooled session's process died (reap / crash) → mark it dead so a
      // stale `pooled` row never lingers as resumable.
      void deps!.ops.markSessionDead(sessionId).catch(() => {})
    })
    warm.set(projectId, handle)

    // Record the pooled session entity (status='pooled', no task/tab yet). The
    // conversation id is confirmed write-once by the agent's SessionStart hook
    // (keyed by SLAYZONE_SESSION_ID — see agent-hook).
    await deps.ops.recordSessionSpawn({
      id: sessionId,
      taskId: null,
      tabId: null,
      mode: WARM_MODE,
      cwd,
      expectedConversationId: conversationId,
      usedResume: false,
      status: 'pooled'
    })

    // Pre-boot the AGENT: exec the provider command in the warm shell. The pooled
    // env is already baked into the process (passed via extraEnv), so no export
    // prefix is needed — claude inherits SLAYZONE_SESSION_ID. This is the same
    // command a cold spawn builds; only the timing differs (now, not at adopt).
    if (modeRow?.initial_command) {
      const binary = interpolateTemplate({
        template: modeRow.initial_command,
        conversationId: conversationId || undefined,
        flags: parseShellArgs(modeRow.default_flags ?? undefined)
      })
      result.pty.write(`exec ${buildExecCommand(binary.name, binary.args)}\r`)
    }
    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'warm.agent_spawned',
      sessionId,
      payload: { projectId, cwd, hasConversationId: !!conversationId }
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
