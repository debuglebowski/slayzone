/**
 * Switch refusals (T-04, T-05, T-06, T-07): one audit line + one error shape per refusal,
 * nothing at all with the switches at their defaults.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-switch-refusal.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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

// The switches are read from process.env at call time and every refusal writes one audit
// line, so each phase below sets its env and makes its calls in a beforeAll (tests run in
// declaration order, after the previous phase's tests), and checks what that phase saw.
let lines: Array<Record<string, unknown>> = []
beforeAll(() => {
  delete process.env[PROCESSES]
  delete process.env[INTEGRATIONS]
  setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
})
afterAll(() => {
  setSecurityLogSink()
  delete process.env[PROCESSES]
  delete process.env[INTEGRATIONS]
})

// --- defaults: both on, nothing refused, nothing logged ---
describe('defaults: both on, nothing refused, nothing logged', () => {
  test('default: processes enabled', () => {
    expect(hubProcessesEnabled()).toBe(true)
  })

  test('default: integrations enabled', () => {
    expect(hubIntegrationsEnabled()).toBe(true)
  })

  test('default: process assert passes', () => {
    expect(caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' }))).toBeNull()
  })

  test('default: integration assert passes', () => {
    expect(caught(() => assertHubIntegrationsEnabled({ op: 'connect' }))).toBeNull()
  })

  test('default: local exec assert passes', () => {
    expect(caught(() => assertHubLocalExecEnabled({ op: 'git' }))).toBeNull()
  })

  test('default: no audit line', () => {
    expect(lines.length).toBe(0)
  })

  test('explicit 1 = enabled', () => {
    expect(hubProcessesEnabled({ [PROCESSES]: '1' })).toBe(true)
  })
})

// --- processes off ---
describe('processes off', () => {
  let procErr: unknown
  let pe: HubSwitchedOffError
  let pl: Record<string, unknown> = {}
  let pd: Record<string, unknown> = {}
  beforeAll(() => {
    process.env[PROCESSES] = '0'
    lines = []
    procErr = runWithSecurityContext(
      { actor: 'user-1', ip: '203.0.113.7', route: 'trpc processes.spawn' },
      () =>
        caught(() =>
          assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn', detail: { taskId: 't1' } })
        )
    )
    pe = procErr as HubSwitchedOffError
    pl = lines[0] ?? {}
    pd = (pl.detail ?? {}) as Record<string, unknown>
  })

  test('processes off: throws HubSwitchedOffError', () => {
    expect(procErr).toBeInstanceOf(HubSwitchedOffError)
  })

  test('processes off: code', () => {
    expect(pe.code).toBe('HUB_PROCESSES_DISABLED')
  })

  test('processes off: variable', () => {
    expect(pe.variable).toBe(PROCESSES)
  })

  test('processes off: message names the switch', () => {
    expect(pe.message, pe.message).toContain(`${PROCESSES}=0`)
  })

  test('processes off: one audit line', () => {
    expect(lines.length).toBe(1)
  })

  test('processes off: event hub.process.spawn', () => {
    expect(pl.event).toBe('hub.process.spawn')
  })

  test('processes off: outcome denied', () => {
    expect(pl.outcome).toBe('denied')
  })

  test('processes off: actor/ip/route from context', () => {
    expect(pl.actor).toBe('user-1')
    expect(pl.ip).toBe('203.0.113.7')
    expect(pl.route).toBe('trpc processes.spawn')
  })

  test('processes off: detail carries op, code, variable, caller detail', () => {
    expect(pd.op, JSON.stringify(pd)).toBe('spawn')
    expect(pd.code, JSON.stringify(pd)).toBe('HUB_PROCESSES_DISABLED')
    expect(pd.variable, JSON.stringify(pd)).toBe(PROCESSES)
    expect(pd.taskId, JSON.stringify(pd)).toBe('t1')
  })

  describe('automation refusal', () => {
    let autoErr: unknown
    beforeAll(() => {
      lines = []
      autoErr = caught(() => assertHubProcessesEnabled('automation.run_command', { op: 'save' }))
    })

    test('automation refusal: same error', () => {
      expect(isHubSwitchedOffError(autoErr)).toBe(true)
    })

    test('automation refusal: event automation.run_command', () => {
      expect(lines[0]?.event === 'automation.run_command').toBe(true)
    })
  })

  // --- T-06: hub-local exec off with processes ---
  describe('T-06: hub-local exec off with processes', () => {
    let execErr: unknown
    let xe: HubSwitchedOffError
    let xl: Record<string, unknown> = {}
    let xd: Record<string, unknown> = {}
    beforeAll(() => {
      lines = []
      execErr = runWithSecurityContext(
        { actor: 'user-2', ip: '203.0.113.8', route: 'trpc worktrees.getCurrentBranch' },
        () => caught(() => assertHubLocalExecEnabled({ op: 'git', detail: { command: 'git' } }))
      )
      xe = execErr as HubSwitchedOffError
      xl = lines[0] ?? {}
      xd = (xl.detail ?? {}) as Record<string, unknown>
    })

    test('local exec off: throws HubSwitchedOffError', () => {
      expect(execErr).toBeInstanceOf(HubSwitchedOffError)
    })

    test('local exec off: code NO_COMPUTER_CONNECTED', () => {
      expect(xe.code).toBe('NO_COMPUTER_CONNECTED')
    })

    test('local exec off: variable is the processes switch', () => {
      expect(xe.variable).toBe(PROCESSES)
    })

    test('local exec off: message says connect a computer and names the switch', () => {
      expect(xe.message.startsWith('Connect a computer'), xe.message).toBe(true)
      expect(xe.message, xe.message).toContain(`${PROCESSES}=0`)
    })

    test('local exec off: recognized structurally', () => {
      expect(isHubSwitchedOffError(execErr)).toBe(true)
    })

    test('local exec off: one audit line', () => {
      expect(lines.length).toBe(1)
    })

    test('local exec off: event hub.local_exec, denied, from context', () => {
      expect(xl.event).toBe('hub.local_exec')
      expect(xl.outcome).toBe('denied')
      expect(xl.actor).toBe('user-2')
      expect(xl.route).toBe('trpc worktrees.getCurrentBranch')
    })

    test('local exec off: detail carries op, code, caller detail', () => {
      expect(xd.op, JSON.stringify(xd)).toBe('git')
      expect(xd.code, JSON.stringify(xd)).toBe('NO_COMPUTER_CONNECTED')
      expect(xd.command, JSON.stringify(xd)).toBe('git')
    })

    test('processes off leaves integrations on', () => {
      expect(caught(() => assertHubIntegrationsEnabled({ op: 'connect' }))).toBeNull()
    })
  })
})

// --- integrations off ---
describe('integrations off', () => {
  let intErr: unknown
  let linesAfter: Array<Record<string, unknown>> = []
  beforeAll(() => {
    delete process.env[PROCESSES]
    process.env[INTEGRATIONS] = '0'
    lines = []
    intErr = caught(() =>
      assertHubIntegrationsEnabled({ op: 'connect', detail: { provider: 'github' } })
    )
    linesAfter = [...lines]
  })
  afterAll(() => {
    delete process.env[INTEGRATIONS]
  })

  test('integrations off: throws', () => {
    expect(intErr).toBeInstanceOf(HubSwitchedOffError)
  })

  test('integrations off: code', () => {
    expect((intErr as HubSwitchedOffError).code).toBe('HUB_INTEGRATIONS_DISABLED')
  })

  test('integrations off: message names the switch', () => {
    expect((intErr as Error).message).toContain(`${INTEGRATIONS}=0`)
  })

  test('integrations off: event integration.connect', () => {
    expect(linesAfter.length === 1 && linesAfter[0]?.event === 'integration.connect').toBe(true)
  })

  test('integrations off leaves processes on', () => {
    expect(caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' }))).toBeNull()
  })

  test('integrations off leaves local exec on', () => {
    expect(caught(() => assertHubLocalExecEnabled({ op: 'git' }))).toBeNull()
  })
})

// --- malformed value fails closed (B4 already refuses it at boot) ---
describe('malformed value fails closed', () => {
  beforeAll(() => {
    process.env[PROCESSES] = 'false'
  })
  afterAll(() => {
    delete process.env[PROCESSES]
  })

  test('malformed switch: throws (fail closed)', () => {
    expect(caught(() => assertHubProcessesEnabled('hub.process.spawn', { op: 'spawn' }))).not.toBeNull()
  })
})

// --- structural recognition across module copies ---
describe('structural recognition across module copies', () => {
  const foreign = Object.assign(new Error('x'), {
    name: 'HubSwitchedOffError',
    code: 'HUB_PROCESSES_DISABLED'
  })

  test('isHubSwitchedOffError: structural copy', () => {
    expect(isHubSwitchedOffError(foreign)).toBe(true)
  })

  test('isHubSwitchedOffError: unknown code', () => {
    expect(isHubSwitchedOffError(
      Object.assign(new Error('x'), { name: 'HubSwitchedOffError', code: 'NOPE' })
    )).toBeFalsy()
  })

  test('isHubSwitchedOffError: plain error', () => {
    expect(isHubSwitchedOffError(new Error('x'))).toBeFalsy()
  })

  test('isHubSwitchedOffError: non-error', () => {
    expect(isHubSwitchedOffError({ name: 'HubSwitchedOffError', code: 'HUB_PROCESSES_DISABLED' })).toBeFalsy()
  })
})

