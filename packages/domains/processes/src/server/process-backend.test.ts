import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  spawnProcess,
  stopProcess,
  killProcess,
  processEvents,
  listAllProcesses
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
  },
  // Never a stale pid to reap in this suite (every spawnProcess() call mints a
  // fresh id), so these are unreachable — stubbed only to satisfy the interface.
  getCommandLine(): Promise<string | null> {
    return Promise.resolve(null)
  },
  killByPid(): void {}
}

// The cases below are ONE sequential scenario (shared backend, shared event
// capture); vitest runs them in declaration order, so later tests read state the
// earlier ones produced.

// ============================ FAKE BACKEND ============================
describe('fake backend', () => {
  beforeAll(() => {
    setProcessBackend(fakeBackend)
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
    test('computerId is dark (null) on the local path', () => {
      expect(lastSpec!.computerId).toBe(null)
    })
    test('handle.pid propagates to proc.pid', () => {
      expect(listAllProcesses().find((p) => p.id === idA)?.pid).toBe(4242)
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
    test('stopProcess returns true', () => {
      expect(stopProcess(idA)).toBe(true)
    })
    test('stopProcess routes handle.kill(SIGTERM)', () => {
      expect(spawned[0].killSignals).toEqual(['SIGTERM'])
    })
    test('stopProcess emits stopped status', () => {
      expect(statuses).toContainEqual({ id: idA, status: 'stopped' })
      killProcess(idA)
    })
  })

  // --- exit → completed / error (no autoRestart) ---
  test('exit code 0 (no autoRestart) → completed', async () => {
    const idB = await spawnProcess('proj', 'task', 'B', 'echo b', '/tmp', false)
    await spawned[spawned.length - 1].emitExit(0)
    expect(statuses).toContainEqual({ id: idB, status: 'completed' })
    killProcess(idB)
  })

  test('exit code 1 (no autoRestart) → error', async () => {
    const idC = await spawnProcess('proj', 'task', 'C', 'false', '/tmp', false)
    await spawned[spawned.length - 1].emitExit(1)
    expect(statuses).toContainEqual({ id: idC, status: 'error' })
    killProcess(idC)
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
    test('killProcess stops the restart loop', () => {
      expect(killProcess(idD)).toBe(true)
    })
    test('killProcess routes handle.kill on the restarted handle', () => {
      expect(spawned[spawned.length - 1].killSignals.length).toBeGreaterThanOrEqual(1)
    })
  })
})

// ==================== REAL child_process (local backend) ====================
describe('real child_process (local backend)', () => {
  beforeAll(() => {
    setProcessBackend(null) // restore localProcessBackend
  })

  describe('streaming + exit', () => {
    let idR = ''
    const sawLog = (): boolean =>
      logs.some((l) => l.id === idR && l.line.includes('slayzone-real-ok'))
    const sawDone = (): boolean => statuses.some((s) => s.id === idR && s.status === 'completed')

    beforeAll(async () => {
      idR = await spawnProcess('proj', 'task', 'R', 'echo slayzone-real-ok', '/tmp', false)
      // `exit` can fire before the final stdout `data` flushes, so wait for BOTH the
      // log line and the completed status (deadline-bounded so a stuck child fails).
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !(sawLog() && sawDone())) {
        await delay(100)
      }
    })
    afterAll(() => {
      killProcess(idR)
    })

    test('localProcessBackend streams real stdout → processEvents log', () => {
      expect(sawLog()).toBe(true)
    })
    test('localProcessBackend real exit(0) → completed', () => {
      expect(sawDone()).toBe(true)
    })
  })

  // === env sanitize: a user `run` process must NOT inherit the host's SlayZone
  //     infra/secret env (localProcessBackend routes through sanitizeSpawnEnv). ===
  describe('env sanitize', () => {
    let idE = ''
    const envLine = (): string =>
      logs
        .filter((l) => l.id === idE)
        .map((l) => l.line)
        .join('')
    const sawEnv = (): boolean => envLine().includes('PATHLEN:')
    const doneE = (): boolean => statuses.some((s) => s.id === idE && s.status === 'completed')

    beforeAll(async () => {
      process.env.SLAYZONE_HUB_TOKEN = 'leak-secret'
      process.env.SLAYZONE_HUB_ADDRESS = 'hub.example:8443'
      // Colon delimiters (not [brackets]) — interactive zsh globs `[]` and errors.
      idE = await spawnProcess(
        'proj',
        'task',
        'E',
        'echo TOK:$SLAYZONE_HUB_TOKEN: ADDR:$SLAYZONE_HUB_ADDRESS: PATHLEN:${#PATH}:',
        '/tmp',
        false
      )
      const deadlineE = Date.now() + 15000
      while (Date.now() < deadlineE && !(sawEnv() && doneE())) {
        await delay(100)
      }
      delete process.env.SLAYZONE_HUB_TOKEN
      delete process.env.SLAYZONE_HUB_ADDRESS
    })
    afterAll(() => {
      killProcess(idE)
    })

    test('sanitize case: child emitted its env line', () => {
      expect(sawEnv()).toBe(true)
    })
    test('sanitize strips inherited SLAYZONE_HUB_TOKEN from a run process', () => {
      expect(envLine()).toContain('TOK::')
    })
    test('sanitize strips inherited SLAYZONE_HUB_ADDRESS from a run process', () => {
      expect(envLine()).toContain('ADDR::')
    })
    test('sanitize keeps a non-empty PATH for a run process', () => {
      expect(envLine()).not.toMatch(/PATHLEN:0:/)
    })
  })

  // === a cwd that does not exist (T-102): spawn reports it as an 'error' event after
  //     returning; unheard, that threw out of this process. Now: a log line + error. ===
  describe('a cwd that does not exist (T-102)', () => {
    let idX = ''
    const failLine = (): boolean =>
      logs.some(
        (l) => l.id === idX && l.line.includes('failed to start') && l.line.includes('ENOENT')
      )
    const erroredX = (): boolean => statuses.some((s) => s.id === idX && s.status === 'error')

    beforeAll(async () => {
      idX = await spawnProcess('proj', 'task', 'X', 'echo never', '/no/such/dir-t102', false)
      const deadlineX = Date.now() + 5000
      while (Date.now() < deadlineX && !(failLine() && erroredX())) {
        await delay(50)
      }
    })
    afterAll(() => {
      killProcess(idX)
    })

    test('missing cwd: the reason is logged (failed to start … ENOENT)', () => {
      expect(failLine()).toBe(true)
    })
    test('missing cwd: status error, and this process is still running', () => {
      expect(erroredX()).toBe(true)
    })
    test('missing cwd: no pid recorded', () => {
      expect(listAllProcesses().find((p) => p.id === idX)?.pid).toBe(null)
    })
  })
})
