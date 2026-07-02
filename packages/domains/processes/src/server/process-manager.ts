import { spawn, execFile, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { createStatsPoller } from './pid-stats'
import { extractOscTitle } from '@slayzone/terminal/shared'
import { getEnrichedPath } from '@slayzone/terminal/server'
import { buildShellInvocation } from '@slayzone/platform'
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
  child: ChildProcess | null
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

/** Kill the entire process tree rooted at `child` (must be spawned with `detached: true` on POSIX). */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)])
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, signal)
    } catch {
      // ignore
    }
  }
}

let win: ProcessBroadcastWindow | null = null
let db: SlayzoneDb | null = null
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

export async function initProcessManager(database: SlayzoneDb): Promise<void> {
  db = database
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
  const rows = (await db.prepare('SELECT * FROM processes ORDER BY created_at').all()) as Array<{
    id: string
    task_id: string | null
    project_id: string | null
    label: string
    command: string
    cwd: string
    auto_restart: number
  }>
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
      child: null,
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

function handleProcessData(proc: ManagedProcess, data: Buffer): void {
  const str = data.toString()
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
  const isWin = process.platform === 'win32'
  // buildShellInvocation handles fish (-i -l for PATH init inside
  // `if status is-interactive` blocks), bash/zsh (-l only), and Windows (cmd /c).
  const { file, args } = buildShellInvocation(proc.command)
  const env: Record<string, string | undefined> = { ...process.env }
  const enrichedPath = getEnrichedPath()
  if (enrichedPath) env.PATH = enrichedPath
  const child = spawn(file, args, { cwd: proc.cwd, env, detached: !isWin })

  proc.child = child
  proc.pid = child.pid ?? null
  proc.exitCode = null
  proc.processTitle = null
  proc.oscTitleSet = false
  startTitlePolling(proc)

  child.stdout?.on('data', (data: Buffer) => handleProcessData(proc, data))
  child.stderr?.on('data', (data: Buffer) => handleProcessData(proc, data))

  child.on('exit', (code) => {
    if (proc.child !== child) return // stale exit from restarted process
    stopTitlePolling(proc)
    proc.pid = null
    proc.child = null
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
    child: null,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    spawnedAt: null,
    processTitle: null,
    titlePollTimer: null,
    oscTitleSet: false
  }
  processes.set(id, proc)
  void db
    ?.prepare(
      'INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, taskId, label, command, cwd, autoRestart ? 1 : 0)
  return id
}

export function spawnProcess(
  projectId: string | null,
  taskId: string | null,
  label: string,
  command: string,
  cwd: string,
  autoRestart: boolean
): string {
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
    child: null,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    spawnedAt: null,
    processTitle: null,
    titlePollTimer: null,
    oscTitleSet: false
  }
  processes.set(id, proc)
  void db
    ?.prepare(
      'INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, taskId, label, command, cwd, autoRestart ? 1 : 0)
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
  void db
    ?.prepare(
      `
    UPDATE processes SET
      project_id = ?, task_id = ?, label = ?, command = ?, cwd = ?, auto_restart = ?
    WHERE id = ?
  `
    )
    .run(
      proc.projectId,
      proc.taskId,
      proc.label,
      proc.command,
      proc.cwd,
      proc.autoRestart ? 1 : 0,
      id
    )
  return true
}

export function stopProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  // Set child to null before kill so the exit handler's `proc.child !== child`
  // guard bails out (prevents auto-restart from firing)
  const child = proc.child
  proc.child = null
  proc.pid = null
  proc.spawnedAt = null
  if (child) killProcessTree(child)
  setStatus(proc, 'stopped')
  return true
}

export function killProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  proc.autoRestart = false
  if (proc.child) killProcessTree(proc.child)
  proc.child = null
  processes.delete(id)
  void db?.prepare('DELETE FROM processes WHERE id = ?').run(id)
  return true
}

export function restartProcess(id: string): boolean {
  if (isShuttingDown) return false
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  if (proc.child) killProcessTree(proc.child)
  proc.child = null
  proc.logBuffer.push('[restarting...]')
  setStatus(proc, 'running')
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
    .map(({ child: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info)
}

export function listAllProcesses(): ProcessInfo[] {
  return Array.from(processes.values()).map(
    ({ child: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info
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
    if (proc.child) killProcessTree(proc.child)
    proc.child = null
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
    const child = proc.child
    const id = proc.id
    const errors: ProcessShutdownResult['errors'] = []
    if (!child) {
      resolve({ id, exited: true, killed: false, timedOut: false, errors })
      return
    }

    let settled = false
    let killed = false
    let termTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null

    const recordError = (phase: string, err: unknown): void => {
      errors.push({ id, phase, message: toErrorMessage(err) })
    }
    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer)
      if (hardTimer) clearTimeout(hardTimer)
      child.off('exit', onExit)
    }
    const settle = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) {
        stopTitlePolling(proc)
        proc.child = null
        proc.pid = null
        proc.spawnedAt = null
      }
      resolve({ id, exited: !timedOut, killed, timedOut, errors })
    }
    const onExit = (): void => settle(false)

    proc.autoRestart = false
    stopTitlePolling(proc)
    child.once('exit', onExit)

    try {
      killProcessTree(child, 'SIGTERM')
    } catch (err) {
      recordError('sigterm', err)
    }

    termTimer = setTimeout(() => {
      killed = true
      try {
        killProcessTree(child, 'SIGKILL')
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
