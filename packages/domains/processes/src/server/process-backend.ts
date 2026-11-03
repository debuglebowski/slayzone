import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'

/**
 * The exec inputs the process manager hands a backend to launch a process.
 * Identity + routing metadata (`id`, `taskId`, `projectId`, `computerId`) plus the
 * exec spec proper (`command`, `cwd`, optional `env`; an empty `cwd` = the
 * project's folder on that computer).
 */
export interface ProcSpawnSpec {
  id: string
  taskId: string | null
  projectId: string | null
  computerId: string | null
  command: string
  cwd: string
  env?: Record<string, string>
}

/**
 * Structural superset of the `ChildProcess` surface the process manager needs.
 * The manager holds one of these per running process instead of a raw
 * `ChildProcess`, so the exec substrate — local `child_process.spawn` today, a
 * remote computer tomorrow — can vary without the manager changing. `onData` /
 * `onExit` return disposables (the manager attaches one listener; shutdown adds
 * a second — Node's `EventEmitter` allowed both, so the fan-out below must too).
 */
export interface ProcHandle {
  readonly pid: number | undefined
  onData(cb: (chunk: string, stream: 'stdout' | 'stderr') => void): { dispose(): void }
  /**
   * `detail`: why it ended, in the words of whoever ran it (a computer's refusal or
   * the OS error it reported) — absent for an ordinary exit.
   */
  onExit(cb: (e: { code: number | null; signal: string | null; detail?: string }) => void): {
    dispose(): void
  }
  /** Kill the whole process tree (POSIX detached-group / Windows `taskkill /T`). */
  kill(sig?: string): void
  /**
   * A process that starts ELSEWHERE (a computer): fires once it really runs there,
   * with its pid on that machine. Absent on the local backend (pid is known at once).
   */
  onSpawned?(cb: (e: { pid: number }) => void): { dispose(): void }
}

/** Spawns processes for the manager — on a computer (the hub's routing backend). */
export interface ProcessBackend {
  spawn(spec: ProcSpawnSpec): ProcHandle
  /**
   * cpu/memory + title of processes the backend runs ELSEWHERE (a computer), by
   * process id. Absent on the local backend: the manager reads local pids itself.
   */
  stats?(ids: string[]): Promise<Record<string, { cpu: number; rss: number; title: string | null }>>
  /**
   * @deprecated Unused: the hub never inspects a pid (processes run on computers).
   * Optional until every implementer drops it.
   */
  getCommandLine?(pid: number): Promise<string | null>
  /**
   * Processes `computerId` runs that this backend does not track — runs a previous
   * hub left there (it restarted; they kept going). Absent on the local backend
   * (the boot liveness probe covers local pids).
   */
  listSessions?(computerId: string): Promise<Array<{ sessionId: string; pid?: number }>>
  /** End such an untracked run on its computer (tree-kill there). */
  killSession?(computerId: string, sessionId: string): Promise<void>
  /** @deprecated Unused: the hub never signals a pid. Optional until implementers drop it. */
  killByPid?(pid: number, sig?: string): void
}

/**
 * The default: no computer to run on. The hub wires the routing backend (its
 * computers); until then — and on any host without one — every spawn is the
 * actionable "connect a computer". There is no local `child_process` backend: the hub
 * never runs a background process itself.
 */
export const noComputerProcessBackend: ProcessBackend = {
  spawn(spec: ProcSpawnSpec): ProcHandle {
    return refuseNoComputer({
      op: 'processes.backend.spawn',
      detail: { processId: spec.id, taskId: spec.taskId, projectId: spec.projectId }
    })
  }
}

let backend: ProcessBackend = noComputerProcessBackend

export function getProcessBackend(): ProcessBackend {
  return backend
}

/** Swap the spawn backend (the hub's routing one). `null` restores "no computer". */
export function setProcessBackend(b: ProcessBackend | null): void {
  backend = b ?? noComputerProcessBackend
}
