import { spawn, execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { Database } from 'better-sqlite3'
import { extractOscTitle } from '@slayzone/terminal/shared'

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
  processTitle: string | null
}

interface ManagedProcess extends ProcessInfo {
  child: ChildProcess | null
  titlePollTimer: ReturnType<typeof setInterval> | null
  oscTitleSet: boolean  // true once an OSC title has been received; blocks ps polling
}

const LOG_BUFFER_MAX = 500

let win: BrowserWindow | null = null
let db: Database | null = null
const processes = new Map<string, ManagedProcess>()
const logSubscribers = new Map<string, Set<(line: string) => void>>()

export function subscribeToProcessLogs(id: string, cb: (line: string) => void): () => void {
  if (!logSubscribers.has(id)) logSubscribers.set(id, new Set())
  logSubscribers.get(id)!.add(cb)
  return () => logSubscribers.get(id)?.delete(cb)
}

export function setProcessManagerWindow(window: BrowserWindow): void {
  win = window
}

export function initProcessManager(database: Database): void {
  db = database
  const rows = db.prepare('SELECT * FROM processes ORDER BY created_at').all() as Array<{
    id: string; task_id: string | null; project_id: string | null; label: string; command: string; cwd: string; auto_restart: number
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
      processTitle: null, oscTitleSet: false,
      titlePollTimer: null,
    })
  }
}

function pushLog(proc: ManagedProcess, line: string): void {
  proc.logBuffer.push(line)
  if (proc.logBuffer.length > LOG_BUFFER_MAX) proc.logBuffer.shift()
  if (!win?.webContents.isDestroyed()) {
    win?.webContents.send('processes:log', proc.id, line)
  }
  logSubscribers.get(proc.id)?.forEach((cb) => cb(line))
}

function setStatus(proc: ManagedProcess, status: ProcessStatus): void {
  proc.status = status
  if (!win?.webContents.isDestroyed()) {
    win?.webContents.send('processes:status', proc.id, status)
  }
}

function pollProcessTitle(proc: ManagedProcess): void {
  const pid = proc.pid
  if (!pid || proc.oscTitleSet) return
  execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
    if (err || !stdout.trim() || proc.oscTitleSet) return
    const title = stdout.trim().split('/').pop()!
    if (!title) return
    emitTitle(proc, title, false)
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

function emitTitle(proc: ManagedProcess, title: string, fromOsc: boolean): void {
  if (title === proc.processTitle) return
  proc.processTitle = title
  // OSC title is explicit from the process — stop polling so ps doesn't overwrite it
  if (fromOsc) {
    proc.oscTitleSet = true
    stopTitlePolling(proc)
  }
  if (!win?.webContents.isDestroyed()) {
    win?.webContents.send('processes:title', proc.id, title)
  }
}

function handleProcessData(proc: ManagedProcess, data: Buffer): void {
  const str = data.toString()
  const oscTitle = extractOscTitle(str)
  if (oscTitle) emitTitle(proc, oscTitle, true)
  // Strip OSC sequences from log output
  const clean = str.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  for (const line of clean.split('\n')) {
    if (line.trim()) pushLog(proc, line)
  }
}

function doSpawn(proc: ManagedProcess): void {
  const child = spawn(proc.command, [], {
    cwd: proc.cwd,
    shell: true,
    env: { ...process.env }
  })

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
    if (proc.autoRestart && processes.has(proc.id)) {
      pushLog(proc, `[exited with code ${code ?? '?'}, restarting in 1s...]`)
      setStatus(proc, 'running')
      setTimeout(() => {
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
    id, taskId, projectId, label, command, cwd, autoRestart,
    status: 'stopped', pid: null, exitCode: null,
    logBuffer: [], child: null,
    startedAt: new Date().toISOString(),
    processTitle: null, titlePollTimer: null, oscTitleSet: false,
  }
  processes.set(id, proc)
  db?.prepare('INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)')
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
  const id = randomUUID()
  const proc: ManagedProcess = {
    id, taskId, projectId, label, command, cwd, autoRestart,
    status: 'running', pid: null, exitCode: null,
    logBuffer: [], child: null,
    startedAt: new Date().toISOString(),
    processTitle: null, titlePollTimer: null, oscTitleSet: false,
  }
  processes.set(id, proc)
  db?.prepare('INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, taskId, label, command, cwd, autoRestart ? 1 : 0)
  doSpawn(proc)
  return id
}

export function updateProcess(
  id: string,
  updates: Partial<Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>>
): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  Object.assign(proc, updates)
  db?.prepare(`
    UPDATE processes SET
      project_id = ?, task_id = ?, label = ?, command = ?, cwd = ?, auto_restart = ?
    WHERE id = ?
  `).run(proc.projectId, proc.taskId, proc.label, proc.command, proc.cwd, proc.autoRestart ? 1 : 0, id)
  return true
}

export function killProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  stopTitlePolling(proc)
  proc.autoRestart = false
  proc.child?.kill()
  proc.child = null
  processes.delete(id)
  db?.prepare('DELETE FROM processes WHERE id = ?').run(id)
  return true
}

export function restartProcess(id: string): boolean {
  const proc = processes.get(id)
  if (!proc) return false
  proc.child?.kill()
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
    .filter(p => p.taskId === taskId || (p.taskId === null && p.projectId != null && p.projectId === projectId))
    .map(({ child: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info)
}

export function listAllProcesses(): ProcessInfo[] {
  return Array.from(processes.values()).map(({ child: _, titlePollTimer: _t, oscTitleSet: _o, ...info }) => info)
}

export function killAllProcesses(): void {
  for (const proc of processes.values()) {
    stopTitlePolling(proc)
    proc.autoRestart = false
    proc.child?.kill()
    proc.child = null
  }
  processes.clear()
}
