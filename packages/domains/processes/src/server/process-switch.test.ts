/**
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-04): the process manager loads no persisted
 * row, every entry point that would start or reconfigure a process refuses with one
 * `hub.process.spawn` audit line, and the backend itself never reaches
 * `child_process.spawn` — asserted on the backend and on the OS process table, not
 * just on the thrown error. The default (switch unset) path is
 * process-manager.test.ts.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import {
  createProcess,
  initProcessManagerWith,
  killProcess,
  listAllProcesses,
  restartProcess,
  spawnProcess,
  updateProcess
} from './process-manager'
import { localProcessBackend, setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle } from './process-backend'
import type { ProcessPersistence } from './process-persistence'

async function refusal(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

/** Live children of this test process (pgrep never lists itself). */
function childPids(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

const lines: Array<{ event: string; outcome: string; detail: Record<string, unknown> }> = []

// A backend that records instead of spawning — the manager must never reach it.
let backendSpawns = 0
const recordingBackend: ProcessBackend = {
  spawn(): ProcHandle {
    backendSpawns++
    throw new Error('backend reached')
  },
  getCommandLine: async () => null,
  killByPid: () => undefined
}

// --- boot: persisted rows are not loaded, so nothing can be restarted or swept ---
let loadAllCalls = 0
const persistence: ProcessPersistence = {
  loadAll: async () => {
    loadAllCalls++
    return [
      {
        id: 'persisted-1',
        task_id: null,
        project_id: 'p1',
        label: 'dev',
        command: 'sleep 30',
        cwd: '/tmp',
        auto_restart: 1,
        pid: 999999
      }
    ]
  },
  insert: async () => undefined,
  update: async () => undefined,
  updatePid: async () => undefined,
  remove: async () => undefined
} as unknown as ProcessPersistence

beforeAll(async () => {
  setSecurityLogSink((line) => lines.push(JSON.parse(line)))
  setProcessBackend(recordingBackend)
  process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
  await initProcessManagerWith(persistence)
})

afterAll(() => {
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
  setSecurityLogSink()
  setProcessBackend(null)
})

// Tests run in declaration order and share the manager's module state.
describe('processes switched off', () => {
  test('init: persisted rows not loaded', () => {
    expect(loadAllCalls).toBe(0)
  })
  test('init: registry stays empty', () => {
    expect(listAllProcesses()).toHaveLength(0)
  })
  test('init: boot skip is not a refusal (no audit line)', () => {
    expect(lines).toHaveLength(0)
  })

  // --- every entry point refuses, one audit line each ---
  const cases: Array<[string, () => unknown]> = [
    ['create', () => createProcess('p1', null, 'dev', 'sleep 30', '/tmp', false)],
    ['spawn', () => spawnProcess('p1', null, 'dev', 'sleep 30', '/tmp', false)],
    ['update', () => updateProcess('persisted-1', { command: 'sleep 31' })],
    ['restart', () => restartProcess('persisted-1')]
  ]
  for (const [op, fn] of cases) {
    describe(op, () => {
      let before = 0
      let err: unknown = null
      test(`${op}: refused with HubSwitchedOffError`, async () => {
        before = lines.length
        err = await refusal(fn)
        expect(isHubSwitchedOffError(err)).toBe(true)
      })
      test(`${op}: code HUB_PROCESSES_DISABLED`, () => {
        expect((err as { code?: string }).code).toBe('HUB_PROCESSES_DISABLED')
      })
      test(`${op}: exactly one audit line`, () => {
        expect(lines.length).toBe(before + 1)
      })
      test(`${op}: hub.process.spawn denied, detail.op=${op}`, () => {
        const line = lines[lines.length - 1]
        expect(line.event).toBe('hub.process.spawn')
        expect(line.outcome).toBe('denied')
        expect(line.detail.op).toBe(op)
      })
    })
  }
  test('backend never asked to spawn', () => {
    expect(backendSpawns).toBe(0)
  })
  test('nothing registered', () => {
    expect(listAllProcesses()).toHaveLength(0)
  })

  // --- the backend refuses on its own: a path that skipped the manager still cannot spawn ---
  describe('the backend refuses on its own', () => {
    let childrenBefore = 0
    let backendErr: unknown = null
    test('localProcessBackend.spawn refused', async () => {
      childrenBefore = childPids().length
      backendErr = await refusal(() =>
        localProcessBackend.spawn({
          id: 'direct',
          taskId: null,
          projectId: null,
          computerId: null,
          command: 'sleep 30',
          cwd: '/tmp'
        })
      )
      expect(isHubSwitchedOffError(backendErr)).toBe(true)
    })
    test('backend refusal audited (op backend.spawn)', () => {
      expect(lines[lines.length - 1]?.detail.op).toBe('backend.spawn')
    })
    test('no child process started', () => {
      expect(childPids().length).toBe(childrenBefore)
    })
  })

  // --- stop/kill/list stay available (nothing to act on) ---
  test('kill of an unknown id still answers', () => {
    expect(killProcess('missing')).toBe(false)
  })
})

// --- switch back on: the same manager spawns again (defaults unchanged) ---
describe('switch back on', () => {
  test('default: create works', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    const id = await createProcess('p1', null, 'dev', 'echo hi', '/tmp', false)
    expect(typeof id).toBe('string')
    expect(listAllProcesses().map((p) => p.id)).toContain(id)
    killProcess(id)
  })
})
