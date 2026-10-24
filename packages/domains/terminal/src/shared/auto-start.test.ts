/**
 * auto-start (agent startup mode) unit tests
 * Run with: pnpm tsx packages/domains/terminal/src/shared/auto-start.test.ts
 */
import {
  agentStartsOnOpen,
  nextAgentStartupMode,
  parseAgentStartupMode,
  parseAgentState,
  restoresRunningAgentsOnBoot,
  warmPoolEnabled,
  type AgentStartupMode,
  type AgentState
} from './auto-start.js'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e}`)
    failed++
  }
}
function expectEq<T>(actual: T, expected: T, label = '') {
  if (actual !== expected)
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// The agreed behaviour table (plans/agent-startup-mode.md), row by row.
const TABLE: Record<AgentStartupMode, Record<AgentState, boolean>> = {
  manual: { running: false, auto_stopped: false, stopped: false, new: false },
  auto: { running: true, auto_stopped: false, stopped: false, new: true },
  instant: { running: true, auto_stopped: true, stopped: true, new: true }
}

test('agentStartsOnOpen matches the behaviour table', () => {
  for (const mode of Object.keys(TABLE) as AgentStartupMode[]) {
    for (const state of Object.keys(TABLE[mode]) as AgentState[]) {
      expectEq(
        agentStartsOnOpen({ mode, state, isTemporary: false }),
        TABLE[mode][state],
        `${mode}/${state}:`
      )
    }
  }
})

test('temporary tasks always start, in every mode and state', () => {
  for (const mode of Object.keys(TABLE) as AgentStartupMode[]) {
    for (const state of Object.keys(TABLE[mode]) as AgentState[]) {
      expectEq(agentStartsOnOpen({ mode, state, isTemporary: true }), true, `${mode}/${state}:`)
    }
  }
})

test('warm pool + boot restore run in auto and instant, not manual', () => {
  expectEq(warmPoolEnabled('manual'), false)
  expectEq(warmPoolEnabled('auto'), true)
  expectEq(warmPoolEnabled('instant'), true)
  expectEq(restoresRunningAgentsOnBoot('manual'), false)
  expectEq(restoresRunningAgentsOnBoot('auto'), true)
  expectEq(restoresRunningAgentsOnBoot('instant'), true)
})

test('parseAgentStartupMode defaults unknown/unset to auto', () => {
  expectEq(parseAgentStartupMode(null), 'auto')
  expectEq(parseAgentStartupMode(undefined), 'auto')
  expectEq(parseAgentStartupMode('1'), 'auto')
  expectEq(parseAgentStartupMode('manual'), 'manual')
  expectEq(parseAgentStartupMode('instant'), 'instant')
})

test('parseAgentState defaults unknown to stopped', () => {
  expectEq(parseAgentState(null), 'stopped')
  expectEq(parseAgentState('bogus'), 'stopped')
  expectEq(parseAgentState('auto_stopped'), 'auto_stopped')
})

test('"Don\'t show again" steps one mode more automatic', () => {
  expectEq(nextAgentStartupMode('manual'), 'auto')
  expectEq(nextAgentStartupMode('auto'), 'instant')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
