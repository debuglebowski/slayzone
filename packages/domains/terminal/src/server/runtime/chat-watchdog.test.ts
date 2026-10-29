/**
 * Tool-aware watchdog policy: a turn that is silent because a tool is running is
 * not stuck — its bound is that tool's own timeout, not the silence window.
 */
import { expect, test } from 'vitest'
import { runningDeadline, toolBoundMs, TOOL_GRACE_MS } from './chat-watchdog'

const MIN = 60_000

test('Bash: its own timeout (default 2 min), capped at the CLI maximum of 10 min', () => {
  expect(toolBoundMs('Bash', { command: 'npm test' }, {})).toBe(2 * MIN)
  expect(toolBoundMs('Bash', { command: 'x', timeout: 480_000 }, {})).toBe(8 * MIN)
  expect(toolBoundMs('Bash', { command: 'x', timeout: 9_999_999 }, {})).toBe(10 * MIN)
  expect(toolBoundMs('Bash', { command: 'x', run_in_background: true }, {})).toBe(0)
})

test('MCP tools: MCP_TOOL_TIMEOUT when set, else 30 min', () => {
  expect(toolBoundMs('mcp__srv__echo', {}, {})).toBe(30 * MIN)
  expect(toolBoundMs('mcp__srv__echo', {}, { MCP_TOOL_TIMEOUT: '90000' })).toBe(90_000)
})

test('other tools: 10 min', () => {
  expect(toolBoundMs('WebFetch', {}, {})).toBe(10 * MIN)
  expect(toolBoundMs('Task', {}, {})).toBe(10 * MIN)
})

test('no open tool: the silence window from the last progress', () => {
  expect(runningDeadline({ lastProgressAt: 1000, stallMs: 300_000, openTools: [] })).toBe(301_000)
})

test('an open tool extends the deadline to its own bound (+ grace), never shortens it', () => {
  const tenMinuteBash = { startedAt: 0, boundMs: 10 * MIN }
  expect(runningDeadline({ lastProgressAt: 0, stallMs: 1500, openTools: [tenMinuteBash] })).toBe(
    10 * MIN + TOOL_GRACE_MS
  )
  const shortTool = { startedAt: 0, boundMs: 100 }
  expect(runningDeadline({ lastProgressAt: 0, stallMs: 300_000, openTools: [shortTool] })).toBe(
    300_000
  )
})

test('the longest open tool wins', () => {
  expect(
    runningDeadline({
      lastProgressAt: 0,
      stallMs: 1000,
      openTools: [
        { startedAt: 0, boundMs: 2 * MIN },
        { startedAt: 5_000, boundMs: 10 * MIN }
      ]
    })
  ).toBe(5_000 + 10 * MIN + TOOL_GRACE_MS)
})
