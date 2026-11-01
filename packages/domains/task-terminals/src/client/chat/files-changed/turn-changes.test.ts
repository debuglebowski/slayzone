import { expect, it } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import { turnChangeSources, unifiedChangeRows } from './turn-changes'
import { activityView } from '../activity-view'

const user = (id: string) => ({ kind: 'user-text', id, text: id, timestamp: 0 }) as TimelineItem
const reply = {
  kind: 'text',
  role: 'assistant',
  messageId: 'answer',
  text: 'Done',
  timestamp: 1
} as TimelineItem
const result = { kind: 'result', isError: false, timestamp: 2 } as TimelineItem
const recorded = {
  kind: 'files-changed',
  id: 'files:t',
  files: [],
  shellCommands: 1,
  timestamp: 2
} as TimelineItem
const capture = (messageId = 'u') =>
  ({
    kind: 'workspace-changes',
    id: 'workspace:c',
    tabId: 'tab',
    captureId: 'c',
    messageId,
    status: 'complete',
    fileCount: 5,
    timestamp: 3
  }) as Extract<TimelineItem, { kind: 'workspace-changes' }>

it('replaces tool count with workspace count, retaining fallback for late captures', () => {
  const workspace = capture()
  const rows = [user('u'), reply, recorded, result, user('next'), workspace]
  expect(unifiedChangeRows(rows)).not.toContain(recorded)
  expect(turnChangeSources(rows).get(workspace)).toBe(recorded)
  const view = activityView(rows, false)
  expect(view.rows).not.toContain(workspace)
  expect(view.turns.get(reply)?.files).toEqual([workspace])
  expect(view.hosts.get(workspace)).toBe(reply)
})

it('retains tool-only history and never associates across unloaded gaps', () => {
  const workspace = capture()
  const gap = { kind: 'history-gap', from: 2, to: 5, rows: 3, timestamp: 2 } as TimelineItem
  const rows = [user('u'), recorded, gap, workspace]
  expect(unifiedChangeRows(rows)).toContain(recorded)
  expect(turnChangeSources(rows).get(workspace)).toBeUndefined()
})

it('matches recorded summaries emitted after interruption markers', () => {
  const workspace = capture()
  const interrupted = { kind: 'interrupted', timestamp: 1 } as TimelineItem
  const rows = [user('u'), reply, interrupted, recorded, result, workspace]
  expect(turnChangeSources(rows).get(workspace)).toBe(recorded)
  expect(unifiedChangeRows(rows)).not.toContain(recorded)
})

it('keeps queued user messages from stealing the active turn summary', () => {
  const workspace = capture()
  const rows = [user('u'), user('queued'), reply, recorded, result, workspace]
  expect(turnChangeSources(rows).get(workspace)).toBe(recorded)
  expect(unifiedChangeRows(rows)).not.toContain(recorded)
})
