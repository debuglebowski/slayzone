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
 * Keeps ONE warm, pre-booted agent ready per (computer, project), so the first agent a
 * task opens skips both shell-init and agent boot. The warm process lives ON THE
 * COMPUTER — never on the hub — and is held outside the pty-manager `sessions` map
 * until `claimWarmShell` → `createPty({ adoptPty })` promotes it, registered under
 * its real `taskId:tabId` from the start so terminal identity is never renamed.
 *
 * Gate: a (computer, project) keeps a warm agent while that project has ≥1 open task
 * tab (unioned across windows).
 *
 * **The agent is pre-BOOTED, not merely a warm shell.** `spawnWarm` execs the mode's
 * provider command immediately, with the mode's DEFAULT flags and a pre-minted
 * conversation id, so adoption requires mode + cwd + fresh-start + flags to match (a
 * live agent cannot be re-flagged).
 *
 * **The agent boots with the id of a task that does not exist yet.** Each warm agent
 * gets a pre-minted task id in `SLAYZONE_TASK_ID` (and in its hook context), so an
 * agent always knows its task — there is no second identity to resolve it through.
 * A task created to be opened right away takes that id (`reserveWarmTaskId`, called
 * from task create), and its first `pty:create` adopts the agent (`claimWarmShell`).
 * Nothing is written to `tasks` early: until the create, the id lives only in the
 * agent's env and this module's memory. An agent whose id is never used dies with it
 * (TTL, teardown, mismatch at claim) — the id is single-use.
 *
 * So the pool only serves a task created and opened in one go. An older task opening
 * its first agent cold-spawns: its id is already fixed, and a live agent's env cannot
 * be changed.
 *
 * Adoption is a REKEY on the computer (`pty.warmAdopt`), not a handoff of a live
 * process object: the computer renames the session in place, so pid, output buffer and
 * seq counter all carry over and the hub receives an ordinary routed handle. That is
 * what makes a warm pool possible across a wire at all.
 */

const WARM_MODE = 'claude-code' // default provider; only this mode is pre-warmed
const RECONCILE_DEBOUNCE_MS = 150
/**
 * How long a reserved agent waits for its task's first `pty:create`. The create and
 * the open are one user action, so this only bounds the case where the tab never
 * spawns (closed at once, renderer crash): an unclaimed pre-booted agent is billable.
 */
const DEFAULT_RESERVE_TTL_MS = 60_000
// (No seed cap here any more — the COMPUTER buffers warm output in its own
// RingBuffer, which is already capped at 750 KiB and evicts oldest-first.)

interface WarmHandle {
  /** Placeholder key the COMPUTER files this session under until adoption rekeys it. */
  warmId: string
  /** The computer holding the process. Part of the pool key — a warm agent is only
   *  useful to a task that resolves to the SAME machine. */
  computerId: string
  projectId: string
  cwd: string
  /** `booting`: registered (and its pooled row written) before the computer is asked
   *  to spawn it, so a hook that fires during boot already finds it. `ready`: can be
   *  reserved. `reserved`: handed to a task being created, waiting for its spawn. */
  state: 'booting' | 'ready' | 'reserved'
  /** The id the task that adopts this agent gets. In the agent's env as
   *  `SLAYZONE_TASK_ID` from boot; no `tasks` row exists until the create. */
  taskId: string
  /** The pooled `agent_sessions.id`. Internal: it keys the session ledger row (the
   *  conversation is confirmed on it before adoption, bound to the task at adoption)
   *  and the computer's `warmId`. The agent itself never sees it. */
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
 * The computer buffers a warm session in its own RingBuffer and hands the whole
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
 * Data seam for every DB touchpoint of the warm pool (hub/computer split, wave 1).
 * The default impl (`createDbWarmPoolDataOps`) runs the same SQL / barrel calls
 * against the local db; an exec-side computer can inject a remote impl instead.
 */
export interface WarmPoolDataOps {
  /** The warmed mode's command template (`terminal_modes` row), or null if unknown. */
  getModeSpawnConfig(modeId: string): Promise<{
    initial_command: string | null
    default_flags: string | null
  } | null>
  /** Record the pooled session entity at warm spawn (status='pooled', no task/tab yet —
   *  the reserved task id has no `tasks` row, and `task_id` is a foreign key). */
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
   * Which computer a task in this project would spawn on. `null` ⇒ no usable
   * computer, so nothing is warmed — warming on a machine no task will resolve to
   * would boot a billable agent nobody can adopt.
   */
  resolveComputerId: (projectId: string) => Promise<string | null>
  /** Override of {@link DEFAULT_RESERVE_TTL_MS} (tests). */
  reserveTtlMs?: number
}

type ResolvedWarmDeps = WarmDeps & { ops: WarmPoolDataOps }

let deps: ResolvedWarmDeps | null = null
let shuttingDown = false
/** Bumped by `__resetForTests`, so a spawn still in flight from a previous test
 *  bails instead of landing in the next one. */
let epoch = 0
/**
 * Keyed by projectId. One warm agent per project (booting or ready), on whichever
 * computer that project currently resolves to — the handle carries its own
 * `computerId`, and a reserve only matches when the project still resolves to that
 * same computer (a warm agent on machine A is worthless to a task on machine B).
 */
const warm = new Map<string /* projectId */, WarmHandle>()
/** Reserved for a task being created, keyed by that task's id, until its first
 *  `pty:create` claims it or its TTL runs out. */
const reserved = new Map<string /* taskId */, { handle: WarmHandle; timer: NodeJS.Timeout }>()
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
 * Called by task create for a task that will be opened right away. Hands the
 * project's ready agent to that task: returns the task id the agent booted with,
 * which the caller MUST use as the new task's id — or null (no ready agent, or it
 * could not serve this task), in which case the caller mints its own and the task
 * cold-spawns.
 *
 * The agent moves out of the ready slot at once, so no other task can take it, and
 * the project re-arms. `mode` and `flags` are the task's: a live agent cannot change
 * either, so a mismatch is a miss here rather than a kill at claim.
 */
export async function reserveWarmTaskId(criteria: {
  projectId: string
  mode: string
  /** The task's effective flags for `mode`. Must equal the agent's baked defaults. */
  flags: string | null
}): Promise<string | null> {
  if (!deps || shuttingDown || !deps.isEnabled()) return null
  if (criteria.mode !== WARM_MODE) return null
  const handle = warm.get(criteria.projectId)
  if (!handle || handle.state !== 'ready') return null
  if ((handle.flags ?? '') !== (criteria.flags ?? '')) return null
  // A new task runs where its project resolves NOW; the agent was booted wherever the
  // project resolved then.
  const computerId = await deps.resolveComputerId(criteria.projectId)
  if (computerId !== handle.computerId) return null
  // Re-check after the await: the agent may have been reserved, killed or replaced.
  if (shuttingDown || warm.get(criteria.projectId) !== handle || handle.state !== 'ready') {
    return null
  }

  warm.delete(criteria.projectId)
  handle.state = 'reserved'
  const ttl = deps.reserveTtlMs ?? DEFAULT_RESERVE_TTL_MS
  const timer = setTimeout(() => {
    if (reserved.get(handle.taskId)?.handle !== handle) return
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'warm.reservation_expired',
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      payload: { projectId: handle.projectId, ttlMs: ttl }
    })
    killReserved(handle.taskId)
  }, ttl)
  timer.unref?.()
  reserved.set(handle.taskId, { handle, timer })
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.reserved',
    sessionId: handle.sessionId,
    taskId: handle.taskId,
    payload: { projectId: handle.projectId, computerId: handle.computerId }
  })
  // The task being opened will count as an open tab, so re-arm now.
  void spawnWarm(criteria.projectId)
  return handle.taskId
}

/**
 * Called from the `pty:create` handler before `createPty`. Returns the warm agent to
 * adopt when one was reserved for this task (see `reserveWarmTaskId`), else null.
 *
 * The reservation is consumed either way. On a mismatch (the spawn is not the fresh,
 * default-flagged, project-root agent the reservation predicted) the agent is killed:
 * it carries this task's id, so no other task can use it, and this one cold-spawns.
 * Returns the pooled `sessionId`/`conversationId` so createPty can bind + resume.
 */
export function claimWarmShell(criteria: {
  taskId: string
  mode: string
  cwd: string
  resuming: boolean
  /** The computer this spawn will run on. Must equal the warm agent's computer — a
   *  pre-booted process on another machine cannot be adopted. */
  computerId: string
  /** The task's effective provider flags. Must equal the warm agent's baked
   *  default flags (it can't be re-flagged after boot) or there's no match.
   *  Optional: omitted ⇒ treated as no-flags (only matches a no-flags warm). */
  flags?: string | null
}): {
  warmId: string
  computerId: string
  preWarmedAgent: true
  sessionId: string
  conversationId: string | null
} | null {
  const entry = reserved.get(criteria.taskId)
  if (!entry) return null
  const { handle } = entry
  const mismatch =
    !deps || shuttingDown || !deps.isEnabled()
      ? 'disabled'
      : criteria.mode !== WARM_MODE
        ? 'mode'
        : criteria.resuming
          ? 'resuming'
          : handle.cwd !== criteria.cwd
            ? 'cwd'
            : handle.computerId !== criteria.computerId
              ? 'computer'
              : (handle.flags ?? '') !== (criteria.flags ?? '')
                ? 'flags'
                : null
  if (mismatch) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'warm.reservation_mismatch',
      sessionId: handle.sessionId,
      taskId: criteria.taskId,
      payload: {
        reason: mismatch,
        projectId: handle.projectId,
        warmCwd: handle.cwd,
        cwd: criteria.cwd,
        warmComputerId: handle.computerId,
        computerId: criteria.computerId
      }
    })
    killReserved(criteria.taskId)
    return null
  }

  // Hand it off. No output plumbing to unwind: the computer has been buffering all
  // along and replays it in the `pty.warmAdopt` reply.
  clearTimeout(entry.timer)
  reserved.delete(criteria.taskId)
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'warm.adopted',
    sessionId: handle.sessionId,
    taskId: criteria.taskId,
    payload: { projectId: handle.projectId, cwd: criteria.cwd, computerId: handle.computerId }
  })
  return {
    warmId: handle.warmId,
    computerId: handle.computerId,
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
  for (const taskId of [...reserved.keys()]) killReserved(taskId)
  tabCountsByWindow.clear()
}

/**
 * The warm agent that booted with `taskId` and has not been adopted yet — booting,
 * ready, or reserved — or null. Such an agent's hooks name a task that may not exist
 * yet (it exists once reserved and created, but no terminal holds the agent until the
 * claim), so the hook route reads this to treat them as pool hooks, and the hub reads
 * it to decide whose they are (T-18): the project it was warmed for, on the computer
 * holding it.
 */
export function unadoptedWarmAgent(
  taskId: string
): { sessionId: string; projectId: string; computerId: string } | null {
  const handle = reserved.get(taskId)?.handle ?? [...warm.values()].find((h) => h.taskId === taskId)
  if (!handle) return null
  return { sessionId: handle.sessionId, projectId: handle.projectId, computerId: handle.computerId }
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
  for (const taskId of [...reserved.keys()]) killReserved(taskId)
  warm.clear()
  reserved.clear()
  spawning.clear()
  tabCountsByWindow.clear()
  shuttingDown = false
  epoch++
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
    for (const taskId of [...reserved.keys()]) killReserved(taskId)
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
  const spawnEpoch = epoch
  try {
    const cwd = await deps.getProjectRoot(projectId)
    // KNOWN LIMITATION: this probes the HUB's filesystem, but the warm agent now
    // spawns on the computer's. Correct for a co-located computer (the overwhelmingly
    // common case, and the only one pre-warm has ever been exercised in); for a
    // genuinely remote computer it can bail on a path that exists there, or admit one
    // that does not — in which case the spawn fails computer-side and is caught below
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
    // The id of the task this agent will serve. Only ever used if a task is created
    // under it (`reserveWarmTaskId`); no row is written for it here.
    const taskId = randomUUID()
    // claude-code pre-mints the conversation id (its initial_command has the
    // `{id}` placeholder), so the warm agent's transcript + resume id are known
    // before adoption. Providers without `{id}` mint their own → null here.
    const conversationId = modeRow?.initial_command?.includes('{id}') ? randomUUID() : null

    // The agent's identity is its (future) task id, exactly like a cold spawn's — same
    // buildMcpEnv source, so no drift. The project id is passed explicitly: there is
    // no task row to derive it from yet.
    const extraEnv = await buildMcpEnv(deps.db, taskId, WARM_MODE, projectId)

    // Which machine will this project's tasks actually run on? Warming anywhere
    // else boots an agent (billable, with no task) that nothing can ever adopt.
    const computerId = await deps.resolveComputerId(projectId)
    if (computerId == null) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'warm.spawn_skip_no_computer',
        payload: { projectId }
      })
      return
    }
    const backend = getPtyBackend()
    if (!backend.warmSpawn) {
      // Local/test backend: no warm pool. Agents run on computers, so there is no
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
    if (shuttingDown || spawnEpoch !== epoch || warm.has(projectId)) return
    // Spawn-time hook self-heal for the WARM path. A pre-warmed agent's notify.sh
    // hooks fire from warm time (before any task), and it's NEVER healed at
    // adoption (createPty skips preWarmedAgent) — so if we don't heal here, the
    // warm pool is the one spawn path that can run through a stale cross-release-channel
    // script. That is the exact frozen-env population the clobber bug made
    // invisible, so healing here is load-bearing, not belt-and-suspenders.
    maybeReinstallHooksForSpawn(WARM_MODE)

    // The agent command is built HERE and sent as `postSpawnCommand`, so the
    // computer execs it inside the freshly rc-initialized shell. Building it hub-side
    // keeps the hub the sole authority on mode templates + conversation ids; the
    // computer stays a byte pipe that does what it is told.
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
    const handle: WarmHandle = {
      warmId,
      computerId,
      projectId,
      cwd,
      state: 'booting',
      taskId,
      sessionId,
      conversationId,
      flags: modeRow?.default_flags ?? null
    }
    // Registered, and its pooled row written, BEFORE the computer is asked to boot
    // it: the agent's SessionStart hook confirms its conversation on that row, found
    // through this handle, and may fire before `warmSpawn` returns.
    warm.set(projectId, handle)
    try {
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
      const shell = resolveUserShell()
      await backend.warmSpawn(computerId, {
        warmId,
        command: shell,
        args: getShellStartupArgs(shell),
        cwd,
        env: { ...buildBaseEnv(), ...extraEnv },
        ...(postSpawnCommand ? { postSpawnCommand } : {})
      })
    } catch (err) {
      if (warm.get(projectId) === handle) warm.delete(projectId)
      void deps.ops.markSessionDead(sessionId).catch(() => {
        // Best-effort: a pooled row is only ever bound through this handle, which is
        // gone, so a stale one is never resumed.
      })
      throw err
    }
    if (warm.get(projectId) !== handle) {
      // Torn down while booting (gate closed, pre-warm off, shutdown). That kill may
      // have reached the computer before the spawn did, so ask again.
      void backend.warmKill?.(computerId, warmId).catch(() => {
        // Unreachable computer: its warm agents are already gone.
      })
      return
    }
    handle.state = 'ready'

    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'warm.agent_spawned',
      sessionId,
      taskId,
      payload: { projectId, cwd, computerId, hasConversationId: !!conversationId }
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
    if (spawnEpoch === epoch) spawning.delete(projectId)
  }
}

function killWarm(projectId: string): void {
  const handle = warm.get(projectId)
  if (!handle) return
  warm.delete(projectId)
  releaseHandle(handle)
}

function killReserved(taskId: string): void {
  const entry = reserved.get(taskId)
  if (!entry) return
  clearTimeout(entry.timer)
  reserved.delete(taskId)
  releaseHandle(entry.handle)
}

/** Kill an agent the pool no longer holds (already removed from its map). */
function releaseHandle(handle: WarmHandle): void {
  // The process is the COMPUTER's, so this is a request, not a local kill — and it
  // is fire-and-forget: a computer that has gone away already took its warm agents
  // with it, and `reapOrphanWarms` covers anything that outlives us.
  void getPtyBackend()
    .warmKill?.(handle.computerId, handle.warmId)
    .catch(() => {
      // Only reachable when the computer is unreachable — which already means its
      // warm agents are gone. Nothing left to kill, nothing to report.
    })
  // The pooled session's process is gone → mark it dead so a stale `pooled` row
  // never lingers as resumable. Previously driven by the local pty's onExit,
  // which no longer exists here (warm output/exit is the computer's business until
  // adoption).
  void deps?.ops.markSessionDead(handle.sessionId).catch(() => {
    // The row is already off the pool map, so a failed write can only leave a
    // stale `pooled` row that the next `reapOrphanWarms` pass clears anyway.
  })
}

/**
 * Kill warm sessions on `computerId` that this hub is not tracking.
 *
 * Warm agents are the COMPUTER's processes now, so — unlike the old hub-local pool,
 * whose children died with the hub — they survive a hub restart, a sidecar
 * restart, or any reconnect that rebuilt the pool map. An unclaimed pre-booted
 * agent is a billable LLM process with no owner, so the hub reconciles against
 * the computer's own list whenever a computer (re)connects and reaps the difference.
 */
export async function reapOrphanWarms(computerId: string): Promise<void> {
  const backend = getPtyBackend()
  if (!backend.warmList || !backend.warmKill) return
  try {
    const remote = await backend.warmList(computerId)
    const tracked = new Set(
      [...warm.values(), ...[...reserved.values()].map((r) => r.handle)]
        .filter((h) => h.computerId === computerId)
        .map((h) => h.warmId)
    )
    for (const entry of remote) {
      if (tracked.has(entry.warmId)) continue
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'warm.orphan_reaped',
        payload: { computerId, warmId: entry.warmId, pid: entry.pid }
      })
      await backend.warmKill(computerId, entry.warmId).catch(() => {
        // One unkillable orphan must not abort the sweep — the remaining
        // entries are still billable, and this one is retried on the next
        // reconnect.
      })
    }
  } catch {
    // Best-effort: a computer that cannot answer warmList has nothing we can reap.
  }
}
