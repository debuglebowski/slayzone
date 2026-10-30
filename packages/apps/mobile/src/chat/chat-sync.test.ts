import type { AgentEvent } from '@slayzone/terminal-contracts'
import { type Action, initialState, reducer } from '@slayzone/terminal/reducer'
import { ChatSync, type ChatReplay, type ChatSyncSink } from './chat-sync'

const TAB = 'tab-1'

const text = (messageId: string, t: string): AgentEvent => ({
  kind: 'assistant-text',
  messageId,
  text: t
})
const userMessage = (id: string, t: string): AgentEvent => ({ kind: 'user-message', id, text: t })
const delta = (t: string): AgentEvent => ({
  kind: 'stream-block-delta',
  blockIndex: 0,
  deltaType: 'text',
  text: t
})

/** A sink that runs the real reducer, with a frame the test fires by hand. */
function harness() {
  const actions: Action[] = []
  let state = initialState()
  let frames = 0
  const sink: ChatSyncSink = {
    dispatch: (action) => {
      actions.push(action)
      state = reducer(state, action)
    },
    requestFrame: () => {
      frames++
    },
    cancelFrame: () => undefined
  }
  const sync = new ChatSync(TAB, sink)
  return {
    sync,
    actions,
    state: () => state,
    frames: () => frames,
    texts: () =>
      state.timeline.flatMap((it) =>
        it?.kind === 'text' || it?.kind === 'user-text' ? [it.text] : []
      )
  }
}

const replay = (
  events: Array<[number, AgentEvent]>,
  live: Partial<ChatReplay['live']> = {}
): ChatReplay => ({
  events: events.map(([seq, event]) => ({ seq, event })),
  live: {
    afterSeq: events.length > 0 ? events[events.length - 1][0] : -1,
    liveSeq: 0,
    events: [],
    ...live
  }
})

describe('ChatSync', () => {
  it('queues events while loading, replays the history, then drains the queue without duplicates', () => {
    const h = harness()
    const ticket = h.sync.beginLoad('full')
    expect(ticket.afterSeq).toBe(-1)
    // Raced ahead of the replay: one it covers (seq 1), one it does not (seq 2).
    expect(h.sync.receive({ tabId: TAB, seq: 1, event: text('m1', 'one') })).toBe('queued')
    expect(h.sync.receive({ tabId: TAB, seq: 2, event: text('m2', 'two') })).toBe('queued')
    expect(h.state().timeline).toHaveLength(0)

    const result = h.sync.completeLoad(
      ticket,
      replay([
        [0, userMessage('u1', 'hi')],
        [1, text('m1', 'one')]
      ])
    )
    expect(result).toBe('done')
    expect(h.texts()).toEqual(['hi', 'one', 'two'])
    expect(h.sync.lastSeq).toBe(2)
    expect(h.sync.loading).toBe(false)
  })

  it("ignores other tabs' events", () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([]))
    expect(h.sync.receive({ tabId: 'other', seq: 0, event: text('m', 'x') })).toBe('ignored')
    expect(h.state().timeline).toHaveLength(0)
  })

  it('batches live fragments per frame and applies only those that follow the newest saved event', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, userMessage('u1', 'hi')]]))
    const start: AgentEvent = { kind: 'stream-message-start', messageId: 'm1' }
    const block: AgentEvent = { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
    h.sync.receive({ tabId: TAB, seq: 0, live: 1, event: start })
    h.sync.receive({ tabId: TAB, seq: 0, live: 2, event: block })
    h.sync.receive({ tabId: TAB, seq: 0, live: 3, event: delta('Hel') })
    // Stale: an older live counter, and one that follows an older saved event.
    expect(h.sync.receive({ tabId: TAB, seq: 0, live: 2, event: delta('X') })).toBe('ignored')
    expect(h.sync.receive({ tabId: TAB, seq: -1, live: 9, event: delta('Y') })).toBe('ignored')
    expect(h.frames()).toBe(1)
    expect(h.state().live).toHaveLength(0)

    h.sync.flush()
    expect(h.actions.filter((a) => a.type === 'events')).toHaveLength(1)
    expect(h.state().live[0]?.text).toBe('Hel')
  })

  it('applies fragments still waiting for their frame before a saved event', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, userMessage('u1', 'hi')]]))
    h.sync.receive({
      tabId: TAB,
      seq: 0,
      live: 1,
      event: { kind: 'stream-message-start', messageId: 'm1' }
    })
    h.sync.receive({
      tabId: TAB,
      seq: 0,
      live: 2,
      event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
    })
    h.sync.receive({ tabId: TAB, seq: 0, live: 3, event: delta('Hello') })
    h.sync.receive({ tabId: TAB, seq: 1, event: text('m1', 'Hello there') })
    const kinds = h.actions.map((a) => a.type)
    expect(kinds.slice(-2)).toEqual(['events', 'event'])
    expect(h.texts()).toEqual(['hi', 'Hello there'])
  })

  it('drops a load that a newer one replaced', () => {
    const h = harness()
    const first = h.sync.beginLoad('full')
    const second = h.sync.beginLoad('full')
    expect(h.sync.completeLoad(first, replay([[0, text('m', 'stale')]]))).toBe('stale')
    expect(h.state().timeline).toHaveLength(0)
    expect(h.sync.completeLoad(second, replay([[0, text('m', 'fresh')]]))).toBe('done')
    expect(h.texts()).toEqual(['fresh'])
  })

  it('a reload replaces the timeline (reset right before the replay), the first load never resets', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, text('m', 'a')]]))
    expect(h.actions.some((a) => a.type === 'reset')).toBe(false)
    const ticket = h.sync.beginLoad('full')
    // Nothing is cleared until the new history is there (no blank flash).
    expect(h.texts()).toEqual(['a'])
    h.sync.completeLoad(ticket, replay([[0, text('m', 'a')]]))
    expect(h.texts()).toEqual(['a'])
    expect(h.actions.filter((a) => a.type === 'reset')).toHaveLength(1)
  })

  it('adopts the live snapshot of a reply that is streaming right now', () => {
    const h = harness()
    const ticket = h.sync.beginLoad('full')
    h.sync.completeLoad(
      ticket,
      replay([[0, userMessage('u1', 'hi')]], {
        afterSeq: 0,
        liveSeq: 5,
        events: [
          { kind: 'stream-message-start', messageId: 'm1' },
          { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
          delta('partial')
        ]
      })
    )
    expect(h.state().live[0]?.text).toBe('partial')
    // A fragment the snapshot already holds is stale; the next one applies.
    expect(h.sync.receive({ tabId: TAB, seq: 0, live: 5, event: delta('dup') })).toBe('ignored')
    h.sync.receive({ tabId: TAB, seq: 0, live: 6, event: delta(' more') })
    h.sync.flush()
    expect(h.state().live[0]?.text).toBe('partial more')
  })

  it('catches up after a reconnect from the last saved event, without a reset', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, userMessage('u1', 'hi')]]))
    const ticket = h.sync.beginLoad('catch-up')
    expect(ticket.afterSeq).toBe(0)
    h.sync.receive({ tabId: TAB, seq: 2, event: text('m2', 'two') })
    expect(
      h.sync.completeLoad(ticket, {
        events: [{ seq: 1, event: text('m1', 'one') }],
        live: { afterSeq: 1, liveSeq: 0, events: [] }
      })
    ).toBe('done')
    expect(h.texts()).toEqual(['hi', 'one', 'two'])
    expect(h.actions.some((a) => a.type === 'reset')).toBe(false)
  })

  it('asks for a full reload when the log went backwards while away (reset elsewhere, new tab instance)', () => {
    const h = harness()
    h.sync.completeLoad(
      h.sync.beginLoad('full'),
      replay(
        [
          [0, userMessage('u1', 'hi')],
          [1, text('m1', 'one')]
        ],
        { liveSeq: 7 }
      )
    )
    const reset = h.sync.beginLoad('catch-up')
    expect(h.sync.completeLoad(reset, replay([], { afterSeq: -1, liveSeq: 0 }))).toBe('reload')
    // A new tab instance (hub restarted): saved log intact, live counter restarted.
    const restarted = h.sync.beginLoad('catch-up')
    expect(h.sync.completeLoad(restarted, replay([], { afterSeq: 1, liveSeq: 0 }))).toBe('reload')
  })

  it('reports a saved event older than the newest applied one (the log restarted elsewhere)', () => {
    const h = harness()
    h.sync.completeLoad(
      h.sync.beginLoad('full'),
      replay([
        [0, userMessage('u1', 'hi')],
        [1, text('m1', 'one')]
      ])
    )
    expect(h.sync.receive({ tabId: TAB, seq: 0, event: userMessage('u9', 'fresh') })).toBe(
      'regressed'
    )
    expect(h.texts()).toEqual(['hi', 'one'])
  })

  it('keeps messages this client sent but the hub does not have across a full reload', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, userMessage('u1', 'hi')]]))
    const ticket = h.sync.beginLoad('full')
    h.sync.completeLoad(ticket, replay([[0, userMessage('u1', 'hi')]]), [
      { id: 'u1', text: 'hi', failed: null },
      { id: 'u2', text: 'lost on the way', failed: 'WebSocket closed' }
    ])
    const users = h
      .state()
      .timeline.filter((it) => it?.kind === 'user-text')
      .map((it) => (it?.kind === 'user-text' ? [it.text, it.delivery] : []))
    expect(users).toEqual([
      ['hi', 'queued'],
      ['lost on the way', 'failed']
    ])
  })

  it('goes live after a failed load, applying what arrived meanwhile', () => {
    const h = harness()
    const ticket = h.sync.beginLoad('full')
    h.sync.receive({ tabId: TAB, seq: 0, event: userMessage('u1', 'hi') })
    expect(h.sync.failLoad(ticket)).toBe('done')
    expect(h.sync.loading).toBe(false)
    expect(h.texts()).toEqual(['hi'])
  })

  it('applies a process exit after the fragments waiting for their frame', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[0, userMessage('u1', 'hi')]]))
    h.sync.receive({
      tabId: TAB,
      seq: 0,
      live: 1,
      event: { kind: 'stream-message-start', messageId: 'm' }
    })
    h.sync.exit({ tabId: TAB, sessionId: 's', code: 0, signal: null })
    expect(h.actions.map((a) => a.type).slice(-2)).toEqual(['events', 'process-exit'])
    h.sync.exit({ tabId: 'other', sessionId: 's', code: 0, signal: null })
    expect(h.actions.filter((a) => a.type === 'process-exit')).toHaveLength(1)
  })

  it('a local reset forgets the sequence position', () => {
    const h = harness()
    h.sync.completeLoad(h.sync.beginLoad('full'), replay([[3, userMessage('u1', 'hi')]]))
    h.sync.resetLocal()
    expect(h.state().timeline).toHaveLength(0)
    expect(h.sync.receive({ tabId: TAB, seq: 0, event: userMessage('u2', 'new') })).toBe('applied')
  })
})
