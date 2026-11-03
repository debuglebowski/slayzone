/**
 * Background processes run on the project's (or task's) COMPUTER: the manager
 * resolves it asynchronously before each spawn (initial, restart, auto-restart) and
 * hands the backend its id. Pid-level work (stats, group reaping, stale-pid sweeps) is
 * the owner's — the hub never runs `pgrep`/`ps` against a pid from another machine.
 * A spawn with no computer becomes an actionable error status, never an unhandled
 * rejection from a timer.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  initProcessManagerWith,
  processEvents,
  listAllProcesses,
  restartProcess,
  setProcessComputerResolver,
  spawnProcess
} from './process-manager'
import {
  setProcessBackend,
  type ProcessBackend,
  type ProcHandle,
  type ProcSpawnSpec
} from './process-backend'
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
await initProcessManagerWith(persistence)

type ExitCb = (e: { code: number | null; signal: string | null }) => void | Promise<void>
const specs: ProcSpawnSpec[] = []
const killByPid: number[] = []
let exitCb: ExitCb | null = null
setProcessBackend({
  spawn: (spec: ProcSpawnSpec): ProcHandle => {
    specs.push(spec)
    return {
      pid: 777001,
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        exitCb = cb
        return { dispose() {} }
      },
      kill: () => undefined
    }
  },
  getCommandLine: async () => null,
  killByPid: (pid: number) => {
    killByPid.push(pid)
  }
} as ProcessBackend)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const status = (id: string) => listAllProcesses().find((p) => p.id === id)

afterEach(() => {
  setProcessComputerResolver(null)
})

describe('background processes on a computer', () => {
  test('the spawn names the resolved computer; a project process lets it resolve its own cwd', async () => {
    setProcessComputerResolver(async (p) => (p.projectId === 'proj-1' ? 'computer-1' : null))
    await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/hub/guess/of/path', false)
    expect(specs.at(-1)).toMatchObject({ computerId: 'computer-1', projectId: 'proj-1', cwd: '' })
  })

  test('a task process keeps its cwd (its worktree, a path on that computer)', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    await spawnProcess('proj-1', 'task-1', 'dev', 'pnpm dev', '/worktrees/task-1', false)
    expect(specs.at(-1)).toMatchObject({ computerId: 'computer-1', cwd: '/worktrees/task-1' })
  })

  test('without a resolver it runs where it always did (local, stored cwd)', async () => {
    await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/tmp', false)
    expect(specs.at(-1)).toMatchObject({ computerId: null, cwd: '/tmp' })
  })

  test("a routed process's unplanned exit leaves group reaping to its computer", async () => {
    setProcessComputerResolver(async () => 'computer-1')
    const id = await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/tmp', false)
    await exitCb?.({ code: 1, signal: null })
    expect(killByPid).toEqual([])
    expect(status(id)?.status).toBe('error')
  })

  test('a restart with no computer becomes an error status, not an unhandled rejection', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    const id = await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/tmp', false)
    setProcessComputerResolver(async () => {
      throw Object.assign(new Error('Connect a computer to run this process'), {
        code: 'NO_COMPUTER_CONNECTED'
      })
    })
    await restartProcess(id)
    await sleep(700)
    expect(status(id)?.status).toBe('error')
    expect(status(id)?.logBuffer.at(-1)).toMatch(/Connect a computer/)
  })

  test('an auto-restart with no computer becomes an error status too', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    const id = await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/tmp', true)
    setProcessComputerResolver(async () => null)
    await exitCb?.({ code: 1, signal: null })
    await sleep(1_200)
    expect(status(id)?.status).toBe('error')
    expect(status(id)?.logBuffer.at(-1)).toMatch(/computer/i)
  })
})

describe('stats + title of routed processes come from their computer', () => {
  test('the manager polls the backend for routed processes and emits stats and titles', async () => {
    const asked: string[][] = []
    setProcessBackend({
      spawn: (): ProcHandle => ({
        pid: 1,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        kill: () => undefined
      }),
      getCommandLine: async () => null,
      killByPid: () => undefined,
      stats: async (ids: string[]) => {
        asked.push(ids)
        return Object.fromEntries(ids.map((id) => [id, { cpu: 3, rss: 4096, title: 'node' }]))
      }
    } as ProcessBackend)
    setProcessComputerResolver(async () => 'computer-1')
    const stats: Array<Record<string, unknown>> = []
    const titles: Array<[string, string | null]> = []
    processEvents.on('stats', (s) => stats.push(s))
    processEvents.on('title', (id, t) => titles.push([id, t]))
    const id = await spawnProcess('proj-1', null, 'dev', 'pnpm dev', '/tmp', false)
    await sleep(3_300)
    expect(asked.some((ids) => ids.includes(id))).toBe(true)
    expect(stats.some((s) => (s[id] as { rss?: number } | undefined)?.rss === 4096)).toBe(true)
    expect(titles).toContainEqual([id, 'node'])
  }, 10_000)
})
