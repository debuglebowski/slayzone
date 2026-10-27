/**
 * Pre-init leg of the terminal mount trace (open-trace.ts): open requested →
 * Terminal mounted → init started.
 */
import { expect, test } from 'vitest'
import {
  __resetOpenTraceForTest,
  noteTerminalMounted,
  takeOpenTrace,
  traceSessionOpen
} from './open-trace'

test('open → mount → init yields both legs, then is consumed', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 100)
  noteTerminalMounted('s', 700)
  const t = takeOpenTrace('s', 760)
  expect(t?.openToMountMs, `legs ${JSON.stringify(t)}`).toBe(600)
  expect(t?.mountToInitMs, `legs ${JSON.stringify(t)}`).toBe(60)
  expect(takeOpenTrace('s', 800), 'one-shot').toBe(null)
})

test('mount without a traced open records nothing', () => {
  __resetOpenTraceForTest()
  noteTerminalMounted('s', 700)
  expect(takeOpenTrace('s', 760), 'untraced').toBe(null)
})

test('init before a mount note: mount leg null, open leg covers all', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 100)
  const t = takeOpenTrace('s', 500)
  expect(t?.openToMountMs, `legs ${JSON.stringify(t)}`).toBe(null)
  expect(t?.openToInitMs, `legs ${JSON.stringify(t)}`).toBe(400)
})

test('remount keeps the FIRST mount time', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 0)
  noteTerminalMounted('s', 200)
  noteTerminalMounted('s', 900)
  expect(takeOpenTrace('s', 950)?.openToMountMs, 'first mount wins').toBe(200)
})

test('stale open trace is dropped', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 0)
  expect(takeOpenTrace('s', 60_001), 'expired').toBe(null)
})
