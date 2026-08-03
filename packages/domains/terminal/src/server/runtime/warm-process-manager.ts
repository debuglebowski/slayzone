import { randomUUID } from 'node:crypto'
import { existsSync } from 'fs'
import type { SlayzoneDb } from '@slayzone/platform'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { recordSessionSpawn, markSessionDead } from '@slayzone/task/server'
import { buildBaseEnv, maybeReinstallHooksForSpawn } from './pty-manager'
import { getPtyBackend } from './pty-backend'
import { buildMcpEnv } from '../mcp-env'
import { buildExecCommand, getShellStartupArgs, resolveUserShell } from '../shell-env'
import { interpolateTemplate } from '../adapters/template-interpolation'
import { parseShellArgs } from '../adapters/flag-parser'

/**
 * Keeps ONE warm, pre-booted agent ready per (runner, project), so the first agent a
 * task opens skips both shell-init and agent boot. The warm process lives ON THE
 * RUNNER — never on the hub — and is held outside the pty-manager `sessions` map
 * until `claimWarmShell` → `createPty({ adoptPty })` promotes it, registered under
 * its real `taskId:tabId` from the start so terminal identity is never renamed.
 *
 * Gate: a (runner, project) keeps a warm agent while that project has ≥1 open task
 * tab (unioned across windows).
 *
 * **The agent is pre-BOOTED, not merely a warm shell.** `spawnWarm` execs the mode's
 * provider command immediately, with the mode's DEFAULT flags and a pre-minted
 * conversation id, so adoption requires mode + cwd + fresh-start + flags to match (a
 * live agent cannot be re-flagged). Task identity is resolved through the pooled
 * `agent_sessions` row rather than baked in: the warm env carries
 * `SLAYZONE_SESSION_ID` + `SLAYZONE_PROJECT_ID` but no `SLAYZONE_TASK_ID`, and the
 * agent's `slay` CLI + conversation hook resolve the task via session→task once the
 * pool binds it.
 *
 * Adoption is a REKEY on the runner (`pty.warmAdopt`), not a handoff of a live
 * process object: the runner renames the session in place, so pid, output buffer and
 * seq counter all carry over and the hub receives an ordinary routed handle. That is
 * what makes a warm pool possible across a wire at all.
 */

const WARM_MODE = 'claude-code' // default provider; only this mode is pre-warmed
const RECONCILE_DEBOUNCE_MS = 150
// (No seed cap here any more — the RUNNER buffers warm output in its own
// RingBuffer, which is already capped at 750 KiB and evicts oldest-first.)

interface WarmHandle {
  /** Placeholder key the RUNNER files this session under until adoption rekeys it. */
  warmId: string
  /** The runner holding the process. Part of the pool key — a warm agent is only
   *  useful to a task that resolves to the SAME machine. */
  runnerId: string
  cwd: string
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
}

/**
 * Output buffering and device-status filtering are NOT done here any more.
 *
 * The runner buffers a warm session in its own RingBuffer and hands the whole
 * thing over at `pty.warmAdopt`, which the routing backend emits as ONE chunk
 * through the ordinary session data path — so it passes through pty-manager's
 * `onData` (`interceptSyncQueries` + `filterBufferData`) exactly like live output.
 *
 * That retires the stateful stripper this module used to run. It existed because
 * the old hub-local warm drain BYPASSED `onData`, so cursor-position queries
 * (`ESC [ ? 6 n`) accumulated unfiltered and replayed at adopt — and a stateless
 * per-chunk regex could not catch them, since node-pty splits `ESC [ ? 6` and `n`
 * across read boundaries. Neither hazard survives the move: nothing bypasses
 * `onData`, and the seed arrives as a single contiguous chunk with no torn tail.
 */

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
  /**
   * Refresh whatever `isEnabled` reads, awaited before each reconcile.
   *
   * `isEnabled` must stay SYNC (it is consulted on the claim path), so the enabled
   * flag is a cache. Its owner refreshes it off a settings-changed event — but
   * `settings.set` does not emit one, so toggling pre-warm in Settings previously
   * did nothing until the next restart. Re-reading here makes the toggle take
   * effect on the next reconcile, which is the only place the flag actually gates
   * work.
   */
  refreshEnabled?: () => Promise<void>
  getProjectRoot: (projectId: string) => Promise<string | null>
  /**
   * Which runner a task in this project would spawn on. `null` ⇒ no usable
   * runner, so nothing is warmed — warming on a machine no task will resolve to
   * would boot a billable agent nobody can adopt.
   */
  resolveRunnerId: (projectId: string) => Promise<string | null>
}

type ResolvedWarmDeps = WarmDeps & { ops: WarmPoolDataOps }

let deps: ResolvedWarmDeps | null = null
let shuttingDown = false
/**
 * Keyed by projectId. One warm agent per project, on whichever runner that
 * project currently resolves to — the handle carries its own `runnerId`, and a
 * claim only matches when the claimant resolves to that same runner (a warm agent
 * on machine A is worthless to a task that will run on machine B).
 */
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
  /** The runner this spawn will run on. Must equal the warm agent's runner — a
   *  pre-booted process on another machine cannot be adopted. */
  runnerId: string
  /** The task's effective provider flags. Must equal the warm agent's baked
   *  default flags (it can't be re-flagged after boot) or there's no match.
   *  Optional: omitted ⇒ treated as no-flags (only matches a no-flags warm). */
  flags?: string | null
}): {
  warmId: string
  runnerId: string
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
  // The process lives on ONE machine; a spawn routed elsewhere must cold-spawn.
  if (handle.runnerId !== criteria.runnerId) return null
  // Flags are baked into the running agent — adopt only on an exact match.
  if ((handle.flags ?? '') !== (criteria.flags ?? '')) return null

  // Hand it off. No output plumbing to unwind: the runner has been buffering all
  // along and replays it in the `pty.warmAdopt` reply.
  handle.state = 'adopting'
  warm.delete(criteria.projectId)
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.adopted',
    sessionId: handle.sessionId,
    payload: { projectId: criteria.projectId, cwd: criteria.cwd, runnerId: handle.runnerId }
  })
  // The task being opened still counts as ≥1 open tab, so re-arm immediately.
  void spawnWarm(criteria.projectId)
  return {
    warmId: handle.warmId,
    runnerId: handle.runnerId,
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
  // Pick up a pre-warm toggle made since the last pass (see `refreshEnabled`).
  await deps.refreshEnabled?.()
  if (shuttingDown) return
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
    // KNOWN LIMITATION: this probes the HUB's filesystem, but the warm agent now
    // spawns on the runner's. Correct for a co-located runner (the overwhelmingly
    // common case, and the only one pre-warm has ever been exercised in); for a
    // genuinely remote runner it can bail on a path that exists there, or admit one
    // that does not — in which case the spawn fails runner-side and is caught below
    // as `warm.spawn_failed`, i.e. it degrades to "no warm agent", never to a wrong
    // one. Fixing it properly needs a routed existence probe, which belongs with the
    // broader remote-workspace question (where does a remote task's cwd come from at
    // all) rather than here.
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

    // Which machine will this project's tasks actually run on? Warming anywhere
    // else boots an agent (billable, with no task) that nothing can ever adopt.
    const runnerId = await deps.resolveRunnerId(projectId)
    if (runnerId == null) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'warm.spawn_skip_no_runner',
        payload: { projectId }
      })
      return
    }
    const backend = getPtyBackend()
    if (!backend.warmSpawn) {
      // Local/test backend: no warm pool. Agents run on runners, so there is no
      // hub-local warm path to fall back to — by design, not by omission.
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'warm.spawn_skip_unsupported_backend',
        payload: { projectId }
      })
      return
    }
    // Re-check after awaits (gate may have closed / shutdown / raced).
    if (shuttingDown || warm.has(projectId)) return
    // Spawn-time hook self-heal for the WARM path. A pre-warmed agent's notify.sh
    // hooks fire from warm time (before any task), and it's NEVER healed at
    // adoption (createPty skips preWarmedAgent) — so if we don't heal here, the
    // warm pool is the one spawn path that can run through a stale cross-release-channel
    // script. That is the exact frozen-env population the clobber bug made
    // invisible, so healing here is load-bearing, not belt-and-suspenders.
    maybeReinstallHooksForSpawn(WARM_MODE)

    // The agent command is built HERE and sent as `postSpawnCommand`, so the
    // runner execs it inside the freshly rc-initialized shell. Building it hub-side
    // keeps the hub the sole authority on mode templates + conversation ids; the
    // runner stays a byte pipe that does what it is told.
    let postSpawnCommand: string | undefined
    if (modeRow?.initial_command) {
      const binary = interpolateTemplate({
        template: modeRow.initial_command,
        conversationId: conversationId || undefined,
        flags: parseShellArgs(modeRow.default_flags ?? undefined)
      })
      postSpawnCommand = `exec ${buildExecCommand(binary.name, binary.args)}`
    }

    const warmId = `warm:${sessionId}`
    const shell = resolveUserShell()
    await backend.warmSpawn(runnerId, {
      warmId,
      command: shell,
      args: getShellStartupArgs(shell),
      cwd,
      env: { ...buildBaseEnv(), ...extraEnv },
      ...(postSpawnCommand ? { postSpawnCommand } : {})
    })

    const handle: WarmHandle = {
      warmId,
      runnerId,
      cwd,
      state: 'ready',
      sessionId,
      conversationId,
      flags: modeRow?.default_flags ?? null
    }
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

    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'warm.agent_spawned',
      sessionId,
      payload: { projectId, cwd, runnerId, hasConversationId: !!conversationId }
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
  // The process is the RUNNER's, so this is a request, not a local kill — and it
  // is fire-and-forget: a runner that has gone away already took its warm agents
  // with it, and `reapOrphanWarms` covers anything that outlives us.
  void getPtyBackend()
    .warmKill?.(handle.runnerId, handle.warmId)
    .catch(() => {})
  // The pooled session's process is gone → mark it dead so a stale `pooled` row
  // never lingers as resumable. Previously driven by the local pty's onExit,
  // which no longer exists here (warm output/exit is the runner's business until
  // adoption).
  void deps?.ops.markSessionDead(handle.sessionId).catch(() => {})
}

/**
 * Kill warm sessions on `runnerId` that this hub is not tracking.
 *
 * Warm agents are the RUNNER's processes now, so — unlike the old hub-local pool,
 * whose children died with the hub — they survive a hub restart, a sidecar
 * restart, or any reconnect that rebuilt the pool map. An unclaimed pre-booted
 * agent is a billable LLM process with no owner, so the hub reconciles against
 * the runner's own list whenever a runner (re)connects and reaps the difference.
 */
export async function reapOrphanWarms(runnerId: string): Promise<void> {
  const backend = getPtyBackend()
  if (!backend.warmList || !backend.warmKill) return
  try {
    const remote = await backend.warmList(runnerId)
    const tracked = new Set(
      [...warm.values()].filter((h) => h.runnerId === runnerId).map((h) => h.warmId)
    )
    for (const entry of remote) {
      if (tracked.has(entry.warmId)) continue
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'warm.orphan_reaped',
        payload: { runnerId, warmId: entry.warmId, pid: entry.pid }
      })
      await backend.warmKill(runnerId, entry.warmId).catch(() => {})
    }
  } catch {
    // Best-effort: a runner that cannot answer warmList has nothing we can reap.
  }
}
