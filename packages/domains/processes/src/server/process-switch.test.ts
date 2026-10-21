/**
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-04): the process manager loads no persisted
 * row, every entry point that would start or reconfigure a process refuses with one
 * `hub.process.spawn` audit line, and the backend itself never reaches
 * `child_process.spawn` — asserted on the backend and on the OS process table, not
 * just on the thrown error. The default (switch unset) path is
 * process-manager.test.ts.
 *
 * Run with: npx tsx --experimental-loader ./packages/shared/test-utils/loader.ts packages/domains/processes/src/server/process-switch.test.ts
 */
import { execFileSync } from 'node:child_process'
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

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

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
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

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
setProcessBackend(recordingBackend)

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'

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
await initProcessManagerWith(persistence)
assert(loadAllCalls === 0, 'init: persisted rows not loaded')
assert(listAllProcesses().length === 0, 'init: registry stays empty')
assert(lines.length === 0, 'init: boot skip is not a refusal (no audit line)')

// --- every entry point refuses, one audit line each ---
const cases: Array<[string, () => unknown]> = [
  ['create', () => createProcess('p1', null, 'dev', 'sleep 30', '/tmp', false)],
  ['spawn', () => spawnProcess('p1', null, 'dev', 'sleep 30', '/tmp', false)],
  ['update', () => updateProcess('persisted-1', { command: 'sleep 31' })],
  ['restart', () => restartProcess('persisted-1')]
]
for (const [op, fn] of cases) {
  const before = lines.length
  const err = await refusal(fn)
  assert(isHubSwitchedOffError(err), `${op}: refused with HubSwitchedOffError`)
  assert(
    (err as { code?: string }).code === 'HUB_PROCESSES_DISABLED',
    `${op}: code HUB_PROCESSES_DISABLED`
  )
  assert(lines.length === before + 1, `${op}: exactly one audit line`)
  const line = lines[lines.length - 1]
  assert(
    line.event === 'hub.process.spawn' && line.outcome === 'denied' && line.detail.op === op,
    `${op}: hub.process.spawn denied, detail.op=${op}`
  )
}
assert(backendSpawns === 0, 'backend never asked to spawn')
assert(listAllProcesses().length === 0, 'nothing registered')

// --- the backend refuses on its own: a path that skipped the manager still cannot spawn ---
const childrenBefore = childPids().length
const backendErr = await refusal(() =>
  localProcessBackend.spawn({
    id: 'direct',
    taskId: null,
    projectId: null,
    computerId: null,
    command: 'sleep 30',
    cwd: '/tmp'
  })
)
assert(isHubSwitchedOffError(backendErr), 'localProcessBackend.spawn refused')
assert(
  lines[lines.length - 1]?.detail.op === 'backend.spawn',
  'backend refusal audited (op backend.spawn)'
)
assert(childPids().length === childrenBefore, 'no child process started')

// --- stop/kill/list stay available (nothing to act on) ---
assert(killProcess('missing') === false, 'kill of an unknown id still answers')

// --- switch back on: the same manager spawns again (defaults unchanged) ---
delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
const id = createProcess('p1', null, 'dev', 'echo hi', '/tmp', false)
assert(
  typeof id === 'string' && listAllProcesses().some((p) => p.id === id),
  'default: create works'
)
killProcess(id)

setSecurityLogSink()
setProcessBackend(null)
console.log('\nprocess-switch: all passed')
