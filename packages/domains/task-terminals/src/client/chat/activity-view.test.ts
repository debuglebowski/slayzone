import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import { activityView } from './activity-view'

const reply = {
  kind: 'text',
  role: 'assistant',
  messageId: 'reply',
  text: 'Done',
  timestamp: 0
} as TimelineItem
const result = { kind: 'result', isError: false, timestamp: 1 } as TimelineItem
const diagnostic = {
  kind: 'stderr',
  text: 'failed to refresh available models: request timed out',
  timestamp: 2
} as TimelineItem

describe('activity view late diagnostics', () => {
  const importedUser = {
    kind: 'user-text',
    id: 'imported',
    text: 'Earlier question',
    delivery: 'answered',
    timestamp: 0
  } as TimelineItem

  it('keeps imported answers visible without a live result event', () => {
    const view = activityView([importedUser, reply], false)
    expect(view.rows).toEqual([importedUser, reply])
    expect(view.turns.get(reply)?.final).toBe(reply)
  })

  it.each(['history-gap', 'interrupted'] as const)(
    'does not promote imported progress across %s',
    (kind) => {
      const boundary = { kind, timestamp: 1 } as TimelineItem
      const view = activityView([importedUser, reply, boundary], false)
      expect([...view.turns.values()].every((turn) => turn.final === null)).toBe(true)
    }
  )

  it('keeps diagnostics after completion under the answer without another avatar', () => {
    const view = activityView([reply, result, diagnostic], false)
    expect(view.rows).toEqual([reply])
    expect(view.turns.size).toBe(1)
    expect(view.turns.get(reply)).toMatchObject({
      final: reply,
      items: [diagnostic],
      active: false
    })
    expect(view.hosts.get(diagnostic)).toBe(reply)
  })

  it('keeps completed turns inactive while another turn starts', () => {
    const next = {
      kind: 'text',
      role: 'assistant',
      messageId: 'next',
      text: 'Working',
      timestamp: 3
    } as TimelineItem
    const view = activityView([reply, result, diagnostic, next], true)
    expect(view.turns.size).toBe(2)
    expect(view.turns.get(reply)).toMatchObject({
      items: [diagnostic],
      active: false
    })
    expect(view.turns.get(next)).toMatchObject({ items: [next], active: true })
    expect(activityView([reply, result, diagnostic], true).turns.get(reply)?.active).toBe(false)
  })

  it.each(['user-text', 'history-gap', 'conversation-branch'] as const)(
    'does not attach diagnostics across %s boundaries',
    (kind) => {
      const boundary = {
        kind,
        id: 'boundary',
        text: 'Next',
        timestamp: 2
      } as TimelineItem
      const view = activityView([reply, result, boundary, diagnostic], false)
      expect(view.turns.get(reply)?.items).toEqual([])
      expect(view.hosts.get(diagnostic)).not.toBe(reply)
    }
  )

  it('keeps interruption diagnostics in the interrupted turn', () => {
    const interrupted = { kind: 'interrupted', timestamp: 1 } as TimelineItem
    const view = activityView([reply, interrupted, diagnostic], false)
    expect(view.turns.size).toBe(1)
    expect(view.turns.get(interrupted)).toMatchObject({
      final: null,
      items: [reply, diagnostic],
      active: false
    })
  })

  it('keeps the source message on interruptions with no assistant output', () => {
    const user = { kind: 'user-text', id: 'question', text: 'Go', timestamp: 0 } as TimelineItem
    const interrupted = { kind: 'interrupted', timestamp: 1 } as TimelineItem
    const view = activityView([user, interrupted], false)
    expect(view.turns.get(interrupted)).toMatchObject({
      userMessageId: 'question',
      final: null,
      active: false
    })
  })
})
