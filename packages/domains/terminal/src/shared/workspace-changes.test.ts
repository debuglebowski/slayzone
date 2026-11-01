import { expect, it } from 'vitest'
import { initialState, reducer } from './chat-timeline'
import { encodeTimelineState, decodeTimelineState } from './chat-timeline-checkpoint'

it('upserts a host workspace observation without changing native edit counts, including replay', () => {
  let state = initialState()
  state = reducer(state, {
    type: 'event',
    event: {
      kind: 'workspace-changes',
      tabId: 'tab',
      captureId: 'capture',
      messageId: 'm',
      status: 'pending',
      fileCount: 0
    }
  })
  state = decodeTimelineState(encodeTimelineState(state, 0))
  state = reducer(state, {
    type: 'event',
    event: {
      kind: 'workspace-changes',
      tabId: 'tab',
      captureId: 'capture',
      messageId: 'm',
      status: 'complete',
      fileCount: 4
    }
  })
  const rows = state.timeline.filter((row) => row?.kind === 'workspace-changes')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ captureId: 'capture', status: 'complete', fileCount: 4 })
  expect(state.timeline.some((row) => row?.kind === 'files-changed')).toBe(false)
})

it('does not load historical pages for a new capture, but loads the exact row for an update', () => {
  let state = reducer(initialState(), {
    type: 'event',
    event: {
      kind: 'workspace-changes',
      tabId: 'tab',
      captureId: 'old',
      messageId: 'm',
      status: 'pending',
      fileCount: 0
    }
  })
  state = decodeTimelineState(encodeTimelineState(state, 1))
  state = reducer(state, {
    type: 'event',
    event: {
      kind: 'workspace-changes',
      tabId: 'tab',
      captureId: 'new',
      messageId: 'm2',
      status: 'pending',
      fileCount: 0
    }
  })
  expect(state.stalled).toBeNull()
  expect(state.timeline).toHaveLength(2)
  state = reducer(state, {
    type: 'event',
    event: {
      kind: 'workspace-changes',
      tabId: 'tab',
      captureId: 'old',
      messageId: 'm',
      status: 'complete',
      fileCount: 1
    }
  })
  expect(state.stalled?.need).toBe(0)
})
