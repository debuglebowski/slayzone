import { encodeTimelineState } from '@slayzone/terminal/timeline-checkpoint'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import { act, renderHook, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import { fakeHub } from './fake-hub'
import { useChatSession } from './useChatSession'

/** The direct link `useDirectLease` hands the hook (null: the hub relays). */
const mockDirect = { lease: null as null | { client: unknown }, lost: jest.fn() }
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  useDirectLease: () => ({ lease: mockDirect.lease, lost: mockDirect.lost })
}))
beforeEach(() => {
  mockDirect.lease = null
  mockDirect.lost.mockReset()
})

const target = {
  tabId: 'tab-1',
  taskId: 'task-1',
  mode: 'claude-chat',
  cwd: '/w',
  providerFlagsOverride: null
}

describe('useChatSession', () => {
  it('sends one answer per request, even for two taps in the same instant', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    let release: (ok: boolean) => void = () => undefined
    hub.on('chat.respondPermission', () => new Promise<boolean>((r) => (release = r)))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))

    const args = { requestId: 'r1', optionId: 'yes', decision: { behavior: 'allow' as const } }
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = result.current.respondPermission(args)
      second = result.current.respondPermission(args)
    })
    await expect(second).resolves.toBe(false)
    expect(result.current.submittingPrompts.has('r1')).toBe(true)
    await act(async () => release(true))
    await expect(first).resolves.toBe(true)
    expect(hub.callsTo('chat.respondPermission')).toHaveLength(1)
    expect(result.current.submittingPrompts.has('r1')).toBe(false)
  })

  it('loads the history after its subscription started, hydrating first', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const order: string[] = []
    hub.on('chat.hydrate', () => {
      order.push('hydrate')
      return null
    })
    hub.on('chat.getReplay', (input) => {
      order.push(`replay ${input.afterSeq}`)
      return {
        events: [{ seq: 0, event: { kind: 'user-message', id: 'u1', text: 'earlier' } }],
        live: { afterSeq: 0, liveSeq: 0, events: [] }
      }
    })
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(order).toEqual(['hydrate', 'replay -1'])
    expect(hub.subscribed['chat.onEvent']).toEqual([{ tabIds: ['tab-1'] }])
    expect(result.current.state.timeline.map((i) => i?.kind)).toEqual(['user-text'])
  })

  it('opens the projected tail and fetches older rows only when asked', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const head = reducer(initialState({ agentStartedTurns: true }), {
      type: 'events',
      events: [
        { kind: 'user-message', id: 'older', text: 'Earlier prompt' },
        { kind: 'assistant-text', messageId: 'recent', text: 'Latest response' }
      ],
      at: [100, 200],
      seq: [0, 1]
    })
    hub.on('chat.openTimeline', () => ({
      kind: 'paged',
      snapshot: {
        seq: 1,
        epoch: head.rowsEpoch,
        pageRows: 1,
        state: encodeTimelineState(head, 1),
        summaries: [{}]
      },
      events: [],
      live: { afterSeq: 1, liveSeq: 0, events: [] }
    }))
    hub.on('chat.timelinePages', () => ({
      expired: false,
      pages: [{ page: 0, from: 0, rows: head.timeline.slice(0, 1) }]
    }))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(result.current.state.timeline).toEqual([undefined, head.timeline[1]])
    expect(hub.callsTo('chat.getReplay')).toHaveLength(0)
    expect(hub.callsTo('chat.timelinePages')).toHaveLength(0)

    await act(async () => result.current.olderHistory?.load())
    await waitFor(() => expect(result.current.state.timeline).toEqual(head.timeline))
    expect(result.current.olderHistory).toBeNull()
    expect(hub.callsTo('chat.timelinePages')).toEqual([
      { tabId: target.tabId, pages: [0], epoch: head.rowsEpoch, asOfSeq: 1, startRow: 0 }
    ])
  })

  it('loads a sealed tool row when a live event updates it', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const head = reducer(initialState({ agentStartedTurns: true }), {
      type: 'events',
      events: [
        { kind: 'tool-call', id: 'older', name: 'Bash', input: { command: 'pwd' } },
        { kind: 'assistant-text', messageId: 'recent', text: 'Waiting' }
      ],
      seq: [0, 1]
    })
    hub.on('chat.openTimeline', () => ({
      kind: 'paged',
      snapshot: {
        seq: 1,
        epoch: head.rowsEpoch,
        pageRows: 1,
        state: encodeTimelineState(head, 1),
        summaries: [{}]
      },
      events: [],
      live: { afterSeq: 1, liveSeq: 0, events: [] }
    }))
    hub.on('chat.timelinePages', () => ({
      expired: false,
      pages: [{ page: 0, from: 0, rows: head.timeline.slice(0, 1) }]
    }))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    await act(async () => {
      hub.emit('chat.onEvent', {
        tabId: target.tabId,
        seq: 2,
        event: {
          kind: 'tool-result',
          toolUseId: 'older',
          rawContent: '/w',
          structured: null,
          isError: false
        }
      })
    })
    await waitFor(() => {
      expect(result.current.state.appliedSeq).toBe(2)
      expect(result.current.state.stalled).toBeNull()
      expect(result.current.state.timeline[0]).toMatchObject({
        kind: 'tool',
        invocation: { result: { rawContent: '/w' } }
      })
    })
    expect(hub.callsTo('chat.timelinePages')).toEqual([
      { tabId: target.tabId, pages: [0], epoch: head.rowsEpoch, asOfSeq: 1, startRow: 0 }
    ])
  })

  it('reads the history in bounded pages, carrying on after the last event of each', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const history = Array.from({ length: 9 }, (_, seq) => ({
      seq,
      event: { kind: 'user-message', id: `u${seq}`, text: `m${seq}` }
    }))
    const asked: Array<{ afterSeq: number; page?: unknown }> = []
    hub.on('chat.getReplay', (input) => {
      asked.push(input)
      const rest = history.filter((e) => e.seq > input.afterSeq)
      const events = rest.slice(0, 4)
      return rest.length > 4
        ? { events, hasMore: true }
        : { events, hasMore: false, live: { afterSeq: 8, liveSeq: 0, events: [] } }
    })
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(asked.map((a) => a.afterSeq)).toEqual([-1, 3, 7])
    for (const a of asked) expect(a.page).toBeDefined()
    expect(
      result.current.state.timeline.flatMap((i) => (i?.kind === 'user-text' ? [i.text] : []))
    ).toEqual(history.map((e) => e.event.text))
  })

  it("reads a turn Claude Code starts by itself (a background task's answer) as working", async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    hub.on('chat.getReplay', () => ({
      events: [
        { seq: 0, event: { kind: 'turn-init', sessionId: 's1', model: 'opus', cwd: '/w' } },
        { seq: 1, event: { kind: 'user-message', id: 'u1', text: 'run it in the background' } },
        { seq: 2, event: { kind: 'result', subtype: 'success', isError: false, durationMs: 1 } },
        // No user message: the agent answers the finished background task on its own.
        { seq: 3, event: { kind: 'turn-init', sessionId: 's1', model: 'opus', cwd: '/w' } },
        { seq: 4, event: { kind: 'assistant-text', messageId: 'm2', text: 'The task finished.' } }
      ],
      live: { afterSeq: 4, liveSeq: 4, events: [] }
    }))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(result.current.state.agentStartedTurns).toBe(true)
    expect(result.current.inFlight).toBe(true)
  })

  it('on the direct link: replays and streams from the computer; the permission answer goes through the hub (its running-in-terminal guard)', async () => {
    const calls: string[] = []
    let emit: ((e: unknown) => void) | undefined
    let started: (() => void) | undefined
    mockDirect.lease = {
      client: {
        chat: {
          getReplay: {
            query: async (input: { afterSeq: number }) => {
              calls.push(`replay ${input.afterSeq}`)
              return {
                events: [
                  { seq: 0, event: { kind: 'user-message', id: 'u1', text: 'from computer' } }
                ],
                live: { afterSeq: 0, liveSeq: 0, events: [] }
              }
            }
          },
          onEvent: {
            subscribe: (
              _input: unknown,
              h: { onStarted: () => void; onData: (e: unknown) => void }
            ) => {
              started = h.onStarted
              emit = h.onData
              return { unsubscribe: () => undefined }
            }
          }
        }
      }
    }
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await act(async () => started?.())
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(calls).toEqual(['replay -1'])
    expect(hub.subscribed['chat.onEvent']).toBeUndefined()
    await act(async () =>
      emit?.({
        tabId: target.tabId,
        seq: 1,
        event: { kind: 'assistant-text', messageId: 'm1', text: 'direct reply' }
      })
    )
    await waitFor(() =>
      expect(result.current.state.timeline.map((i) => i?.kind)).toEqual(['user-text', 'text'])
    )
    await act(async () => {
      await result.current.respondPermission({ requestId: 'r', decision: { behavior: 'allow' } })
    })
    expect(calls).toEqual(['replay -1'])
    expect(hub.callsTo('chat.respondPermission')).toHaveLength(1)
  })

  describe("a send waits for its tab's hydrate (the computer refuses one that overtakes it)", () => {
    /** A hub whose hydrate answers when the test says, refusing a send before it ran. */
    function gatedHub(): {
      hub: ReturnType<typeof fakeHub>
      release: (outcome?: 'ok' | 'fail') => void
    } {
      const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
      let ready = false
      let settle: ((outcome: 'ok' | 'fail') => void) | null = null
      hub.on(
        'chat.hydrate',
        () =>
          new Promise((resolve, reject) => {
            settle = (outcome) => {
              ready = outcome === 'ok'
              if (outcome === 'ok') resolve(null)
              else reject(new Error('hydrate failed'))
            }
          })
      )
      hub.on('chat.send', (input) => {
        if (!ready) throw new Error(`No chat session for tab ${input.tabId}`)
        return { id: input.message.id, state: 'queued' }
      })
      return {
        hub,
        release: (outcome = 'ok') => {
          const s = settle
          settle = null
          s?.(outcome)
        }
      }
    }

    const delivery = (result: { current: ReturnType<typeof useChatSession> }) =>
      result.current.state.timeline
        .filter((i) => i?.kind === 'user-text')
        .map((i) => (i?.kind === 'user-text' ? (i.delivery ?? 'sent') : null))

    it('during the first load', async () => {
      const { hub, release } = gatedHub()
      const { wrapper } = trpcTest(hub.backend)
      const { result } = await renderHook(() => useChatSession(target), { wrapper })
      await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(1))

      let sent!: Promise<void>
      await act(async () => {
        sent = result.current.sendMessage('hello')
      })
      // Shown at once; held back until the hydrate answered.
      expect(result.current.state.timeline.map((i) => i?.kind)).toEqual(['user-text'])
      await new Promise((r) => setTimeout(r, 20))
      expect(hub.callsTo('chat.send')).toHaveLength(0)

      await act(async () => release())
      await act(async () => sent)
      expect(hub.callsTo('chat.send')).toHaveLength(1)
      expect(delivery(result)).not.toContain('failed')
    })

    it('during a reload', async () => {
      const { hub, release } = gatedHub()
      const { wrapper } = trpcTest(hub.backend)
      const { result } = await renderHook(() => useChatSession(target), { wrapper })
      await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(1))
      await act(async () => release())
      await waitFor(() => expect(result.current.hydrating).toBe(false))

      // The reload's hydrate runs again on the hub: the session is not there until it did.
      let reloaded = false
      let releaseReload: () => void = () => undefined
      hub.on(
        'chat.hydrate',
        () =>
          new Promise((resolve) => {
            releaseReload = () => {
              reloaded = true
              resolve(null)
            }
          })
      )
      hub.on('chat.send', (input) => {
        if (!reloaded) throw new Error(`No chat session for tab ${input.tabId}`)
        return { id: input.message.id, state: 'queued' }
      })
      await act(async () => result.current.reload())
      await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(2))

      let sent!: Promise<void>
      await act(async () => {
        sent = result.current.sendMessage('again')
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(hub.callsTo('chat.send')).toHaveLength(0)

      await act(async () => releaseReload())
      await act(async () => sent)
      expect(hub.callsTo('chat.send')).toHaveLength(1)
      expect(delivery(result)).not.toContain('failed')
    })

    it('a failed hydrate does not hold the send back', async () => {
      const { hub, release } = gatedHub()
      hub.on('chat.send', (input) => ({ id: input.message.id, state: 'queued' }))
      const { wrapper } = trpcTest(hub.backend)
      const { result } = await renderHook(() => useChatSession(target), { wrapper })
      await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(1))

      let sent!: Promise<void>
      await act(async () => {
        sent = result.current.sendMessage('hello')
      })
      await act(async () => release('fail'))
      await act(async () => sent)
      expect(hub.callsTo('chat.send')).toHaveLength(1)
    })
  })
})
