import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
// Background processes run on computers: this suite drives the manager through a
// fake routed backend, every spawn resolved to computer 'c1'.
import {
  spawnProcess,
  stopProcess,
  removeProcess,
  processEvents,
  setProcessComputerResolver
} from './process-manager'
import { setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle, ProcSpawnSpec } from './process-backend'
import type { ProcessStatus } from '../shared'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- Global event capture (dual-emit bus the manager pushes to). Used for both
//     the fake-backend assertions and the real child_process case. ---
const logs: Array<{ id: string; line: string }> = []
const statuses: Array<{ id: string; status: ProcessStatus }> = []
processEvents.on('log', (id, line) => logs.push({ id, line }))
processEvents.on('status', (id, status) => statuses.push({ id, status }))

// --- Controllable fake backend: hands back a handle the test drives directly. ---
type DataCb = (chunk: string, stream: 'stdout' | 'stderr') => void
// The real onExit callback (doSpawn's) is async now — it awaits a group-verify
// sweep before deciding the final status, even when that sweep resolves with
// no real waiting (pid 4242 here is never a live group). `await`ing anything,
// including an already-resolved promise, still costs a microtask tick, so
// `emitExit` must be awaited by callers that then assert on the resulting
// status/log — a synchronous fire-and-check would race that tick.
type ExitCb = (e: { code: number | null; signal: string | null }) => void | Promise<void>

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
  async emitExit(code: number | null, signal: string | null = null): Promise<void> {
    await Promise.all([...this.exitSubs].map((cb) => cb({ code, signal })))
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

// The cases below are ONE sequential scenario (shared backend, shared event
// capture); vitest runs them in declaration order, so later tests read state the
// earlier ones produced.

// ============================ FAKE BACKEND ============================
describe('fake backend', () => {
  beforeAll(() => {
    setProcessBackend(fakeBackend)
    setProcessComputerResolver(async () => 'c1')
  })
  afterAll(() => {
    setProcessComputerResolver(null)
    setProcessBackend(null)
  })

  // --- doSpawn routes through the backend with the right spec ---
  describe('doSpawn routes through the backend with the right spec', () => {
    let idA = ''
    test('spawnProcess drives backend.spawn', async () => {
      idA = await spawnProcess('proj', 'task', 'A', 'echo a', '/tmp', false)
      expect(spawned.length).toBe(1)
    })
    test('spec carries command + cwd', () => {
      expect(lastSpec!.command).toBe('echo a')
      expect(lastSpec!.cwd).toBe('/tmp')
    })
    test('spec carries task/project id', () => {
      expect(lastSpec!.taskId).toBe('task')
      expect(lastSpec!.projectId).toBe('proj')
    })
    test('spec names the resolved computer', () => {
      expect(lastSpec!.computerId).toBe('c1')
    })

    // --- streaming: stdout AND stderr chunks both route to the processEvents log ---
    test('stdout chunk → processEvents log', () => {
      const hA = spawned[0]
      hA.emitData('out-line\n', 'stdout')
      hA.emitData('err-line\n', 'stderr')
      expect(logs).toContainEqual({ id: idA, line: 'out-line' })
    })
    test('stderr chunk → processEvents log', () => {
      expect(logs).toContainEqual({ id: idA, line: 'err-line' })
    })

    // --- kill: stopProcess routes handle.kill() (default SIGTERM) + emits stopped ---
    test('stopProcess returns true', async () => {
      expect(await stopProcess(idA)).toBe(true)
    })
    test('stopProcess routes handle.kill(SIGTERM)', () => {
      expect(spawned[0].killSignals).toEqual(['SIGTERM'])
    })
    test('stopProcess emits stopped status', () => {
      expect(statuses).toContainEqual({ id: idA, status: 'stopped' })
      removeProcess(idA)
    })
  })

  // --- exit → completed / error (no autoRestart) ---
  test('exit code 0 (no autoRestart) → completed', async () => {
    const idB = await spawnProcess('proj', 'task', 'B', 'echo b', '/tmp', false)
    await spawned[spawned.length - 1].emitExit(0)
    expect(statuses).toContainEqual({ id: idB, status: 'completed' })
    removeProcess(idB)
  })

  test('exit code 1 (no autoRestart) → error', async () => {
    const idC = await spawnProcess('proj', 'task', 'C', 'false', '/tmp', false)
    await spawned[spawned.length - 1].emitExit(1)
    expect(statuses).toContainEqual({ id: idC, status: 'error' })
    removeProcess(idC)
  })

  // --- exit → autoRestart: restart signals synchronously, re-spawn after timer ---
  describe('exit → autoRestart', () => {
    let idD = ''
    let beforeRestart = 0
    test('autoRestart exit pushes a "restarting" log line', async () => {
      idD = await spawnProcess('proj', 'task', 'D', 'echo d', '/tmp', true)
      beforeRestart = spawned.length
      await spawned[beforeRestart - 1].emitExit(1)
      expect(logs.some((l) => l.id === idD && l.line.includes('restarting'))).toBe(true)
    })
    test('autoRestart exit sets status running (not error/completed)', () => {
      expect(statuses).toContainEqual({ id: idD, status: 'running' })
    })
    test('autoRestart process never reports error/completed on exit', () => {
      const ended = statuses.filter(
        (s) => s.id === idD && (s.status === 'error' || s.status === 'completed')
      )
      expect(ended).toEqual([])
    })
    test('autoRestart re-spawns through the backend after the timer', async () => {
      await delay(1200) // doSpawn re-fires on a 1s timer
      expect(spawned.length).toBe(beforeRestart + 1)
    })
    test('removeProcess stops the restart loop', () => {
      expect(removeProcess(idD)).toBe(true)
    })
    // The row goes synchronously; its tree is terminated right after (a descendant
    // snapshot precedes the first signal).
    test('removeProcess routes handle.kill on the restarted handle', async () => {
      await vi.waitFor(() =>
        expect(spawned[spawned.length - 1].killSignals.length).toBeGreaterThanOrEqual(1)
      )
    })
  })
})
