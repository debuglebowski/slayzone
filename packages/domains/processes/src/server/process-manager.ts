import { randomUUID } from 'crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { createDbProcessPersistence } from './process-persistence'
import type { ProcessPersistence } from './process-persistence'
import { getProcessBackend } from './process-backend'
import type { ProcHandle } from './process-backend'
import { extractOscTitle } from '@slayzone/terminal-contracts'
import { TypedEmitter } from '@slayzone/platform/events'
import { runAsSecurityActor } from '@slayzone/platform/security-log'
import {
  assertHubProcessesEnabled,
  hubProcessesEnabled,
  refuseNoComputer
} from '@slayzone/platform/hub-switch-refusal'

/**
 * Background processes run ONLY on computers — the task's, else the project's. The
 * hub resolves that computer before every spawn and hands the run to the routing
 * backend; it never starts, polls, signals or probes a process on its own machine.
 * With no computer a start becomes the actionable "connect a computer" state.
 */

/** cpu/memory of one process, as the processes panel shows it. */
export interface PidStats {
  cpu: number
  rss: number
}
import type { ProcessEventMap, ProcessInfo, ProcessStatus } from '../shared'
import { OLD_RUN_UNREACHABLE_MESSAGE } from '../shared'

const noop = (): void => undefined

/** Structural slice of Electron's BrowserWindow — the legacy dual-emit target.
 *  Kept structural so this module stays electron-free (src/server guard); the
 *  Electron host passes its real BrowserWindow. Dropped with the IPC bridge. */
export type ProcessBroadcastWindow = {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

/**
 * Which computer runs a process: the task's, else the project's (placement). Asked
 * before EVERY spawn — initial, restart, auto-restart — because a computer can
 * connect, leave or be re-bound in between. Unset, `null` (or a throw): nothing can
 * run it now; the process shows "connect a computer" — it never starts on the hub.
 */
export type ProcessComputerResolver = (proc: {
  taskId: string | null
  projectId: string | null
}) => Promise<string | null>
let processComputerResolver: ProcessComputerResolver | null = null
export function setProcessComputerResolver(resolver: ProcessComputerResolver | null): void {
  processComputerResolver = resolver
  // A hub with processes off loads its rows only now: from here they run on computers.
  if (resolver && deferredPersistence) {
    const p = deferredPersistence
    deferredPersistence = null
    persistence = p
    void loadRows(p)
  }
}

/**
 * Whether a computer is reachable now (connected and heard from). A kept run whose
 * computer is NOT reachable cannot be ended, yet it is no survivor either (G3): that
 * difference decides between "stop it first" and "it is ended when its computer
 * returns". Unset: every computer reads reachable (a failed kill is a survivor).
 */
let computerReachable: ((computerId: string) => boolean) | null = null
export function setProcessComputerReachability(fn: ((computerId: string) => boolean) | null): void {
  computerReachable = fn
}
const isReachable = (computerId: string | null): boolean =>
  computerId == null || !computerReachable || computerReachable(computerId)

/**
 * Runs left on a computer that was unreachable when its row moved on (started
 * elsewhere, or removed): session ids per computer, ended when it reconnects.
 */
const endOnReconnect = new Map<string, Set<string>>()
function strand(computerId: string, sessionId: string): void {
  const ids = endOnReconnect.get(computerId) ?? new Set<string>()
  ids.add(sessionId)
  endOnReconnect.set(computerId, ids)
}

/** How a previous run's termination ended. */
type Termination = 'gone' | 'survives' | 'unreachable'

/**
 * Refuse a process op only when it would run on THIS machine: with routing wired,
 * every process runs on a computer, so a hub with processes switched off can manage
 * them (doSpawn refuses with 'no computer' when none can run it).
 */
function assertCanRunProcesses(...args: Parameters<typeof assertHubProcessesEnabled>): void {
  if (!processComputerResolver) assertHubProcessesEnabled(...args)
}

/** Rows of a hub with processes off, held until routing is wired (see above). */
let deferredPersistence: ProcessPersistence | null = null

/** What a client may set on a process (create, update); the rest is the manager's. */
const EDITABLE_FIELDS = ['label', 'command', 'cwd', 'autoRestart', 'taskId', 'projectId'] as const
type EditableField = (typeof EDITABLE_FIELDS)[number]

interface ManagedProcess extends ProcessInfo {
  handle: ProcHandle | null
  /**
   * The computer the current/last spawn runs on (null: none yet). Its pid belongs to
   * that computer: nothing here signals, polls or records it.
   */
  computerId: string | null
  /**
   * The routed run's pid ON ITS COMPUTER — shown to users (panel, CLI), never
   * signalled, polled or persisted here; `pid` stays null for a routed run.
   */
  computerPid: number | null
  /** An auto-restart process whose last start found no computer: starts on connect. */
  awaitingComputer: boolean
  oscTitleSet: boolean
  /** Bumped by every lifecycle op (start/stop/restart). An async step that
   *  resumes after an await (a spawn waiting on the cwd resolver, a stop's
   *  final status write, an auto-restart timer, the boot liveness probe) acts
   *  only if no newer op has superseded it. */
  generation: number
  /** The in-flight termination of the previous run's tree, if a stop/restart
   *  is still sweeping it. A start awaits it, so the new run never races the
   *  old one onto the same port. Resolves true when nothing of it is left. */
  termination: Promise<Termination> | null
  /**
   * What to do with the run kept on `computerId` once that (now unreachable)
   * computer reconnects: end it (a Stop asked meanwhile), or end it and start anew
   * (a Start asked meanwhile). Null: nothing pending.
   */
  onReconnect: 'stop' | 'start' | null
}

const LOG_BUFFER_MAX = 500
const DEFAULT_SHUTDOWN_TERM_GRACE_MS = 1500
const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 5000

export interface ProcessShutdownOptions {
  termGraceMs?: number
  hardTimeoutMs?: number
}

export interface ProcessShutdownResult {
  total: number
  exited: number
  killed: number
  timedOut: number
  errors: Array<{ id: string; phase: string; message: string }>
}

let win: ProcessBroadcastWindow | null = null
let persistence: ProcessPersistence | null = null
let isShuttingDown = false
const processes = new Map<string, ManagedProcess>()

// Streaming bus for the tRPC `processes` subscriptions. Dual-emit: every event
// is also still pushed over the legacy `win.webContents.send(...)` IPC channel
// below, so both transports stay live until the renderer cutover (slice 5).
export const processEvents = new TypedEmitter<ProcessEventMap>()
const logSubscribers = new Map<string, Set<(line: string) => void>>()

export function subscribeToProcessLogs(id: string, cb: (line: string) => void): () => void {
  if (!logSubscribers.has(id)) logSubscribers.set(id, new Set())
  logSubscribers.get(id)!.add(cb)
  return () => logSubscribers.get(id)?.delete(cb)
}

export function setProcessManagerWindow(window: ProcessBroadcastWindow): void {
  win = window
}

/** DB-backed init — keeps the historical signature; delegates to the seam below. */
export async function initProcessManager(database: SlayzoneDb): Promise<void> {
  return initProcessManagerWith(createDbProcessPersistence(database))
}

export async function initProcessManagerWith(p: ProcessPersistence): Promise<void> {
  // `SLAYZONE_HUB_ENABLE_PROCESSES=0`: load no persisted row yet — every entry point
  // below refuses until routing to computers is wired (`setProcessComputerResolver`),
  // which loads the rows then.
  if (!hubProcessesEnabled()) {
    deferredPersistence = processComputerResolver ? null : p
    if (processComputerResolver) {
      persistence = p
      await loadRows(p)
    }
    return
  }
  persistence = p
  await loadRows(p)
}

/**
 * Register persisted rows, stopped. A run left on a computer by a previous hub is
 * adopted when that computer connects (`processesComputerConnected`); the hub never
 * probes a pid itself.
 */
async function loadRows(p: ProcessPersistence): Promise<void> {
  const rows = await p.loadAll()
  for (const row of rows) {
    processes.set(row.id, {
      id: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      label: row.label,
      command: row.command,
      cwd: row.cwd,
      autoRestart: row.auto_restart === 1,
      status: 'stopped',
      pid: null,
      exitCode: null,
      logBuffer: [],
      handle: null,
      computerId: null,
      computerPid: null,
      awaitingComputer: false,
      onReconnect: null,
      startedAt: new Date().toISOString(),
      restartCount: 0,
      spawnedAt: null,
      processTitle: null,
      oscTitleSet: false,
      generation: 0,
      termination: null
    })
  }
}

function pushLog(proc: ManagedProcess, line: string): void {
  proc.logBuffer.push(line)
  if (proc.logBuffer.length > LOG_BUFFER_MAX) proc.logBuffer.shift()
  win?.webContents.send('processes:log', proc.id, line)
  processEvents.emit('log', proc.id, line)
  logSubscribers.get(proc.id)?.forEach((cb) => cb(line))
}

function setStatus(proc: ManagedProcess, status: ProcessStatus): void {
  proc.status = status
  win?.webContents.send('processes:status', proc.id, status)
  processEvents.emit('status', proc.id, status)
}

function emitTitle(proc: ManagedProcess, title: string): void {
  if (title === proc.processTitle) return
  proc.processTitle = title
  win?.webContents.send('processes:title', proc.id, title)
  processEvents.emit('title', proc.id, title)
}

function handleProcessData(proc: ManagedProcess, str: string): void {
  // Check for OSC title sequences
  const oscTitle = extractOscTitle(str)
  if (oscTitle) {
    proc.oscTitleSet = true
    emitTitle(proc, oscTitle)
  }
  for (const line of str.split('\n')) {
    if (line.trim()) pushLog(proc, line)
  }
}

/** A spawn that could not happen: say why on the process itself. */
function failSpawn(proc: ManagedProcess, err: unknown): void {
  proc.handle = null
  proc.spawnedAt = null
  // Meant to stay up: start it once a computer connects (processesComputerConnected).
  proc.awaitingComputer = proc.autoRestart && isNoComputer(err)
  pushLog(proc, `[could not start: ${toErrorMessage(err)}]`)
  setStatus(proc, 'error')
}

/**
 * For timers (auto-restart): a spawn that fails becomes the process's status — unless
 * a stop/restart superseded it meanwhile (that one owns the status now).
 */
function spawnOrFail(proc: ManagedProcess, generation: number): void {
  void doSpawn(proc, generation).catch((err: unknown) => {
    if (proc.generation === generation) failSpawn(proc, err)
  })
}

/** Nothing can run it now (no computer connected / bound): a refusal, not a crash. */
function isNoComputer(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'NO_COMPUTER_CONNECTED'
}

async function doSpawn(proc: ManagedProcess, generation = proc.generation): Promise<void> {
  if (isShuttingDown) return
  const computerId = processComputerResolver
    ? await processComputerResolver({ taskId: proc.taskId, projectId: proc.projectId })
    : null
  if (computerId == null)
    refuseNoComputer({ op: 'processes.spawn', detail: { processId: proc.id } })
  if (isShuttingDown || !processes.has(proc.id)) return
  // A stop/restart issued while this spawn awaited the resolver supersedes it.
  if (proc.generation !== generation) return
  proc.spawnedAt = new Date().toISOString()
  startStatsPolling()
  // A project process sends no cwd: its computer resolves the project's own folder
  // on its disk (the hub's stored path names no particular machine).
  const handle = getProcessBackend().spawn({
    id: proc.id,
    taskId: proc.taskId,
    projectId: proc.projectId,
    computerId,
    command: proc.command,
    cwd: proc.taskId === null && proc.projectId != null ? '' : proc.cwd
  })

  proc.handle = handle
  proc.awaitingComputer = false
  proc.computerId = computerId
  // The pid is the computer's: shown (computerPid), never stored or signalled here.
  proc.pid = null
  proc.computerPid = null
  proc.exitCode = null
  proc.processTitle = null
  proc.oscTitleSet = false

  handle.onData((chunk) => handleProcessData(proc, chunk))

  // A spawn answers once its computer runs it (or ends it), so the caller gets the
  // pid there — or the refusal in the log — instead of a bare id.
  let settleSpawn: (() => void) | null = null
  const spawnSettled = handle.onSpawned
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(() => settleSpawn?.(), ROUTED_SPAWN_CONFIRM_MS)
        timer.unref?.()
        settleSpawn = () => {
          settleSpawn = null
          clearTimeout(timer)
          resolve()
        }
        handle.onSpawned?.(({ pid }) => {
          if (proc.handle === handle) proc.computerPid = pid
          settleSpawn?.()
        })
      })
    : null

  handle.onExit(({ code, detail }) => {
    settleSpawn?.()
    if (proc.handle !== handle) return // stale exit from restarted process
    proc.computerPid = null
    // A computer's refusal or OS error says why; a bare exit code would not.
    if (detail) pushLog(proc, `[${detail}]`)
    proc.handle = null
    proc.exitCode = code
    proc.processTitle = null
    proc.oscTitleSet = false
    win?.webContents.send('processes:title', proc.id, null)
    processEvents.emit('title', proc.id, null)
    // An unplanned exit — stop/remove/restart null proc.handle before killing. The
    // computer reaps its own process group.
    if (proc.autoRestart) {
      proc.restartCount++
      pushLog(proc, `[exited with code ${code ?? '?'}, restarting in 1s...]`)
      setStatus(proc, 'running')
      // A stop within that second bumps the generation: the respawn is then dropped
      // instead of resurrecting a process the user just stopped.
      const generation = proc.generation
      setTimeout(() => {
        if (isShuttingDown) return
        if (processes.has(proc.id) && proc.generation === generation) spawnOrFail(proc, generation)
      }, 1000)
    } else {
      pushLog(proc, `[exited with code ${code ?? '?'}]`)
      setStatus(proc, code === 0 ? 'completed' : 'error')
    }
  })
  if (spawnSettled) await spawnSettled
}

/**
 * A computer (re)connected. Processes route to computers, so two things wait on this:
 * - an auto-restart process that found no computer starts now;
 * - a run that computer kept from before the hub restarted (nothing here tracks it,
 *   yet it may hold a port) shows as `orphaned` with its pid there, so Stop and Start
 *   reach it — what the boot liveness probe does for local pids. One the computer no
 *   longer holds goes back to `stopped`.
 */
export async function processesComputerConnected(computerId: string): Promise<void> {
  if (isShuttingDown) return
  for (const proc of processes.values()) {
    if (proc.awaitingComputer && !proc.handle) {
      proc.awaitingComputer = false
      pushLog(proc, '[a computer connected — starting]')
      setStatus(proc, 'running')
      spawnOrFail(proc, proc.generation)
    }
  }
  const backend = getProcessBackend()
  if (!backend.listSessions) return
  const live = await backend.listSessions(computerId).catch(() => null)
  if (!live) return
  const held = new Map(live.map((l) => [l.sessionId, l.pid]))
  // Runs left here while this computer was unreachable, whose rows moved on: end them.
  const stranded = endOnReconnect.get(computerId)
  if (stranded) {
    endOnReconnect.delete(computerId)
    for (const sessionId of stranded) {
      if (held.has(sessionId)) void backend.killSession?.(computerId, sessionId).catch(noop)
    }
  }
  // A Stop or Start asked while this computer was unreachable: done now.
  for (const proc of processes.values()) {
    if (proc.computerId !== computerId || !proc.onReconnect || proc.handle) continue
    const pending = proc.onReconnect
    proc.onReconnect = null
    if (!held.has(proc.id)) proc.computerPid = null
    else proc.computerPid = held.get(proc.id) ?? proc.computerPid
    if (pending === 'stop') void stopProcess(proc.id)
    else void startProcess(proc.id)
  }
  for (const proc of processes.values()) {
    if (proc.handle || proc.termination) continue
    const pid = held.get(proc.id)
    if (held.has(proc.id) && proc.status !== 'running') {
      proc.computerId = computerId
      proc.computerPid = pid ?? null
      pushLog(
        proc,
        '[still running on its computer from before the hub restarted — marked orphaned]'
      )
      setStatus(proc, 'orphaned')
    } else if (
      !held.has(proc.id) &&
      proc.status === 'orphaned' &&
      proc.computerId === computerId &&
      proc.computerPid != null
    ) {
      proc.computerPid = null
      setStatus(proc, 'stopped')
    }
  }
}

/**
 * A computer was removed (deleted or revoked): the runs it kept can never be reached
 * again. Forget them — the rows read stopped and start freely elsewhere (G3).
 */
export function processesComputerRemoved(computerId: string): void {
  endOnReconnect.delete(computerId)
  for (const proc of processes.values()) {
    if (proc.handle || proc.computerId !== computerId || proc.computerPid == null) continue
    proc.computerPid = null
    proc.onReconnect = null
    pushLog(proc, '[its computer was removed — the run it kept there is forgotten]')
    setStatus(proc, 'stopped')
  }
}

/**
 * Whether `sessionId` on `computerId` is a run this manager adopted (a previous
 * hub's run the computer kept: orphaned, no handle, reached by session). The
 * routing backend does not track it, so its reconnect sweep must not end it.
 */
export function isAdoptedOnComputer(computerId: string, sessionId: string): boolean {
  const proc = processes.get(sessionId)
  return !!proc && !proc.handle && proc.computerId === computerId && proc.computerPid != null
}

/** How long a routed spawn waits for its computer's "it runs" before answering anyway. */
const ROUTED_SPAWN_CONFIRM_MS = 10_000

/** A process row the manager has not registered yet: created, not running. */
function newManagedProcess(
  id: string,
  fields: Pick<ProcessInfo, EditableField>,
  status: ProcessStatus
): ManagedProcess {
  return {
    id,
    ...fields,
    status,
    pid: null,
    exitCode: null,
    logBuffer: [],
    handle: null,
    computerId: null,
    computerPid: null,
    awaitingComputer: false,
    onReconnect: null,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    spawnedAt: null,
    processTitle: null,
    oscTitleSet: false,
    generation: 0,
    termination: null
  }
}

/**
 * Persist a client-supplied row and only then register it. Awaited, never `void`: a
 * row the database refuses (a NOT NULL column, a project or task that does not
 * exist) fails THIS call with that error. Floated, its rejection had no handler,
 * and an unhandled rejection ends the hub's process (T-102).
 */
async function persistNew(proc: ManagedProcess): Promise<void> {
  const { id, taskId, projectId, label, command, cwd, autoRestart } = proc
  await persistence?.insert({ id, taskId, projectId, label, command, cwd, autoRestart })
  processes.set(id, proc)
}

export async function createProcess(
  projectId: string | null,
  taskId: string | null,
  label: string,
  command: string,
  cwd: string,
  autoRestart: boolean
): Promise<string> {
  assertCanRunProcesses('hub.process.spawn', { op: 'create', detail: { taskId, projectId } })
  const id = randomUUID()
  await persistNew(
    newManagedProcess(id, { taskId, projectId, label, command, cwd, autoRestart }, 'stopped')
  )
  return id
}

export async function spawnProcess(
  projectId: string | null,
  taskId: string | null,
  label: string,
  command: string,
  cwd: string,
  autoRestart: boolean
): Promise<string> {
  assertCanRunProcesses('hub.process.spawn', { op: 'spawn', detail: { taskId, projectId } })
  if (isShuttingDown) throw new Error('Cannot spawn process while app is shutting down.')
  const id = randomUUID()
  const proc = newManagedProcess(
    id,
    { taskId, projectId, label, command, cwd, autoRestart },
    'running'
  )
  await persistNew(proc)
  try {
    await doSpawn(proc)
  } catch (err) {
    // The row exists either way and says why it is not running. No computer is an
    // ordinary answer (the panel shows it); anything else still fails this call.
    failSpawn(proc, err)
    if (!isNoComputer(err)) throw err
  }
  return id
}

/**
 * Apply a client's edit. Only the editable fields are copied (never `Object.assign` of
 * the patch: that let a client write the live record's pid, log buffer or handle), an
 * `undefined` leaves a field as it is, and the row is persisted before the live record
 * changes. Awaited for the same reason as `persistNew`: a database refusal (a project
 * or task that does not exist) fails this call and leaves the process untouched.
 */
export async function updateProcess(
  id: string,
  updates: Partial<Pick<ProcessInfo, EditableField>>
): Promise<boolean> {
  assertCanRunProcesses('hub.process.spawn', { op: 'update', detail: { processId: id } })
  const proc = processes.get(id)
  if (!proc) return false
  const next: Pick<ProcessInfo, EditableField> = {
    label: proc.label,
    command: proc.command,
    cwd: proc.cwd,
    autoRestart: proc.autoRestart,
    taskId: proc.taskId,
    projectId: proc.projectId
  }
  for (const key of EDITABLE_FIELDS) {
    if (updates[key] !== undefined) Object.assign(next, { [key]: updates[key] })
  }
  await persistence?.update({ id, ...next })
  Object.assign(proc, next)
  return true
}

/**
 * Detach `proc` from its current run and end it ON ITS COMPUTER (`handle.kill()`:
 * the computer tree-kills its own run). The synchronous part — handle nulled,
 * generation bumped — happens first, so the old handle's `onExit` sees
 * `proc.handle !== handle` and never treats this as an unplanned exit. The returned
 * promise (parked on `proc.termination` for a following start) resolves to whether
 * the run is known to be gone.
 *
 * A run a previous hub left on a computer (adopted as orphaned) has no handle: its
 * computer ends it by session (`killSession`).
 */
function detachAndTerminate(proc: ManagedProcess): {
  generation: number
  done: Promise<Termination>
} {
  const generation = ++proc.generation
  const handle = proc.handle
  const keptOnComputer =
    handle == null && proc.computerId != null && proc.computerPid != null ? proc.computerId : null
  const keptPid = proc.computerPid ?? handle?.pid ?? null
  const runsOn = proc.computerId
  /** A kill that did not end it: its computer unreachable, or a survivor. */
  const failed = (): Termination => (isReachable(runsOn) ? 'survives' : 'unreachable')
  proc.awaitingComputer = false
  proc.onReconnect = null
  proc.handle = null
  proc.pid = null
  proc.computerPid = null
  proc.spawnedAt = null
  const previous = proc.termination
  const done = (async (): Promise<Termination> => {
    if (handle) {
      // Awaited: the computer replies once the whole tree is gone, so a following
      // start never collides with the old run's port.
      const ended = (await Promise.resolve(handle.kill()).catch(() => false)) !== false
      // Not confirmed gone: keep it addressable (by session) for the next stop —
      // unless a new run has taken the row meanwhile.
      if (!ended && !proc.handle && keptPid != null) proc.computerPid = keptPid
      return ended ? 'gone' : failed()
    }
    if (keptOnComputer) {
      const backend = getProcessBackend()
      const ended = backend.killSession
        ? await backend.killSession(keptOnComputer, proc.id).then(
            () => true,
            () => false
          )
        : false
      // Still there: keep it addressable for the next stop.
      if (!ended && proc.generation === generation) proc.computerPid = keptPid
      return ended ? 'gone' : failed()
    }
    // A stop still in flight from an earlier call already owns that run.
    if (previous) return previous
    return 'gone'
  })()
  proc.termination = done
  void done.finally(() => {
    if (proc.termination === done) proc.termination = null
  })
  return { generation, done }
}

/** Status after a stop: 'stopped', or still 'orphaned' when the run is not gone. */
function settleStopped(proc: ManagedProcess, result: Termination): void {
  if (result === 'gone') {
    setStatus(proc, 'stopped')
    return
  }
  if (result === 'unreachable') {
    // Not a survivor: its computer is offline. The stop is kept and done there.
    proc.onReconnect = 'stop'
    pushLog(
      proc,
      "[stop: the run's computer is offline — it is ended when that computer reconnects]"
    )
  } else {
    pushLog(proc, '[stop: its computer could not end the run — still orphaned]')
  }
  setStatus(proc, 'orphaned')
}

/**
 * Stop the run, keep the row. Resolves once the whole tree is gone (or found to
 * have survived SIGKILL → 'orphaned'), not when the first signal is sent.
 */
export async function stopProcess(id: string): Promise<boolean> {
  const proc = processes.get(id)
  if (!proc) return false
  const { generation, done } = detachAndTerminate(proc)
  const result = await done
  // A start issued meanwhile owns the row now.
  if (proc.generation === generation && processes.has(id)) settleStopped(proc, result)
  return true
}

/** Delete the row; its run is ended on its computer in the background. Synchronous
 *  so the row is gone before the caller continues. */
export function removeProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  proc.autoRestart = false
  const keptOn = proc.computerId
  void detachAndTerminate(proc).done.then((result) => {
    if (result === 'unreachable' && keptOn) strand(keptOn, id)
  })
  processes.delete(id)
  void persistence?.remove(id)
  return true
}

/** Why a start did not happen. */
export type StartProcessRefusal =
  | 'not-found'
  | 'already-running'
  | 'shutting-down'
  | 'no-computer'
  /** Part of the previous run outlived SIGKILL on its computer: a new one would
   *  collide with its port, and the survivor could no longer be stopped. */
  | 'old-run-survives'
  /** The previous run's computer is offline (not a survivor): it cannot be ended now,
   *  and this row can run only there. Starts when that computer reconnects. */
  | 'old-run-unreachable'
export type StartProcessResult =
  | { ok: true; pid: number | null; status: ProcessStatus }
  | { ok: false; reason: StartProcessRefusal }

/**
 * Wait for an in-flight stop, then spawn with the row's stored command/cwd. Shared by
 * start and restart, after each has detached what it needs to. (A run a previous hub
 * left on the computer under the same id is replaced there by the new spawn.)
 */
async function respawn(proc: ManagedProcess, generation: number): Promise<StartProcessResult> {
  if (proc.termination) {
    const result = await proc.termination
    if (result === 'survives' && proc.generation === generation) {
      pushLog(
        proc,
        '[not started: the previous run is still alive on its computer — stop it first]'
      )
      setStatus(proc, 'orphaned')
      return { ok: false, reason: 'old-run-survives' }
    }
    if (result === 'unreachable' && proc.generation === generation) {
      const keptOn = proc.computerId
      // Where would the new run go? Elsewhere (the task moved, another computer
      // serves it, and it is up): no port to collide with — start there, and end the
      // old run when its computer returns. Only there: wait for it. There is no
      // override (K5): a start parked for that computer is replaced IN PLACE when it
      // reconnects (SIGTERM, no wait) — the very port collision R5 refuses.
      const target = processComputerResolver
        ? await processComputerResolver({ taskId: proc.taskId, projectId: proc.projectId }).catch(
            () => null
          )
        : null
      if (proc.generation !== generation) return { ok: false, reason: 'already-running' }
      const elsewhere = target != null && target !== keptOn && isReachable(target)
      if (!elsewhere) {
        proc.onReconnect = 'start'
        pushLog(
          proc,
          "[not started: the previous run's computer is offline — it starts when that computer reconnects]"
        )
        setStatus(proc, 'orphaned')
        return { ok: false, reason: 'old-run-unreachable' }
      }
      if (keptOn) strand(keptOn, proc.id)
      proc.computerPid = null
      pushLog(
        proc,
        "[the previous run's computer is offline — starting anew; that run is ended when its computer reconnects]"
      )
    }
  }
  if (proc.generation === generation) {
    try {
      await doSpawn(proc, generation)
    } catch (err) {
      // Shown on the process either way; no computer is a refusal the caller reports.
      if (proc.generation === generation) failSpawn(proc, err)
      if (isNoComputer(err)) return { ok: false, reason: 'no-computer' }
      throw err
    }
  }
  return { ok: true, pid: proc.pid ?? proc.computerPid, status: proc.status }
}

/**
 * Start a row that is not running, with its stored command/cwd. A running row
 * is refused (`already-running`) rather than restarted — restart is explicit.
 * An 'orphaned' row (a run a previous hub left on its computer) is not "running" in
 * this sense: the new spawn replaces it there.
 */
export async function startProcess(id: string): Promise<StartProcessResult> {
  assertCanRunProcesses('hub.process.spawn', { op: 'start', detail: { processId: id } })
  if (isShuttingDown) return { ok: false, reason: 'shutting-down' }
  const proc = processes.get(id)
  if (!proc) return { ok: false, reason: 'not-found' }
  if (proc.handle || (proc.status === 'running' && !proc.termination)) {
    return { ok: false, reason: 'already-running' }
  }
  // A run its computer still holds (orphaned: adopted after a hub restart, or one
  // that outlived a stop) is ended there first and awaited, as Restart does — the
  // computer's own replace-spawn would not wait for it to free its port. Refused
  // (old-run-survives) while it lives.
  const generation =
    proc.computerPid != null ? detachAndTerminate(proc).generation : ++proc.generation
  pushLog(proc, '[starting...]')
  setStatus(proc, 'running')
  return respawn(proc, generation)
}

/**
 * Stop whatever runs (whole tree, awaited — the new run never collides with the
 * old one's port) and start again under the same id. Resolves after the new run
 * is spawned, so the caller can read its pid.
 */
export async function restartProcessDetailed(id: string): Promise<StartProcessResult> {
  assertCanRunProcesses('hub.process.spawn', { op: 'restart', detail: { processId: id } })
  if (isShuttingDown) return { ok: false, reason: 'shutting-down' }
  const proc = processes.get(id)
  if (!proc) return { ok: false, reason: 'not-found' }
  // A live run is ended on its computer first (awaited by respawn), as is a run
  // still kept there (orphaned).
  const generation =
    proc.handle || proc.computerPid != null
      ? detachAndTerminate(proc).generation
      : ++proc.generation
  pushLog(proc, '[restarting...]')
  setStatus(proc, 'running')
  return respawn(proc, generation)
}

export async function restartProcess(id: string): Promise<boolean> {
  return (await restartProcessDetailed(id)).ok
}

/** A restart refused because the previous run still lives on its computer. */
export class OldRunSurvivesError extends Error {
  constructor() {
    super('The previous run is still alive on its computer (it outlived SIGKILL) — stop it first')
    this.name = 'OldRunSurvivesError'
  }
}

/**
 * Restart for the UI: `false` for the plain refusals, as before — but a survivor is
 * an error with its reason, so the panel says why nothing restarted (it only
 * reached the process log before).
 */
export async function restartProcessForUi(id: string): Promise<boolean> {
  const result = await restartProcessDetailed(id)
  if (!result.ok && result.reason === 'old-run-survives') throw new OldRunSurvivesError()
  if (!result.ok && result.reason === 'old-run-unreachable') throw new OldRunUnreachableError()
  return result.ok
}

/**
 * A restart refused because the previous run's computer is offline (G3) — not a
 * survivor. The UI says so: it starts when that computer reconnects.
 */
export class OldRunUnreachableError extends Error {
  constructor() {
    super(OLD_RUN_UNREACHABLE_MESSAGE)
    this.name = 'OldRunUnreachableError'
  }
}

/** Kill all processes belonging to a specific task. Project-scoped processes are unaffected. */
export function removeTaskProcesses(taskId: string): void {
  for (const [id, proc] of processes.entries()) {
    if (proc.taskId === taskId) removeProcess(id)
  }
}

/** Returns task-scoped processes for taskId plus project-scoped processes matching projectId. */
export function listForTask(taskId: string | null, projectId: string | null): ProcessInfo[] {
  return Array.from(processes.values())
    .filter(
      (p) =>
        (taskId != null && p.taskId === taskId) ||
        (p.taskId === null && p.projectId != null && p.projectId === projectId)
    )
    .map(toInfo)
}

/** What callers see: a routed run shows its pid on its computer. */
function toInfo({
  handle: _,
  oscTitleSet: _o,
  computerId: _c,
  computerPid,
  awaitingComputer: _a,
  ...info
}: ManagedProcess): ProcessInfo {
  return { ...info, pid: info.pid ?? computerPid }
}

export function listAllProcesses(): ProcessInfo[] {
  return Array.from(processes.values()).map(toInfo)
}

// The processes panel replaces its stats wholesale on every event.
let routedStats: Record<string, PidStats> = {}
function emitStats(): void {
  win?.webContents.send('processes:stats', routedStats)
  processEvents.emit('stats', routedStats)
}

const ROUTED_STATS_INTERVAL_MS = 3000
let routedStatsTimer: ReturnType<typeof setInterval> | null = null

/** Numbers and title come from each process's computer (`ProcessBackend.stats`). */
async function pollRoutedStats(): Promise<void> {
  const routed = [...processes.values()].filter((p) => p.computerId != null && p.handle)
  if (routed.length === 0) {
    if (routedStatsTimer) clearInterval(routedStatsTimer)
    routedStatsTimer = null
    routedStats = {}
    return
  }
  const backend = getProcessBackend()
  if (!backend.stats) return
  const answer = await backend.stats(routed.map((p) => p.id)).catch(() => null)
  if (!answer) return
  const next: Record<string, PidStats> = {}
  for (const proc of routed) {
    const s = answer[proc.id]
    if (!s) continue
    next[proc.id] = { cpu: s.cpu, rss: s.rss }
    if (s.title && !proc.oscTitleSet) emitTitle(proc, s.title)
  }
  routedStats = next
  emitStats()
}

function startStatsPolling(): void {
  if (routedStatsTimer) return
  // Started inside whichever request spawned first, a timer's ticks would run as THAT
  // caller — and the gateway's owner check then refused every other user's computer,
  // silently (K6). The poll is the hub's own work: created, so run, as nobody.
  routedStatsTimer = runAsSecurityActor(null, () =>
    setInterval(() => void pollRoutedStats(), ROUTED_STATS_INTERVAL_MS)
  )
  routedStatsTimer.unref?.()
}

export function killAllProcesses(): void {
  if (routedStatsTimer) clearInterval(routedStatsTimer)
  routedStatsTimer = null
  for (const proc of processes.values()) {
    proc.autoRestart = false
    if (proc.handle) proc.handle.kill()
    proc.handle = null
  }
  processes.clear()
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function shutdownManagedProcess(
  proc: ManagedProcess,
  opts: Required<ProcessShutdownOptions>
): Promise<{
  id: string
  exited: boolean
  killed: boolean
  timedOut: boolean
  errors: ProcessShutdownResult['errors']
}> {
  return new Promise((resolve) => {
    const handle = proc.handle
    const id = proc.id
    const errors: ProcessShutdownResult['errors'] = []
    if (!handle) {
      resolve({ id, exited: true, killed: false, timedOut: false, errors })
      return
    }

    let settled = false
    let killed = false
    let termTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let exitSub: { dispose(): void } | null = null

    const recordError = (phase: string, err: unknown): void => {
      errors.push({ id, phase, message: toErrorMessage(err) })
    }
    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer)
      if (hardTimer) clearTimeout(hardTimer)
      exitSub?.dispose()
    }
    const settle = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) {
        proc.handle = null
        proc.pid = null
        proc.spawnedAt = null
      }
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const onExit = (): void => settle(false)

    proc.autoRestart = false
    exitSub = handle.onExit(onExit)

    try {
      handle.kill('SIGTERM')
    } catch (err) {
      recordError('sigterm', err)
    }

    termTimer = setTimeout(() => {
      killed = true
      try {
        handle.kill('SIGKILL')
      } catch (err) {
        recordError('sigkill', err)
      }
    }, opts.termGraceMs)
    termTimer.unref?.()

    hardTimer = setTimeout(() => settle(true), opts.hardTimeoutMs)
    hardTimer.unref?.()
  })
}

export async function shutdownAllProcesses(
  options: ProcessShutdownOptions = {}
): Promise<ProcessShutdownResult> {
  isShuttingDown = true
  if (routedStatsTimer) clearInterval(routedStatsTimer)
  routedStatsTimer = null
  const opts: Required<ProcessShutdownOptions> = {
    termGraceMs: options.termGraceMs ?? DEFAULT_SHUTDOWN_TERM_GRACE_MS,
    hardTimeoutMs: options.hardTimeoutMs ?? DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS
  }
  const targets = Array.from(processes.values())
  const results = await Promise.all(targets.map((proc) => shutdownManagedProcess(proc, opts)))
  processes.clear()
  return {
    total: results.length,
    exited: results.filter((r) => r.exited).length,
    killed: results.filter((r) => r.killed).length,
    timedOut: results.filter((r) => r.timedOut).length,
    errors: results.flatMap((r) => r.errors)
  }
}
