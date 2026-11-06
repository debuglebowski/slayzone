/**
 * A hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0` never runs a process on ITS machine —
 * but once background processes route to computers it can manage them: rows load
 * (when routing is wired, after boot), create/start/restart go to the project's
 * computer, and nothing local is ever spawned, polled or signalled. Without routing
 * the refusals of process-switch.test.ts stand.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  createProcess,
  initProcessManagerWith,
  listAllProcesses,
  setProcessComputerResolver,
  spawnProcess,
  startProcess
} from './process-manager'
import {
  setProcessBackend,
  type ProcessBackend,
  type ProcHandle,
  type ProcSpawnSpec
} from './process-backend'
import type { ProcessPersistence } from './process-persistence'

const specs: ProcSpawnSpec[] = []
const backend: ProcessBackend = {
  spawn(spec): ProcHandle {
    specs.push(spec)
    return {
      pid: 123,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill: () => undefined
    }
  },
  getCommandLine: async () => null,
  killByPid: () => undefined
}

const persistence = {
  loadAll: async () => [
    {
      id: 'persisted-1',
      task_id: null,
      project_id: 'p1',
      label: 'dev',
      command: 'pnpm dev',
      cwd: '/hub/path',
      auto_restart: 0,
      pid: null
    }
  ],
  insert: async () => undefined,
  update: async () => undefined,
  updatePid: async () => undefined,
  recordPid: async () => undefined,
  listPidHistory: async () => [],
  removePidHistory: async () => undefined,
  remove: async () => undefined
} as unknown as ProcessPersistence

const children = (): string[] => {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)])
      .toString()
      .trim()
      .split('\n')
  } catch {
    return []
  }
}

beforeAll(async () => {
  process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
  setProcessBackend(backend)
  await initProcessManagerWith(persistence)
})

afterAll(() => {
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
  setProcessBackend(null)
  setProcessComputerResolver(null)
})

describe('processes switched off, routed to computers', () => {
  test('rows load once routing is wired', async () => {
    expect(listAllProcesses()).toHaveLength(0)
    setProcessComputerResolver(async () => 'computer-1')
    await new Promise((r) => setTimeout(r, 20))
    expect(listAllProcesses().map((p) => p.id)).toEqual(['persisted-1'])
  })

  test('create, spawn and start go to the computer', async () => {
    const before = children().length
    await createProcess('p1', null, 'dev', 'pnpm dev', '/tmp', false)
    await spawnProcess('p1', null, 'dev', 'pnpm dev', '/tmp', false)
    expect(await startProcess('persisted-1')).toMatchObject({ ok: true })
    expect(specs.map((s) => s.computerId)).toEqual(['computer-1', 'computer-1'])
    expect(children().length).toBe(before)
  })

  test('no computer: a refusal naming it, still nothing local', async () => {
    setProcessComputerResolver(async () => null)
    const id = await createProcess('p1', null, 'dev2', 'pnpm dev', '/tmp', false)
    expect(await startProcess(id)).toEqual({ ok: false, reason: 'no-computer' })
    expect(specs).toHaveLength(2)
  })
})
