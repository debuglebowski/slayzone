import { spawn, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { buildShellInvocation } from '@slayzone/platform'
import { getEnrichedPath } from '@slayzone/terminal/server'

/**
 * The exec inputs the process manager hands a backend to launch a process.
 * Mirrors exactly what the in-process `doSpawn` consumed: identity + routing
 * metadata (`id`, `taskId`, `projectId`, `runnerId`) plus the exec spec proper
 * (`command`, `cwd`, optional `env`). `runnerId` is dark today (always `null`
 * for the local backend); a future runner-side backend routes on it.
 */
export interface ProcSpawnSpec {
  id: string
  taskId: string | null
  projectId: string | null
  runnerId: string | null
  command: string
  cwd: string
  env?: Record<string, string>
}

/**
 * Structural superset of the `ChildProcess` surface the process manager needs.
 * The manager holds one of these per running process instead of a raw
 * `ChildProcess`, so the exec substrate — local `child_process.spawn` today, a
 * remote runner tomorrow — can vary without the manager changing. `onData` /
 * `onExit` return disposables (the manager attaches one listener; shutdown adds
 * a second — Node's `EventEmitter` allowed both, so the fan-out below must too).
 */
export interface ProcHandle {
  readonly pid: number | undefined
  onData(cb: (chunk: string, stream: 'stdout' | 'stderr') => void): { dispose(): void }
  onExit(cb: (e: { code: number | null; signal: string | null }) => void): { dispose(): void }
  /** Kill the whole process tree (POSIX detached-group / Windows `taskkill /T`). */
  kill(sig?: string): void
}

/** Spawns processes for the manager. Swappable so exec can be remoted later. */
export interface ProcessBackend {
  spawn(spec: ProcSpawnSpec): ProcHandle
}

/** Kill the entire process tree rooted at `child` (must be spawned with
 *  `detached: true` on POSIX). Errors are swallowed — parity with the pre-seam
 *  inline `killProcessTree`, whose throws never reached callers. */
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

/**
 * Wrap a live `ChildProcess` as a `ProcHandle`. A single stdout/stderr/exit
 * listener fans out to every subscriber (iterating a snapshot, as Node's
 * `EventEmitter` does, so a subscriber disposing itself mid-dispatch is safe).
 * stdout/stderr are decoded to strings here — the pre-seam `handleProcessData`
 * did `data.toString()` first thing, so decoding at the seam is byte-identical.
 */
function makeLocalHandle(child: ChildProcess): ProcHandle {
  const dataSubs = new Set<(chunk: string, stream: 'stdout' | 'stderr') => void>()
  const exitSubs = new Set<(e: { code: number | null; signal: string | null }) => void>()

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    for (const cb of [...dataSubs]) cb(chunk, 'stdout')
  })
  child.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    for (const cb of [...dataSubs]) cb(chunk, 'stderr')
  })
  child.on('exit', (code, signal) => {
    for (const cb of [...exitSubs]) cb({ code, signal })
  })

  return {
    get pid() {
      return child.pid
    },
    onData(cb) {
      dataSubs.add(cb)
      return { dispose: () => void dataSubs.delete(cb) }
    },
    onExit(cb) {
      exitSubs.add(cb)
      return { dispose: () => void exitSubs.delete(cb) }
    },
    kill(sig?: string) {
      killProcessTree(child, (sig as NodeJS.Signals | undefined) ?? 'SIGTERM')
    }
  }
}

/**
 * Default backend: the current in-process `child_process.spawn`. Keeps the
 * exact env/shell/detached semantics `doSpawn` used — shell invocation via
 * `buildShellInvocation`, PATH enrichment via `getEnrichedPath`, `detached` on
 * POSIX. `spec.env` (unused by the manager today) layers over the base env so a
 * caller can override without changing this byte-identical default path.
 */
export const localProcessBackend: ProcessBackend = {
  spawn(spec: ProcSpawnSpec): ProcHandle {
    const isWin = process.platform === 'win32'
    // buildShellInvocation handles fish (-i -l for PATH init inside
    // `if status is-interactive` blocks), bash/zsh (-l only), and Windows (cmd /c).
    const { file, args } = buildShellInvocation(spec.command)
    const env: Record<string, string | undefined> = { ...process.env }
    const enrichedPath = getEnrichedPath()
    if (enrichedPath) env.PATH = enrichedPath
    if (spec.env) Object.assign(env, spec.env)
    const child = spawn(file, args, { cwd: spec.cwd, env, detached: !isWin })
    return makeLocalHandle(child)
  }
}

let backend: ProcessBackend = localProcessBackend

export function getProcessBackend(): ProcessBackend {
  return backend
}

/** Swap the spawn backend. `null` restores the local `child_process` default. */
export function setProcessBackend(b: ProcessBackend | null): void {
  backend = b ?? localProcessBackend
}
