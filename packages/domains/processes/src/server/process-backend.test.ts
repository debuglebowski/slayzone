import {
  spawnProcess,
  stopProcess,
  killProcess,
  processEvents,
  listAllProcesses
} from './process-manager'
import { setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle, ProcSpawnSpec } from './process-backend'
import type { ProcessStatus } from './process-manager'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- Global event capture (dual-emit bus the manager pushes to). Used for both
//     the fake-backend assertions and the real child_process case. ---
const logs: Array<{ id: string; line: string }> = []
const statuses: Array<{ id: string; status: ProcessStatus }> = []
processEvents.on('log', (id, line) => logs.push({ id, line }))
processEvents.on('status', (id, status) => statuses.push({ id, status }))

// --- Controllable fake backend: hands back a handle the test drives directly. ---
type DataCb = (chunk: string, stream: 'stdout' | 'stderr') => void
type ExitCb = (e: { code: number | null; signal: string | null }) => void

class FakeHandle implements ProcHandle {
  readonly pid: number | undefined = 4242
  private dataSubs = new Set<DataCb>()
  private exitSubs = new Set<ExitCb>()
  killSignals: string[] = []
  onData(cb: DataCb): { dispose(): void } {
    this.dataSubs.add(cb)
    return { dispose: () => void this.dataSubs.delete(cb) }
  }
  onExit(cb: ExitCb): { dispose(): void } {
    this.exitSubs.add(cb)
    return { dispose: () => void this.exitSubs.delete(cb) }
  }
  kill(sig?: string): void {
    this.killSignals.push(sig ?? 'SIGTERM')
  }
  // test drivers
  emitData(chunk: string, stream: 'stdout' | 'stderr'): void {
    for (const cb of [...this.dataSubs]) cb(chunk, stream)
  }
  emitExit(code: number | null, signal: string | null = null): void {
    for (const cb of [...this.exitSubs]) cb({ code, signal })
  }
}

const spawned: FakeHandle[] = []
let lastSpec: ProcSpawnSpec | null = null
const fakeBackend: ProcessBackend = {
  spawn(spec: ProcSpawnSpec): ProcHandle {
    lastSpec = spec
    const h = new FakeHandle()
    spawned.push(h)
    return h
  }
}

async function main(): Promise<void> {
  // ============================ FAKE BACKEND ============================
  setProcessBackend(fakeBackend)

  // --- doSpawn routes through the backend with the right spec ---
  const idA = spawnProcess('proj', 'task', 'A', 'echo a', '/tmp', false)
  assert(spawned.length === 1, 'spawnProcess drives backend.spawn')
  assert(lastSpec!.command === 'echo a' && lastSpec!.cwd === '/tmp', 'spec carries command + cwd')
  assert(
    lastSpec!.taskId === 'task' && lastSpec!.projectId === 'proj',
    'spec carries task/project id'
  )
  assert(lastSpec!.runnerId === null, 'runnerId is dark (null) on the local path')
  assert(
    listAllProcesses().find((p) => p.id === idA)?.pid === 4242,
    'handle.pid propagates to proc.pid'
  )
  const hA = spawned[0]

  // --- streaming: stdout AND stderr chunks both route to the processEvents log ---
  hA.emitData('out-line\n', 'stdout')
  hA.emitData('err-line\n', 'stderr')
  assert(
    logs.some((l) => l.id === idA && l.line === 'out-line'),
    'stdout chunk → processEvents log'
  )
  assert(
    logs.some((l) => l.id === idA && l.line === 'err-line'),
    'stderr chunk → processEvents log'
  )

  // --- kill: stopProcess routes handle.kill() (default SIGTERM) + emits stopped ---
  assert(stopProcess(idA), 'stopProcess returns true')
  assert(
    hA.killSignals.length === 1 && hA.killSignals[0] === 'SIGTERM',
    'stopProcess routes handle.kill(SIGTERM)'
  )
  assert(
    statuses.some((s) => s.id === idA && s.status === 'stopped'),
    'stopProcess emits stopped status'
  )
  killProcess(idA)

  // --- exit → completed / error (no autoRestart) ---
  const idB = spawnProcess('proj', 'task', 'B', 'echo b', '/tmp', false)
  spawned[spawned.length - 1].emitExit(0)
  assert(
    statuses.some((s) => s.id === idB && s.status === 'completed'),
    'exit code 0 (no autoRestart) → completed'
  )
  killProcess(idB)

  const idC = spawnProcess('proj', 'task', 'C', 'false', '/tmp', false)
  spawned[spawned.length - 1].emitExit(1)
  assert(
    statuses.some((s) => s.id === idC && s.status === 'error'),
    'exit code 1 (no autoRestart) → error'
  )
  killProcess(idC)

  // --- exit → autoRestart: restart signals synchronously, re-spawn after timer ---
  const idD = spawnProcess('proj', 'task', 'D', 'echo d', '/tmp', true)
  const beforeRestart = spawned.length
  spawned[beforeRestart - 1].emitExit(1)
  assert(
    logs.some((l) => l.id === idD && l.line.includes('restarting')),
    'autoRestart exit pushes a "restarting" log line'
  )
  assert(
    statuses.some((s) => s.id === idD && s.status === 'running'),
    'autoRestart exit sets status running (not error/completed)'
  )
  assert(
    !statuses.some((s) => s.id === idD && (s.status === 'error' || s.status === 'completed')),
    'autoRestart process never reports error/completed on exit'
  )
  await delay(1200) // doSpawn re-fires on a 1s timer
  assert(
    spawned.length === beforeRestart + 1,
    'autoRestart re-spawns through the backend after the timer'
  )
  assert(killProcess(idD), 'killProcess stops the restart loop')
  assert(
    spawned[spawned.length - 1].killSignals.length >= 1,
    'killProcess routes handle.kill on the restarted handle'
  )

  // ==================== REAL child_process (local backend) ====================
  setProcessBackend(null) // restore localProcessBackend

  const idR = spawnProcess('proj', 'task', 'R', 'echo slayzone-real-ok', '/tmp', false)
  const sawLog = (): boolean => logs.some((l) => l.id === idR && l.line.includes('slayzone-real-ok'))
  const sawDone = (): boolean => statuses.some((s) => s.id === idR && s.status === 'completed')
  // `exit` can fire before the final stdout `data` flushes, so wait for BOTH the
  // log line and the completed status (deadline-bounded so a stuck child fails).
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !(sawLog() && sawDone())) {
    await delay(100)
  }
  assert(sawLog(), 'localProcessBackend streams real stdout → processEvents log')
  assert(sawDone(), 'localProcessBackend real exit(0) → completed')
  killProcess(idR)

  console.log('process-backend seam: all passed')
  process.exit(0)
}

void main()
