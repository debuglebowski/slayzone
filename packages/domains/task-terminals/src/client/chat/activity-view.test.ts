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

describe('activity view: sub-agents', () => {
  const user = { kind: 'user-text', id: 'u1', text: 'Spawn two', timestamp: 0 } as TimelineItem
  const agent = (toolUseId: string, phase: 'in-flight' | 'completed' | 'failed') =>
    ({ kind: 'sub-agent', toolUseId, phase, backgrounded: true, timestamp: 0 }) as TimelineItem

  it("the turn's sub-agents, running or ended, are their own list — never Activities", () => {
    const running = agent('a1', 'in-flight')
    const done = agent('a2', 'completed')
    const view = activityView([user, running, done, reply, result], false)
    expect(view.rows).toEqual([user, reply])
    expect(view.turns.get(reply)).toMatchObject({
      final: reply,
      items: [],
      subAgents: [running, done]
    })
    expect(view.hosts.get(done)).toBe(reply)
  })

  it('a sub-agent is never the reply', () => {
    const done = agent('a1', 'failed')
    const view = activityView([user, reply, done, result], false)
    expect(view.turns.get(reply)).toMatchObject({ final: reply, items: [], subAgents: [done] })
  })

  it('a turn with only sub-agents still has a turn for them', () => {
    const running = agent('a1', 'in-flight')
    const view = activityView([user, running], true)
    expect([...view.turns.values()][0]).toMatchObject({ subAgents: [running], active: true })
  })
})

describe('activity view: empty blocks', () => {
  const user = { kind: 'user-text', id: 'u1', text: 'Go', timestamp: 0 } as TimelineItem
  // Claude's hidden (redacted / signature-only) thinking: a block with no text.
  const emptyThinking = {
    kind: 'thinking',
    messageId: 'm0',
    text: '',
    timestamp: 0
  } as TimelineItem

  it('a block with no text is no activity (nothing to show) and no row', () => {
    const view = activityView([user, emptyThinking, reply, result], false)
    expect(view.rows).toEqual([user, reply])
    expect(view.turns.get(reply)?.items).toEqual([])
  })

  it('one still streaming counts (its text is on its way)', () => {
    const streaming = { ...emptyThinking, stream: 'open' } as TimelineItem
    const view = activityView([user, streaming], true)
    expect([...view.turns.values()][0]?.items).toEqual([streaming])
  })
})

describe('activity view: turn trigger', () => {
  const trigger = {
    kind: 'turn-trigger',
    subAgents: [],
    notifications: [{ uuid: 'n1', taskId: 't1', summary: 'Monitor event: "x"' }],
    timestamp: 0
  } as TimelineItem

  it('belongs to the turn it opened: no row of its own, carried as the turn header', () => {
    const view = activityView([trigger, reply, result], false)
    expect(view.rows).toEqual([reply])
    expect(view.turns.get(reply)?.trigger).toBe(trigger)
    expect(view.hosts.get(trigger)).toBe(reply)
  })

  it('heads a still-running turn too', () => {
    const tool = {
      kind: 'tool',
      invocation: { id: 'tu1', name: 'Bash', status: 'pending' },
      timestamp: 1
    } as TimelineItem
    const view = activityView([trigger, tool], true)
    const [turn] = [...view.turns.values()]
    expect(turn.trigger).toBe(trigger)
    expect(view.rows).not.toContain(trigger)
  })
})

describe('activity view: a message sent into the running turn', () => {
  const user = { kind: 'user-text', id: 'u1', text: 'run the build', timestamp: 0 } as TimelineItem
  const tool = {
    kind: 'tool',
    invocation: { id: 't1', name: 'Bash', status: 'done', input: {} },
    timestamp: 1
  } as TimelineItem
  const joined = {
    kind: 'user-text',
    id: 's1',
    text: 'also run lint',
    joinsTurn: true,
    timestamp: 2
  } as TimelineItem
  const after = {
    kind: 'tool',
    invocation: { id: 't2', name: 'Bash', status: 'pending', input: {} },
    timestamp: 3
  } as TimelineItem

  it('marks the part before it as continued after that message', () => {
    const view = activityView([user, tool, joined, after], true)
    expect(view.turns.get(user)).toMatchObject({ continuedBy: joined, active: false })
    expect(view.turns.get(joined)).toMatchObject({ active: true })
    expect(view.turns.get(joined)?.continuedBy).toBeUndefined()
  })

  it('an ordinary next message ends the turn without the mark', () => {
    const next = { ...joined, joinsTurn: undefined } as TimelineItem
    const view = activityView([user, tool, next, after], true)
    expect(view.turns.get(user)?.continuedBy).toBeUndefined()
  })
})

describe('activity view: late workspace capture of an agent-started turn', () => {
  const trigger = {
    kind: 'turn-trigger',
    subAgents: [],
    notifications: [{ uuid: 'n1', taskId: 't1', summary: 'Monitor event: "x"' }],
    timestamp: 0
  } as TimelineItem
  // Agent-started turns have no user message to attach the capture to; it lands after the result.
  const capture = {
    kind: 'workspace-changes',
    id: 'workspace:c1',
    tabId: 'tab',
    captureId: 'c1',
    messageId: 'agent-turn:a1',
    status: 'unavailable',
    fileCount: 0,
    reason: 'Agent started this turn without a workspace baseline.',
    timestamp: 2
  } as TimelineItem
  const nextReply = { ...reply, messageId: 'next', text: 'Next' } as TimelineItem

  it('stays with the turn that just ended: no empty turn block of its own', () => {
    const view = activityView([trigger, reply, result, capture], false)
    expect(view.rows).toEqual([reply])
    expect(view.turns.size).toBe(1)
    expect(view.turns.get(reply)?.files).toEqual([capture])
    expect(view.hosts.get(capture)).toBe(reply)
  })

  it('is never handed to the next agent-started turn', () => {
    const view = activityView([trigger, reply, result, capture, trigger, nextReply, result], false)
    expect(view.rows).toEqual([reply, nextReply])
    expect(view.turns.get(reply)?.files).toEqual([capture])
    expect(view.turns.get(nextReply)?.files).toEqual([])
  })
})
