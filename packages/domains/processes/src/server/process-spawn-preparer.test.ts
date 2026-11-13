/**
 * The host prepares a process's computer before EVERY spawn, and hears about every
 * write of a process row.
 *
 * Why: v0.38.0 moved background processes onto the computer, whose jail refuses a cwd
 * outside its allowed roots. The hub widens the desktop's own computer for a process's
 * folder — and that must happen BEFORE the spawn reaches the computer. On a computer
 * (re)connect the auto-restart spawn otherwise raced the hub's root sync and was
 * refused. A removed process lets the hub take its folder's root away again.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  createProcess,
  initProcessManagerWith,
  listAllProcesses,
  processesComputerConnected,
  removeProcess,
  restartProcess,
  setProcessComputerResolver,
  setProcessPathScopeResolver,
  setProcessSpawnPreparer,
  setProcessWrittenListener,
  spawnProcess,
  updateProcess
} from './process-manager'
import {
  setProcessBackend,
  type ProcessBackend,
  type ProcHandle,
  type ProcSpawnSpec
} from './process-backend'
import type { ProcessPersistence } from './process-persistence'
import { currentPathScope, type WirePathScope } from '@slayzone/platform/path-scope'

const events: string[] = []
let removeDelayMs = 0
const persistence = {
  loadAll: async () => [],
  insert: async () => undefined,
  update: async () => undefined,
  remove: async (id: string) => {
    await new Promise((r) => setTimeout(r, removeDelayMs))
    events.push(`deleted:${id}`)
  }
} as unknown as ProcessPersistence
await initProcessManagerWith(persistence)

const specs: ProcSpawnSpec[] = []
const scopes: Array<WirePathScope | undefined> = []
setProcessBackend({
  spawn: (spec: ProcSpawnSpec): ProcHandle => {
    specs.push(spec)
    scopes.push(currentPathScope())
    events.push(`spawn:${spec.cwd}`)
    return {
      pid: undefined,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill: () => undefined
    }
  },
  getCommandLine: async () => null,
  killByPid: () => undefined
} as ProcessBackend)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const status = (id: string) => listAllProcesses().find((p) => p.id === id)

afterEach(() => {
  setProcessComputerResolver(null)
  setProcessPathScopeResolver(null)
  setProcessSpawnPreparer(null)
  setProcessWrittenListener(null)
  events.length = 0
  removeDelayMs = 0
})

describe('the spawn preparer', () => {
  test('runs to completion before the spawn reaches the computer', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    setProcessSpawnPreparer(async ({ computerId, cwd }) => {
      events.push(`prepare-start:${computerId}:${cwd}`)
      await sleep(30)
      events.push('prepare-done')
    })
    await spawnProcess(null, 'task-1', 'svc', 'run', '/Volumes/X/svc', false)
    expect(events).toEqual([
      'prepare-start:computer-1:/Volumes/X/svc',
      'prepare-done',
      'spawn:/Volumes/X/svc'
    ])
  })

  test('also before an auto-restart start on a computer connect', async () => {
    setProcessComputerResolver(async () => null)
    const id = await createProcess(null, null, 'keep-up', 'run', '/tmp/svc', true)
    await restartProcess(id)
    expect(status(id)?.status).toBe('error')
    events.length = 0
    setProcessComputerResolver(async () => 'computer-1')
    setProcessSpawnPreparer(async () => {
      await sleep(30)
      events.push('prepare-done')
    })
    await processesComputerConnected('computer-1')
    await sleep(60)
    expect(events).toEqual(['prepare-done', 'spawn:/tmp/svc'])
  })

  test('a failing preparer does not stop the spawn (the computer answers for itself)', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    setProcessSpawnPreparer(async () => {
      throw new Error('computer busy')
    })
    const id = await spawnProcess(null, null, 'svc', 'run', '/opt/x', false)
    expect(events).toEqual(['spawn:/opt/x'])
    expect(status(id)?.status).toBe('running')
  })

  test('a stop issued while it runs supersedes the spawn', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    let release: () => void = () => undefined
    setProcessSpawnPreparer(() => new Promise<void>((r) => (release = r)))
    const id = await createProcess(null, null, 'svc', 'run', '/opt/y', false)
    const restarted = restartProcess(id)
    await sleep(10)
    removeProcess(id)
    release()
    await restarted
    expect(events.filter((e) => e.startsWith('spawn:'))).toEqual([])
  })
})

describe('the written listener', () => {
  test('hears every create, update and remove — a remove once the row is gone', async () => {
    const heard: string[] = []
    setProcessWrittenListener(() => {
      heard.push('written')
      events.push('written')
    })
    const id = await createProcess(null, null, 'svc', 'run', '/opt/a', false)
    expect(heard).toEqual(['written'])
    await updateProcess(id, { cwd: '/opt/b' })
    expect(heard).toEqual(['written', 'written'])
    removeDelayMs = 20
    events.length = 0
    removeProcess(id)
    await sleep(50)
    // (An earlier test's removal may land here too; only this row's order matters.)
    expect(events.slice(events.indexOf(`deleted:${id}`))).toEqual([`deleted:${id}`, 'written'])
  })
})

// B1: a task's process row may carry no project id (the Processes dialog's "Task"
// scope). The computer no longer knows task → project for a task with no worktree,
// so the hub names the scope — the task with ITS project — on every spawn; a global
// process (no task, no project) is sent with none.
describe('the path scope resolver', () => {
  test('every spawn reaches the backend inside the scope the hub resolved for the row', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    const asked: Array<{ taskId: string | null; projectId: string | null }> = []
    setProcessPathScopeResolver(async (target) => {
      asked.push(target)
      return target.taskId
        ? { kind: 'task', taskId: target.taskId, projectId: 'project-of-task' }
        : null
    })
    scopes.length = 0
    const taskProc = await spawnProcess(null, 'task-1', 'svc', 'run', '/opt/t', false)
    await spawnProcess(null, null, 'global', 'run', '/opt/g', false)
    await restartProcess(taskProc)
    expect(asked).toEqual([
      { taskId: 'task-1', projectId: null },
      { taskId: null, projectId: null },
      { taskId: 'task-1', projectId: null }
    ])
    expect(scopes).toEqual([
      { kind: 'task', taskId: 'task-1', projectId: 'project-of-task' },
      undefined,
      { kind: 'task', taskId: 'task-1', projectId: 'project-of-task' }
    ])
  })
})

// Review 2, B3: a process row's working folder is the USER's — a sibling repo
// (`~/backend`), a legacy row's folder — so its computer starts it there even outside
// the task's folders. A project process sends no folder: its computer resolves the
// project's own folder there (a project has one per computer).
describe("the row's own folder", () => {
  test('a task or global process declares its cwd; a project process sends none', async () => {
    setProcessComputerResolver(async () => 'computer-1')
    specs.length = 0
    await spawnProcess(null, 'task-1', 'api', 'run', '/home/u/backend', false)
    await spawnProcess(null, null, 'global', 'run', '/opt/g', false)
    await spawnProcess('project-1', null, 'web', 'run', '/home/u/app', false)
    expect(specs.map((s) => [s.cwd, s.declaredCwd])).toEqual([
      ['/home/u/backend', true],
      ['/opt/g', true],
      ['', undefined]
    ])
  })
})
