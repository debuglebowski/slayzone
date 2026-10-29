/**
 * Contract of the user-defined processes a task/project runs (the Processes
 * panel): the process manager (`../server`) produces it, the `processes` tRPC
 * router serves it, the renderer panel consumes it.
 *
 * Type-only and dependency-free: the `@slayzone/processes/shared` subpath, safe
 * to import from renderer bundles.
 */
export type ProcessStatus = 'running' | 'stopped' | 'completed' | 'error' | 'orphaned'

export interface ProcessStats {
  cpu: number // % of one core
  rss: number // kilobytes
}

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

// Streaming events emitted by the process manager. Shared home (with the other
// Process* types) so both the main-process emitter and the `ProcessesDeps.events`
// seam reference one map via TypedEmitter.
export type ProcessEventMap = {
  log: [id: string, line: string]
  status: [id: string, status: ProcessStatus]
  title: [id: string, title: string | null]
  stats: [stats: Record<string, ProcessStats>]
}
