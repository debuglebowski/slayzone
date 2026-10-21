/**
 * Switch refusals (T-04, T-05, T-06, T-07): one audit line + one error shape per refusal,
 * nothing at all with the switches at their defaults.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-switch-refusal.test.ts
 */
import {
  HubSwitchedOffError,
  assertHubIntegrationsEnabled,
  assertHubLocalExecEnabled,
  assertHubProcessesEnabled,
  hubIntegrationsEnabled,
  hubProcessesEnabled,
  isHubSwitchedOffError
} from './hub-switch-refusal'
import { runWithSecurityContext, setSecurityLogSink } from './security-log'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
function caught(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

const PROCESSES = 'SLAYZONE_HUB_ENABLE_PROCESSES'
const INTEGRATIONS = 'SLAYZONE_HUB_ENABLE_INTEGRATIONS'
delete process.env[PROCESSES]
delete process.env[INTEGRATIONS]

let lines: Array<Record<string, unknown>> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))

// --- defaults: both on, nothing refused, nothing logged ---
check('default: processes enabled', hubProcessesEnabled() === true)
check('default: integrations enabled', hubIntegrationsEnabled() === true)
check(
  'default: process assert passes',
  caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' })) === null
)
check(
  'default: integration assert passes',
  caught(() => assertHubIntegrationsEnabled({ op: 'connect' })) === null
)
check(
  'default: local exec assert passes',
  caught(() => assertHubLocalExecEnabled({ op: 'git' })) === null
)
check('default: no audit line', lines.length === 0)
check('explicit 1 = enabled', hubProcessesEnabled({ [PROCESSES]: '1' }) === true)

// --- processes off ---
process.env[PROCESSES] = '0'
lines = []
const procErr = runWithSecurityContext(
  { actor: 'user-1', ip: '203.0.113.7', route: 'trpc processes.spawn' },
  () =>
    caught(() =>
      assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn', detail: { taskId: 't1' } })
    )
)
check('processes off: throws HubSwitchedOffError', procErr instanceof HubSwitchedOffError)
const pe = procErr as HubSwitchedOffError
check('processes off: code', pe.code === 'HUB_PROCESSES_DISABLED')
check('processes off: variable', pe.variable === PROCESSES)
check('processes off: message names the switch', pe.message.includes(`${PROCESSES}=0`), pe.message)
check('processes off: one audit line', lines.length === 1)
const pl = lines[0] ?? {}
check('processes off: event hub.process.spawn', pl.event === 'hub.process.spawn')
check('processes off: outcome denied', pl.outcome === 'denied')
check(
  'processes off: actor/ip/route from context',
  pl.actor === 'user-1' && pl.ip === '203.0.113.7' && pl.route === 'trpc processes.spawn'
)
const pd = (pl.detail ?? {}) as Record<string, unknown>
check(
  'processes off: detail carries op, code, variable, caller detail',
  pd.op === 'spawn' &&
    pd.code === 'HUB_PROCESSES_DISABLED' &&
    pd.variable === PROCESSES &&
    pd.taskId === 't1',
  JSON.stringify(pd)
)

lines = []
const autoErr = caught(() => assertHubProcessesEnabled('automation.run_command', { op: 'save' }))
check('automation refusal: same error', isHubSwitchedOffError(autoErr))
check(
  'automation refusal: event automation.run_command',
  lines[0]?.event === 'automation.run_command'
)
// --- T-06: hub-local exec off with processes ---
lines = []
const execErr = runWithSecurityContext(
  { actor: 'user-2', ip: '203.0.113.8', route: 'trpc worktrees.getCurrentBranch' },
  () => caught(() => assertHubLocalExecEnabled({ op: 'git', detail: { command: 'git' } }))
)
check('local exec off: throws HubSwitchedOffError', execErr instanceof HubSwitchedOffError)
const xe = execErr as HubSwitchedOffError
check('local exec off: code NO_COMPUTER_CONNECTED', xe.code === 'NO_COMPUTER_CONNECTED')
check('local exec off: variable is the processes switch', xe.variable === PROCESSES)
check(
  'local exec off: message says connect a computer and names the switch',
  xe.message.startsWith('Connect a computer') && xe.message.includes(`${PROCESSES}=0`),
  xe.message
)
check('local exec off: recognized structurally', isHubSwitchedOffError(execErr))
check('local exec off: one audit line', lines.length === 1)
const xl = lines[0] ?? {}
check(
  'local exec off: event hub.local_exec, denied, from context',
  xl.event === 'hub.local_exec' &&
    xl.outcome === 'denied' &&
    xl.actor === 'user-2' &&
    xl.route === 'trpc worktrees.getCurrentBranch'
)
const xd = (xl.detail ?? {}) as Record<string, unknown>
check(
  'local exec off: detail carries op, code, caller detail',
  xd.op === 'git' && xd.code === 'NO_COMPUTER_CONNECTED' && xd.command === 'git',
  JSON.stringify(xd)
)

check(
  'processes off leaves integrations on',
  caught(() => assertHubIntegrationsEnabled({ op: 'connect' })) === null
)

// --- integrations off ---
delete process.env[PROCESSES]
process.env[INTEGRATIONS] = '0'
lines = []
const intErr = caught(() =>
  assertHubIntegrationsEnabled({ op: 'connect', detail: { provider: 'github' } })
)
check('integrations off: throws', intErr instanceof HubSwitchedOffError)
check(
  'integrations off: code',
  (intErr as HubSwitchedOffError).code === 'HUB_INTEGRATIONS_DISABLED'
)
check(
  'integrations off: message names the switch',
  (intErr as Error).message.includes(`${INTEGRATIONS}=0`)
)
check(
  'integrations off: event integration.connect',
  lines.length === 1 && lines[0]?.event === 'integration.connect'
)
check(
  'integrations off leaves processes on',
  caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' })) === null
)
check(
  'integrations off leaves local exec on',
  caught(() => assertHubLocalExecEnabled({ op: 'git' })) === null
)
delete process.env[INTEGRATIONS]

// --- malformed value fails closed (B4 already refuses it at boot) ---
process.env[PROCESSES] = 'false'
check(
  'malformed switch: throws (fail closed)',
  caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' })) !== null
)
delete process.env[PROCESSES]

// --- structural recognition across module copies ---
const foreign = Object.assign(new Error('x'), {
  name: 'HubSwitchedOffError',
  code: 'HUB_PROCESSES_DISABLED'
})
check('isHubSwitchedOffError: structural copy', isHubSwitchedOffError(foreign))
check(
  'isHubSwitchedOffError: unknown code',
  !isHubSwitchedOffError(
    Object.assign(new Error('x'), { name: 'HubSwitchedOffError', code: 'NOPE' })
  )
)
check('isHubSwitchedOffError: plain error', !isHubSwitchedOffError(new Error('x')))
check(
  'isHubSwitchedOffError: non-error',
  !isHubSwitchedOffError({ name: 'HubSwitchedOffError', code: 'HUB_PROCESSES_DISABLED' })
)

setSecurityLogSink()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
