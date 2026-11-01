import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import { toolActivityByRow } from './tool-activity'

const user = (id: string) => ({ kind: 'user-text', id, text: id, timestamp: 0 }) as TimelineItem
const reply = (id: string) =>
  ({ kind: 'text', role: 'assistant', messageId: id, text: id, timestamp: 0 }) as TimelineItem
const tool = (id: string, parentToolUseId?: string) =>
  ({
    kind: 'tool',
    invocation: { id, name: 'Read', status: 'done', input: {} },
    timestamp: 0,
    parentToolUseId
  }) as TimelineItem

describe('tool activity per turn', () => {
  it('retains independent history for every user turn; only latest can be active', () => {
    const a = user('a'),
      b = user('b'),
      x = tool('x'),
      y = tool('y'),
      ra = reply('ra'),
      rb = reply('rb')
    const groups = toolActivityByRow([a, x, ra, b, y, rb], [a, ra, b, rb])
    expect(groups.get(ra)?.tools.map((t) => t.item.invocation.id)).toEqual(['x'])
    expect(groups.get(rb)?.tools.map((t) => t.item.invocation.id)).toEqual(['y'])
    expect(groups.get(ra)?.latestTurn).toBe(false)
    expect(groups.get(rb)?.latestTurn).toBe(true)
  })
  it('excludes folded, nested, and already visible calls', () => {
    const a = user('a'),
      x = tool('x'),
      y = tool('y'),
      nested = tool('nested', 'x'),
      r = reply('r')
    const groups = toolActivityByRow([a, x, nested, y, r], [a, x, r], new Set([3]))
    expect(groups.size).toBe(0)
  })
  it('places tools beside file changes and does not merge across unloaded history', () => {
    const a = user('a'),
      x = tool('x'),
      r = reply('r')
    const files = {
      kind: 'files-changed',
      id: 'files',
      files: [],
      timestamp: 0
    } as unknown as TimelineItem
    const result = { kind: 'result', timestamp: 0 } as TimelineItem
    const groups = toolActivityByRow(
      [a, x, r, files, result, undefined, tool('unknown')],
      [a, r, files, result]
    )
    expect(groups.get(files)?.tools[0].item).toBe(x)
    expect(groups.get(files)?.latestTurn).toBe(false)
  })
})
