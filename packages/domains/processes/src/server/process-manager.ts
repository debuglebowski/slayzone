import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { createStatsPoller } from './pid-stats'
import { createDbProcessPersistence } from './process-persistence'
import type { ProcessPersistence } from './process-persistence'
import { getProcessBackend } from './process-backend'
import type { ProcHandle } from './process-backend'
import { extractOscTitle } from '@slayzone/terminal/shared'
import { getEnrichedPath } from '@slayzone/terminal/server'
import { TypedEmitter } from '@slayzone/platform/events'
import type { ProcessEventMap } from '@slayzone/types'

/** Structural slice of Electron's BrowserWindow — the legacy dual-emit target.
 *  Kept structural so this module stays electron-free (src/server guard); the
 *  Electron host passes its real BrowserWindow. Dropped with the IPC bridge. */
export type ProcessBroadcastWindow = {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

export type ProcessStatus = 'running' | 'stopped' | 'completed' | 'error'

export interface ProcessInfo {
  id: string
  taskId: string | null
  projectId: string | null
  label: string
  command: string
  cwd: string
  autoRestart: boolean
  status: ProcessStatus
  pid: number | null
  exitCode: number | null
  logBuffer: string[]
  startedAt: string
  restartCount: number
  spawnedAt: string | null
  processTitle: string | null
}

interface ManagedProcess extends ProcessInfo {
  handle: ProcHandle | null
  titlePollTimer: ReturnType<typeof setInterval> | null
  oscTitleSet: boolean
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
  persistence = p
  // Warm the enriched-PATH cache off the boot critical path. Spawning the
  // user's shell to read $PATH is ~100ms (login shell + rc files); deferring
  // saves it from blocking window creation. First spawn within the deferred
  // window pays the cost lazily — same as before this warm-up existed.
  setImmediate(() => {
    try {
      getEnrichedPath()
    } catch {
      /* lazy fallback handles it */
    }
  })
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
      // Carried over from the last spawn, if the app never got to clear it (an
      // uncontrolled exit) — reapStaleIfNeeded() checks and clears it before the
      // next restartProcess()/spawnProcess() actually spawns.
      pid: row.pid,
      exitCode: null,
      logBuffer: [],
      handle: null,
      startedAt: new Date().toISOString(),
      restartCount: 0,
      spawnedAt: null,
      processTitle: null,
      titlePollTimer: null,
      oscTitleSet: false
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

function pollProcessTitle(proc: ManagedProcess): void {
  const pid = proc.pid
  if (!pid || proc.oscTitleSet) return
  execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
    if (err || !stdout.trim() || proc.oscTitleSet) return
    const title = stdout.trim().split('/').pop()!
    if (title) emitTitle(proc, title)
  })
}

function startTitlePolling(proc: ManagedProcess): void {
  if (process.platform === 'win32') return
  stopTitlePolling(proc)
  pollProcessTitle(proc)
  proc.titlePollTimer = setInterval(() => pollProcessTitle(proc), 2000)
}

function stopTitlePolling(proc: ManagedProcess): void {
  if (proc.titlePollTimer) {
    clearInterval(proc.titlePollTimer)
    proc.titlePollTimer = null
  }
}

function handleProcessData(proc: ManagedProcess, str: string): void {
  // Check for OSC title sequences
  const oscTitle = extractOscTitle(str)
  if (oscTitle) {
    proc.oscTitleSet = true
    stopTitlePolling(proc)
    emitTitle(proc, oscTitle)
  }
  for (const line of str.split('\n')) {
    if (line.trim()) pushLog(proc, line)
  }
}

function doSpawn(proc: ManagedProcess): void {
  if (isShuttingDown) return
  proc.spawnedAt = new Date().toISOString()
  startStatsPolling()
  // Spawn via the pluggable backend. The default (local) backend keeps the exact
  // shell/env/detached semantics this used to run inline; a runner backend can
  // remote the exec. `runnerId: null` = run in-process.
  //
  // NOT runner-resolved: `doSpawn` is sync (also driven by restart timers), so it
  // cannot resolve a runner the way the pty/chat spawn paths do. Routing background
  // processes needs an async doSpawn — see the plan's phase C (they are
  // project-level dev servers, not agents, so they are low priority).
  const handle = getProcessBackend().spawn({
    id: proc.id,
    taskId: proc.taskId,
    projectId: proc.projectId,
    runnerId: null,
    command: proc.command,
    cwd: proc.cwd
  })

  proc.handle = handle
  proc.pid = handle.pid ?? null
  proc.exitCode = null
  proc.processTitle = null
  proc.oscTitleSet = false
  void persistence?.updatePid(proc.id, proc.pid)
  startTitlePolling(proc)

  handle.onData((chunk) => handleProcessData(proc, chunk))

  handle.onExit(({ code }) => {
    if (proc.handle !== handle) return // stale exit from restarted process
    stopTitlePolling(proc)
    proc.pid = null
    void persistence?.updatePid(proc.id, null)
    proc.handle = null
    proc.exitCode = code
    proc.processTitle = null
    proc.oscTitleSet = false
    win?.webContents.send('processes:title', proc.id, null)
    processEvents.emit('title', proc.id, null)
    if (proc.autoRestart && processes.has(proc.id)) {
      proc.restartCount++
      pushLog(proc, `[exited with code ${code ?? '?'}, restarting in 1s...]`)
      setStatus(proc, 'running')
      setTimeout(() => {
        if (isShuttingDown) return
        if (processes.has(proc.id)) doSpawn(proc)
      }, 1000)
    } else {
      setStatus(proc, code === 0 ? 'completed' : 'error')
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exact-or-suffix only — never a loose substring — so a coincidental partial
 *  overlap with an unrelated process's command line can't pass as a match. */
function commandsLikelyMatch(persisted: string, live: string): boolean {
  const p = persisted.trim()
  const l = live.trim()
  if (!p || !l) return false
  return l === p || l.endsWith(p) || p.endsWith(l)
}

const REAP_POLL_INTERVAL_MS = 200
const REAP_POLL_TIMEOUT_MS = 2000

/**
 * If `proc` still carries a pid from a previous, uncleanly-terminated run (the
 * app/sidecar exited without ever reaching stopProcess/doSpawn's exit handler,
 * so nothing sent it a kill signal and nothing cleared the persisted pid),
 * verify it's still alive and still looks like the same command, then reap it
 * before the caller spawns a fresh one against the same port.
 *
 * A pid that's alive but no longer matches (reused by an unrelated process
 * since the last run) is deliberately left alone — killing an unverified
 * process is worse than leaving a stale one for the new spawn to collide with.
 */
async function reapStaleIfNeeded(proc: ManagedProcess): Promise<void> {
  const stalePid = proc.pid
  if (proc.handle || stalePid == null) return
  const backend = getProcessBackend()
  const liveCommand = await backend.getCommandLine(stalePid)
  if (!liveCommand || !commandsLikelyMatch(proc.command, liveCommand)) {
    if (liveCommand) {
      pushLog(
        proc,
        `[pid ${stalePid} from a previous run no longer matches this command — leaving it running]`
      )
    }
    proc.pid = null
    void persistence?.updatePid(proc.id, null)
    return
  }

  pushLog(proc, `[reaping leftover process from a previous run: pid ${stalePid}]`)
  backend.killByPid(stalePid, 'SIGTERM')
  const deadline = Date.now() + REAP_POLL_TIMEOUT_MS
  while (Date.now() < deadline && (await backend.getCommandLine(stalePid))) {
    await sleep(REAP_POLL_INTERVAL_MS)
  }
  if (await backend.getCommandLine(stalePid)) {
    backend.killByPid(stalePid, 'SIGKILL')
    await sleep(REAP_POLL_INTERVAL_MS)
  }
  proc.pid = null
  void persistence?.updatePid(proc.id, null)
}

export function createProcess(
  projectId: string | null,
  taskId: string | null,
  label: string,
  command: string,
  cwd: string,
  autoRestart: boolean
): string {
  const id = randomUUID()
  const proc: ManagedProcess = {
    id,
    taskId,
    projectId,
    label,
    command,
    cwd,
    autoRestart,
    status: 'stopped',
    pid: null,
    exitCode: null,
    logBuffer: [],
    handle: null,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    spawnedAt: null,
    processTitle: null,
    titlePollTimer: null,
    oscTitleSet: false
  }
  processes.set(id, proc)
  void persistence?.insert({ id, taskId, projectId, label, command, cwd, autoRestart })
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
  if (isShuttingDown) throw new Error('Cannot spawn process while app is shutting down.')
  const id = randomUUID()
  const proc: ManagedProcess = {
    id,
    taskId,
    projectId,
    label,
    command,
    cwd,
    autoRestart,
    status: 'running',
    pid: null,
    exitCode: null,
    logBuffer: [],
    handle: null,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    spawnedAt: null,
    processTitle: null,
    titlePollTimer: null,
    oscTitleSet: false
  }
  processes.set(id, proc)
  void persistence?.insert({ id, taskId, projectId, label, command, cwd, autoRestart })
  // proc.pid is always null here (id is freshly minted) — a no-op today, kept for
  // symmetry with restartProcess in case a future caller ever reuses an id.
  await reapStaleIfNeeded(proc)
  doSpawn(proc)
  return id
}

export function updateProcess(
  id: string,
  updates: Partial<
    Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>
  >
): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  Object.assign(proc, updates)
  void persistence?.update({
    id,
    taskId: proc.taskId,
    projectId: proc.projectId,
    label: proc.label,
    command: proc.command,
    cwd: proc.cwd,
    autoRestart: proc.autoRestart
  })
  return true
}

export function stopProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  // Set handle to null before kill so the exit handler's `proc.handle !== handle`
  // guard bails out (prevents auto-restart from firing)
  const handle = proc.handle
  proc.handle = null
  proc.pid = null
  void persistence?.updatePid(proc.id, null)
  proc.spawnedAt = null
  if (handle) handle.kill()
  setStatus(proc, 'stopped')
  return true
}

export function killProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  proc.autoRestart = false
  if (proc.handle) proc.handle.kill()
  proc.handle = null
  processes.delete(id)
  void persistence?.remove(id)
  return true
}

export async function restartProcess(id: string): Promise<boolean> {
  if (isShuttingDown) return false
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  // Captured before proc.handle is nulled below: non-null here means this row
  // was actually spawned and is being tracked live in THIS app instance — a
  // normal restart, whose exit handler will clear pid/persistence on its own
  // once handle.kill() (below) takes effect. Null means this row was reloaded
  // from persistence and never spawned this session — the crash-recovery case,
  // where proc.pid (if set) is a leftover from an uncontrolled previous exit.
  const hadLiveHandle = proc.handle != null
  if (proc.handle) proc.handle.kill()
  proc.handle = null
  proc.logBuffer.push('[restarting...]')
  setStatus(proc, 'running')
  if (!hadLiveHandle) await reapStaleIfNeeded(proc)
  setTimeout(() => doSpawn(proc), 500)
  return true
}

/** Kill all processes belonging to a specific task. Project-scoped processes are unaffected. */
export function killTaskProcesses(taskId: string): void {
  for (const [id, proc] of processes.entries()) {
    if (proc.taskId === taskId) killProcess(id)
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
    .map(({ handle: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info)
}

export function listAllProcesses(): ProcessInfo[] {
  return Array.from(processes.values()).map(
    ({ handle: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info
  )
}

const statsPoller = createStatsPoller(
  () => {
    const pidMap = new Map<string, number>()
    for (const proc of processes.values()) {
      if (proc.pid != null) pidMap.set(proc.id, proc.pid)
    }
    return pidMap
  },
  (stats) => {
    win?.webContents.send('processes:stats', stats)
    processEvents.emit('stats', stats)
  }
)

function startStatsPolling(): void {
  statsPoller.ensureStarted()
}

export function killAllProcesses(): void {
  statsPoller.stop()
  for (const proc of processes.values()) {
    stopTitlePolling(proc)
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
        stopTitlePolling(proc)
        proc.handle = null
        proc.pid = null
        proc.spawnedAt = null
      }
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const onExit = (): void => settle(false)

    proc.autoRestart = false
    stopTitlePolling(proc)
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
  statsPoller.stop()
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
