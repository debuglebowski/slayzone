/**
 * auto-start (agent startup mode) unit tests
 */
import { expect, test } from 'vitest'
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

// The agreed behaviour table (plans/agent-startup-mode.md), row by row.
const TABLE: Record<AgentStartupMode, Record<AgentState, boolean>> = {
  manual: { running: false, auto_stopped: false, stopped: false, new: false },
  auto: { running: true, auto_stopped: false, stopped: false, new: true },
  instant: { running: true, auto_stopped: true, stopped: true, new: true }
}

test('agentStartsOnOpen matches the behaviour table', () => {
  for (const mode of Object.keys(TABLE) as AgentStartupMode[]) {
    for (const state of Object.keys(TABLE[mode]) as AgentState[]) {
      expect(agentStartsOnOpen({ mode, state, isTemporary: false }), `${mode}/${state}:`).toBe(
        TABLE[mode][state]
      )
    }
  }
})

test('temporary tasks always start, in every mode and state', () => {
  for (const mode of Object.keys(TABLE) as AgentStartupMode[]) {
    for (const state of Object.keys(TABLE[mode]) as AgentState[]) {
      expect(agentStartsOnOpen({ mode, state, isTemporary: true }), `${mode}/${state}:`).toBe(true)
    }
  }
})

test('warm pool + boot restore run in auto and instant, not manual', () => {
  expect(warmPoolEnabled('manual')).toBe(false)
  expect(warmPoolEnabled('auto')).toBe(true)
  expect(warmPoolEnabled('instant')).toBe(true)
  expect(restoresRunningAgentsOnBoot('manual')).toBe(false)
  expect(restoresRunningAgentsOnBoot('auto')).toBe(true)
  expect(restoresRunningAgentsOnBoot('instant')).toBe(true)
})

test('parseAgentStartupMode defaults unknown/unset to auto', () => {
  expect(parseAgentStartupMode(null)).toBe('auto')
  expect(parseAgentStartupMode(undefined)).toBe('auto')
  expect(parseAgentStartupMode('1')).toBe('auto')
  expect(parseAgentStartupMode('manual')).toBe('manual')
  expect(parseAgentStartupMode('instant')).toBe('instant')
})

test('parseAgentState defaults unknown to stopped', () => {
  expect(parseAgentState(null)).toBe('stopped')
  expect(parseAgentState('bogus')).toBe('stopped')
  expect(parseAgentState('auto_stopped')).toBe('auto_stopped')
})

test('"Don\'t show again" steps one mode more automatic', () => {
  expect(nextAgentStartupMode('manual')).toBe('auto')
  expect(nextAgentStartupMode('auto')).toBe('instant')
})
