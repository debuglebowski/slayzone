/**
 * Agent-start tracker: which agents are still starting, and whether each one is
 * still waiting for a start slot (`queued`) or already launched (`booting`).
 * The sidebar's startup card reads this through `pty.onAgentStarts`.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/domains/terminal/src/server/runtime/agent-starts.test.ts
 */
import { expect, test } from 'vitest'
import { createAgentStartTracker, type AgentStartEntry } from './agent-starts'

/** A tracker whose notifications run only when the test flushes them. */
function manualTracker() {
  const pending: Array<() => void> = []
  const tracker = createAgentStartTracker({ schedule: (fn) => pending.push(fn) })
  const flush = (): void => {
    for (const fn of pending.splice(0)) fn()
  }
  return { tracker, flush }
}

test('mark / advance / clear: the snapshot follows each agent', () => {
  const { tracker } = manualTracker()
  tracker.mark('a', 'queued')
  tracker.mark('b', 'booting')
  expect(tracker.snapshot()).toEqual([
    { sessionId: 'a', phase: 'queued' },
    { sessionId: 'b', phase: 'booting' }
  ])

  tracker.markBooting('a')
  expect(tracker.snapshot().find((e) => e.sessionId === 'a')?.phase).toBe('booting')

  tracker.clear('a')
  tracker.clear('b')
  tracker.clear('never-marked')
  expect(tracker.snapshot()).toEqual([])
})

test('markBooting never resurrects an agent that already finished starting', () => {
  // A late spawn confirmation for a session that already printed (or exited).
  const { tracker } = manualTracker()
  tracker.mark('a', 'queued')
  tracker.clear('a')
  tracker.markBooting('a')
  expect(tracker.snapshot()).toEqual([])
})

test('listeners get one coalesced snapshot per burst, and none for no-ops', () => {
  const { tracker, flush } = manualTracker()
  const seen: AgentStartEntry[][] = []
  const off = tracker.subscribe((entries) => seen.push(entries))

  tracker.mark('a', 'queued')
  tracker.mark('b', 'queued')
  tracker.markBooting('a')
  flush()
  expect(seen).toEqual([
    [
      { sessionId: 'a', phase: 'booting' },
      { sessionId: 'b', phase: 'queued' }
    ]
  ])

  // Nothing changed: no notification.
  tracker.mark('b', 'queued')
  tracker.clear('missing')
  tracker.markBooting('missing')
  flush()
  expect(seen.length).toBe(1)

  off()
  tracker.clear('a')
  flush()
  expect(seen.length).toBe(1)
})
