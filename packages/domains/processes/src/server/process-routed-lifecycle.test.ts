/**
 * The start / stop / restart contract, over a routed backend (processes run only on
 * computers) — and with NO computer, on a hub with processes ON: spawn and start
 * answer "connect a computer" and never start a child of this process.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  initProcessManagerWith,
  isAdoptedOnComputer,
  listAllProcesses,
  processesComputerConnected,
  restartProcessDetailed,
  restartProcessForUi,
  setProcessComputerResolver,
  spawnProcess,
  startProcess,
  stopProcess
} from './process-manager'
import { setProcessBackend, type ProcessBackend, type ProcHandle } from './process-backend'
import type { ProcessPersistence } from './process-persistence'

const persistence = {
  loadAll: async () => [],
  insert: async () => undefined,
  update: async () => undefined,
  updatePid: async () => undefined,
  recordPid: async () => undefined,
  listPidHistory: async () => [],
  removePidHistory: async () => undefined,
  remove: async () => undefined
} as unknown as ProcessPersistence

/** Live children of this test process (pgrep never lists itself). */
function childPids(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

interface Fake extends ProcHandle {
  killed: string[]
}
const handles: Fake[] = []
const routed: ProcessBackend = {
  spawn(): ProcHandle {
    const h: Fake = {
      pid: undefined,
      killed: [],
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill(sig?: string) {
        h.killed.push(sig ?? 'SIGTERM')
      }
    }
    handles.push(h)
    return h
  }
}

const status = (id: string) => listAllProcesses().find((p) => p.id === id)

beforeAll(async () => {
  await initProcessManagerWith(persistence)
})
afterAll(() => {
  setProcessComputerResolver(null)
  setProcessBackend(null)
})

describe('no computer, processes ON: "connect a computer", never a local child', () => {
  let id = ''
  let childrenBefore = 0
  test('spawn answers; the process errors naming it', async () => {
    childrenBefore = childPids().length
    id = await spawnProcess('p', null, 'dev', 'sleep 30', '/tmp', false)
    expect(status(id)?.status).toBe('error')
    expect(status(id)?.logBuffer.join('\n')).toMatch(/Connect a computer/)
  })
  test('start: refused as no-computer', async () => {
    expect(await startProcess(id)).toEqual({ ok: false, reason: 'no-computer' })
  })
  test('a resolver that finds none: the same', async () => {
    setProcessComputerResolver(async () => null)
    expect(await startProcess(id)).toEqual({ ok: false, reason: 'no-computer' })
  })
  test('no child process was started', () => {
    expect(childPids().length).toBe(childrenBefore)
  })
})

describe('on a computer: start / stop / restart', () => {
  let id = ''
  beforeAll(() => {
    setProcessBackend(routed)
    setProcessComputerResolver(async () => 'c1')
  })
  test('spawn runs it on the computer', async () => {
    id = await spawnProcess('p', null, 'dev', 'pnpm dev', '/tmp', false)
    expect(handles).toHaveLength(1)
    expect(status(id)?.status).toBe('running')
  })
  test('start refuses a running row', async () => {
    expect(await startProcess(id)).toEqual({ ok: false, reason: 'already-running' })
  })
  test('restart ends the run on its computer, then starts a new one', async () => {
    const result = await restartProcessDetailed(id)
    expect(result.ok).toBe(true)
    expect(handles[0]?.killed).toEqual(['SIGTERM'])
    expect(handles).toHaveLength(2)
  })
  test('stop ends it there and reads stopped', async () => {
    expect(await stopProcess(id)).toBe(true)
    expect(handles[1]?.killed).toEqual(['SIGTERM'])
    expect(status(id)?.status).toBe('stopped')
  })
  test('start runs a stopped row again under the same id', async () => {
    expect(await startProcess(id)).toMatchObject({ ok: true })
    expect(handles).toHaveLength(3)
    expect(status(id)?.status).toBe('running')
  })
  test('start of an unknown id is refused', async () => {
    expect(await startProcess('nope')).toEqual({ ok: false, reason: 'not-found' })
  })
})

// The computer replies to a kill once the whole tree is gone (TERM, then KILL).
// Stop and Restart wait for that reply: marking stopped, or spawning again, before
// it let the restarted server collide with the old one's port.
describe('stop / restart wait for the computer to end the tree', () => {
  const pending: Array<(clean: boolean) => void> = []
  let spawns = 0
  const slowKill: ProcessBackend = {
    spawn(): ProcHandle {
      spawns++
      return {
        pid: 4242, // its pid on the computer
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        kill: () => new Promise<boolean>((resolve) => pending.push(resolve))
      }
    },
    // A survivor kept by session: its stop asks the computer again.
    killSession: () =>
      new Promise<void>((resolve, reject) =>
        pending.push((clean) => (clean ? resolve() : reject(new Error('survived'))))
      )
  }
  let id = ''
  beforeAll(async () => {
    setProcessBackend(slowKill)
    setProcessComputerResolver(async () => 'c1')
    id = await spawnProcess('p', null, 'srv', 'node server.js', '/tmp', false)
  })
  const tick = () => new Promise((r) => setTimeout(r, 20))

  test('restart spawns the new run only after the old tree is gone', async () => {
    const restart = restartProcessDetailed(id)
    await tick()
    expect(pending, 'the kill is in flight').toHaveLength(1)
    expect(spawns, 'no new run while the old one may hold its port').toBe(1)
    pending.shift()!(true)
    expect(await restart).toMatchObject({ ok: true })
    expect(spawns).toBe(2)
  })

  test('stop reads stopped only once the tree is gone', async () => {
    const stop = stopProcess(id)
    await tick()
    expect(status(id)?.status, 'not stopped while the kill is in flight').toBe('running')
    pending.shift()!(true)
    await stop
    expect(status(id)?.status).toBe('stopped')
  })

  test('restart does not start a new run while the old tree survives', async () => {
    await startProcess(id)
    const before = spawns
    const restart = restartProcessDetailed(id)
    await tick()
    pending.shift()!(false) // part of the old tree outlived SIGKILL
    expect(await restart, 'refused, with the reason').toEqual({
      ok: false,
      reason: 'old-run-survives'
    })
    expect(spawns, 'no second run on the same port').toBe(before)
    expect(status(id)?.status).toBe('orphaned')
    // Still stoppable: the survivor is reached again.
    const stop = stopProcess(id)
    await tick()
    expect(pending, 'a stop asks the computer again').toHaveLength(1)
    pending.shift()!(true)
    await stop
    expect(status(id)?.status).toBe('stopped')
  })

  // Round-3 F5, the reviewer's sequence: a restart is refused (old-run-survives) and
  // the row is orphaned with the survivor kept; pressing Start then spawned anyway —
  // the computer's replace-spawn SIGTERMs without waiting, so the new run collided
  // with the old port and the survivor became unreachable. Start ends a kept run
  // first, exactly as Restart does, and refuses the same way while it survives.
  test('F5: Start after old-run-survives ends the survivor first, refusing while it lives', async () => {
    await startProcess(id)
    const restart = restartProcessDetailed(id)
    await tick()
    pending.shift()!(false)
    expect(await restart).toEqual({ ok: false, reason: 'old-run-survives' })
    const before = spawns

    const start1 = startProcess(id)
    await tick()
    expect(pending, 'Start asks the computer to end the survivor').toHaveLength(1)
    expect(spawns, 'no spawn while it may hold the port').toBe(before)
    pending.shift()!(false) // still alive
    expect(await start1).toEqual({ ok: false, reason: 'old-run-survives' })
    expect(spawns).toBe(before)
    expect(status(id)?.status).toBe('orphaned')

    const start2 = startProcess(id)
    await tick()
    pending.shift()!(true) // gone now
    expect(await start2).toMatchObject({ ok: true })
    expect(spawns, 'then it starts').toBe(before + 1)
    // Leave it stopped for the next test.
    const stop = stopProcess(id)
    await tick()
    pending.shift()!(true)
    await stop
  })

  // The panel's Restart got only `false` back and showed nothing: the reason reached
  // only the log. The UI's restart now fails with it (shown as a toast).
  test('the UI restart surfaces old-run-survives as an error with its reason', async () => {
    await startProcess(id)
    const restart = restartProcessForUi(id)
    await tick()
    pending.shift()!(false)
    await expect(restart).rejects.toThrow(/still alive/)
    const stop = stopProcess(id)
    await tick()
    pending.shift()!(true)
    await stop
  })

  test('a tree that survived SIGKILL leaves the row orphaned, still stoppable', async () => {
    await startProcess(id)
    const stop = stopProcess(id)
    await tick()
    pending.shift()!(false)
    await stop
    expect(status(id)?.status).toBe('orphaned')
  })
})

// A run the computer kept from before a hub restart is adopted (orphaned, no
// handle). The routing backend's reconnect sweep asks this before ending a
// session it does not track — it must say yes for exactly that run.
describe('adopted runs are reported to the reconnect sweep', () => {
  test('a kept run is adopted; another session or computer is not', async () => {
    setProcessBackend({
      spawn: () => {
        throw new Error('not spawned here')
      },
      listSessions: async () => [{ sessionId: keptId, pid: 4242 }]
    } as unknown as ProcessBackend)
    setProcessComputerResolver(async () => null)
    const keptId = await spawnProcess('p', null, 'kept', 'pnpm dev', '/tmp', false)
    expect(isAdoptedOnComputer('c9', keptId)).toBe(false)
    await processesComputerConnected('c9')
    expect(status(keptId)?.status).toBe('orphaned')
    expect(isAdoptedOnComputer('c9', keptId)).toBe(true)
    expect(isAdoptedOnComputer('c1', keptId)).toBe(false)
    expect(isAdoptedOnComputer('c9', 'other')).toBe(false)
  })
})
