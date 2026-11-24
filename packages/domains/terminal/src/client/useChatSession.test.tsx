// @vitest-environment jsdom
// Pins useChatSession's hydrate → replay lifecycle: the loading flag, replay order,
// live events queued during a load, prompts rebuilt by the replay, and stale-load
// isolation. A reload (same tab, new folder / flags) must end in the same timeline a
// fresh open of the tab shows — never the old timeline with the history replayed on top.
import { createElement, useLayoutEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CHAT_HISTORY_DISPLAY_VERSION } from '@slayzone/terminal-contracts'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { TimelineItem } from '../shared/chat-timeline'

type Buffered = Array<{ seq: number; event: unknown; at?: number }>
/** `chat.getReplay`: saved events + the blocks streaming right now (live-only). */
interface Replay {
  events: Buffered
  live: { afterSeq: number; liveSeq: number; events: unknown[] }
}
/** A replay with nothing streaming. */
const saved = (events: Buffered): Replay => ({
  events,
  live: { afterSeq: events.length ? events[events.length - 1].seq : -1, liveSeq: 0, events: [] }
})
interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (error: unknown) => void
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

/** The direct lease `useDirectLease` answers (null: relay only). */
let directLease: unknown = null
/** The direct `chat.onEvent` subscription the hook opened (its handlers). */
let directSub: {
  onStarted?: () => void
  onData: (d: unknown) => void
  onError?: () => void
} | null = null
const fakeDirectLease = () => ({
  computerId: 'c1',
  client: {
    chat: {
      onEvent: {
        subscribe: (_input: unknown, handlers: NonNullable<typeof directSub>) => {
          directSub = handlers
          return { unsubscribe: () => undefined }
        }
      }
    }
  },
  onLost: () => () => undefined,
  release: () => undefined
})

// One pending hydrate + buffer fetch per load, resolved by the test in its own order.
let loads: Array<{
  cwd: string
  mode: string
  providerFlagsOverride: string | null
  hydrate: Deferred<void>
  buffer: Deferred<Buffered | Replay>
}> = []
const sent: Array<{
  tabId: string
  operationId?: string
  message: { id: string; content: unknown }
}> = []
let sendFails: Error | null = null
// The load whose hydrate the test just resolved — its buffer fetch follows.
let bufferLoad = -1
const modelQueryKey = (input: unknown) => ['chat.getModels', input]
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const subs: Record<string, ((data: unknown) => void) | null> = { event: null, exit: null }
/** The hub stream's `onStarted` (a (re)start of the subscription: a reconnect). */
const started: Record<string, (() => void) | undefined> = {}
/** What `useSubscription` reports (`connecting`: tRPC is reconnecting the socket). */
let streamStatus: 'connecting' | 'pending' = 'pending'
/** The hub socket (nearest HubScope): its state, and `useHubReopen`'s callback. */
let hubSocket: 'open' | 'connecting' = 'open'
let hubReopen: ((dropped: boolean) => void) | null = null

// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    chat: {
      getModels: { queryKey: modelQueryKey },
      onEvent: { subscriptionOptions: (_i: unknown, o: object) => ({ ...o, name: 'event' }) },
      onExit: { subscriptionOptions: (_i: unknown, o: object) => ({ ...o, name: 'exit' }) }
    }
  }),
  useTRPCClient: () => client,
  useSubscription: (o: {
    name: string
    enabled: boolean
    onData: (d: unknown) => void
    onStarted?: () => void
  }) => {
    subs[o.name] = o.enabled ? o.onData : null
    started[o.name] = o.enabled ? o.onStarted : undefined
    return { status: o.enabled ? streamStatus : 'idle' }
  },
  useScopedHubConnection: () => ({ status: hubSocket, error: null }),
  useHubReopen: (onReopen: (dropped: boolean) => void) => {
    hubReopen = onReopen
  },
  // No direct link unless a test sets `directLease`: everything goes through the hub.
  useDirectLease: () => ({ lease: directLease, lost: () => undefined })
}))
const client = {
  chat: {
    hydrate: {
      mutate: (target: { cwd: string; mode: string; providerFlagsOverride: string | null }) => {
        const load = {
          cwd: target.cwd,
          mode: target.mode,
          providerFlagsOverride: target.providerFlagsOverride,
          hydrate: deferred<void>(),
          buffer: deferred<Buffered | Replay>()
        }
        loads.push(load)
        return load.hydrate.promise
      }
    },
    getReplay: {
      query: () => loads[bufferLoad].buffer.promise.then((b) => (Array.isArray(b) ? saved(b) : b))
    },
    send: {
      mutate: (input: { tabId: string; message: { id: string; content: unknown } }) => {
        sent.push(input)
        if (sendFails) return Promise.reject(sendFails)
        return Promise.resolve({ id: input.message.id, state: 'queued' })
      }
    },
    respondPermission: { mutate: (_input: unknown) => respondReply.promise },
    // Paged history: answered by `hub` when a test sets one, else the full replay.
    openTimeline: {
      query: (input: { tabId: string; version: string }) =>
        hub ? hub.open(input) : Promise.resolve({ kind: 'full' as const })
    },
    timelinePages: {
      query: (input: { tabId: string; pages: number[]; asOfSeq: number; epoch: number }) =>
        hub ? hub.pages(input) : Promise.resolve({ expired: true as const })
    }
  }
}

/** A hub that opens tabs paged (set by the paged tests; null: full replay). */
interface FakeHub {
  open(input: { tabId: string; version: string }): Promise<unknown>
  pages(input: { pages: number[]; asOfSeq: number; epoch: number }): Promise<unknown>
}
let hub: FakeHub | null = null
// What the server answers to the next `respondPermission`.
let respondReply = deferred<boolean>()
const respondCalls: unknown[] = []
client.chat.respondPermission.mutate = (input: unknown) => {
  respondCalls.push(input)
  return respondReply.promise
}

// Every action the reducer is given (by identity: React may reduce one twice).
const reducerActions = new Set<{ type: string; events?: unknown[] }>()
vi.mock('../shared/chat-timeline', async (importOriginal) => {
  const m = await importOriginal<typeof import('../shared/chat-timeline')>()
  return {
    ...m,
    reducer: (state: Parameters<typeof m.reducer>[0], action: Parameters<typeof m.reducer>[1]) => {
      reducerActions.add(action as { type: string; events?: unknown[] })
      return m.reducer(state, action)
    }
  }
})

const { useChatSession } = await import('./useChatSession')
const {
  liveBlockOf,
  streamKeyOf,
  initialState: realInitial,
  reducer: realReducer
} = await import('../shared/chat-timeline')
const { buildLongSession } = await import('@slayzone/test-utils/chat-long-session')
const { encodeTimelineState } = await import('../shared/chat-timeline-checkpoint')
const { summarizeRows } = await import('../shared/timeline-summary')

const userMsg = (text: string) => ({ kind: 'user-message', text })
const permReq = (toolUseId: string) => ({
  kind: 'permission-request',
  requestId: `req-${toolUseId}`,
  toolName: 'AskUserQuestion',
  toolUseId,
  input: { q: 1 }
})
const HISTORY: Buffered = [
  { seq: 0, event: userMsg('one') },
  { seq: 1, event: userMsg('two') },
  { seq: 2, event: permReq('tu-1') }
]

/** Finish load `i`: hydrate resolves, then the replay fetch returns `buffered`. */
async function finishLoad(i: number, buffered: Buffered | Replay): Promise<void> {
  await act(async () => {
    bufferLoad = i
    loads[i].hydrate.resolve()
    await Promise.resolve()
  })
  await act(async () => {
    loads[i].buffer.resolve(buffered)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const live = (seq: number, event: unknown, at?: number): void =>
  act(() => subs.event!({ tabId: 'tab-1', event, seq, ...(at !== undefined ? { at } : {}) }))
/** A live-only event (streaming fragment / `sending`), following saved event `seq`. */
const liveOnly = (seq: number, liveN: number, event: unknown): void =>
  act(() => subs.event!({ tabId: 'tab-1', event, seq, live: liveN }))

interface Props {
  cwd: string
  mode?: string
  flags?: string | null
  hideThinking?: boolean
}

function setup(hideThinking?: boolean) {
  // Every COMMITTED (cwd, hydrating) pair — a layout effect only runs for a render that
  // reaches the screen.
  const frames: Array<{ cwd: string; hydrating: boolean }> = []
  const hook = renderHook(
    ({ cwd, mode = 'claude-chat', flags = null, hideThinking }: Props) => {
      const r = useChatSession({
        tabId: 'tab-1',
        taskId: 't1',
        mode,
        cwd,
        providerFlagsOverride: flags,
        display: hideThinking ? { hideThinking: true } : undefined
      })
      const hydrating = r.hydrating
      useLayoutEffect(() => {
        frames.push({ cwd, hydrating })
      })
      return r
    },
    {
      initialProps: { cwd: '/repo', hideThinking } as Props,
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
    }
  )
  return { ...hook, frames }
}

/** The assistant replies on screen (a streaming reply shows its live text). */
const replies = (r: { current: ReturnType<typeof useChatSession> }): string[] =>
  r.current.timeline.flatMap((it) => {
    if (it?.kind !== 'text' || it.role !== 'assistant') return []
    const key = streamKeyOf(it)
    return [
      (it.stream === 'open' && key ? liveBlockOf(r.current.state.live, key)?.text : undefined) ??
        it.text
    ]
  })

const result = (seq: number) => ({
  seq,
  event: {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1,
    durationApiMs: 1,
    numTurns: 1,
    totalCostUsd: 0,
    stopReason: null,
    terminalReason: null,
    text: null,
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  }
})

/** Tool ids of the prompts still waiting for the user. */
const pendingToolIds = (r: { current: ReturnType<typeof useChatSession> }): string[] =>
  r.current.prompts.filter((p) => p.status === 'pending').map((p) => p.toolUseId)

/** The user messages on screen (the reducer adds its own markers between them). */
const texts = (r: { current: ReturnType<typeof useChatSession> }): string[] =>
  r.current.timeline.flatMap((it) => (it?.kind === 'user-text' ? [it.text] : []))

afterEach(() => {
  streamStatus = 'pending'
  hubSocket = 'open'
  hubReopen = null
  vi.restoreAllMocks()
  cleanup()
  queryClient.clear()
  hub = null
  reducerActions.clear()
  loads = []
  bufferLoad = -1
  respondReply = deferred<boolean>()
  respondCalls.length = 0
  sent.length = 0
  sendFails = null
  directLease = null
  directSub = null
})

describe('paged-history failures', () => {
  it('shows a transient paging failure without requesting a full replay', async () => {
    vi.spyOn(client.chat.openTimeline, 'query').mockRejectedValue(new Error('computer unavailable'))
    const replay = vi.spyOn(client.chat.getReplay, 'query')
    const { result } = setup()
    await act(async () => {
      loads[0].hydrate.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(replay).not.toHaveBeenCalled()
    expect(result.current.loadError).toBe('computer unavailable')
    expect(result.current.hydrating).toBe(false)
  })

  it('retains full replay for an older hub without the paging procedure', async () => {
    vi.spyOn(client.chat.openTimeline, 'query').mockRejectedValue(
      Object.assign(new Error('No procedure found'), { data: { code: 'NOT_FOUND' } })
    )
    const { result } = setup()
    await finishLoad(0, HISTORY)
    expect(result.current.loadError).toBeNull()
    expect(texts(result)).toEqual(['one', 'two'])
  })
})

// M1: switching to the direct link is make-before-break. The hub stream stays on until
// the computer's stream has started, so an event saved in between is never on neither.
describe('hub → direct link switch', () => {
  it('keeps the hub stream until the direct stream started; nothing is dropped', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, HISTORY)
    directLease = fakeDirectLease()
    rerender({ cwd: '/repo' })
    expect(directSub).not.toBeNull()
    // Saved while the computer subscription is still being set up: only the hub has it.
    live(3, userMsg('three'))
    expect(texts(result)).toEqual(['one', 'two', 'three'])
    act(() => directSub!.onStarted?.())
    // Started: the hub stream is off; the computer delivers from here, deduped by seq.
    expect(subs.event).toBeNull()
    act(() => directSub!.onData({ tabId: 'tab-1', event: userMsg('three'), seq: 3 }))
    act(() => directSub!.onData({ tabId: 'tab-1', event: userMsg('four'), seq: 4 }))
    expect(texts(result)).toEqual(['one', 'two', 'three', 'four'])
  })
})

describe('lifecycle replay and delivery boundaries', () => {
  const trace = (): Buffered => [
    { seq: 0, event: { ...userMsg('synthetic request'), id: 'request-1' } },
    { seq: 1, event: permReq('approval-main') },
    {
      seq: 2,
      event: {
        kind: 'tool-call',
        id: 'child-tool',
        name: 'Bash',
        input: {},
        parentToolUseId: 'helper-1'
      }
    },
    {
      seq: 3,
      event: {
        kind: 'permission-resolved',
        requestId: 'req-approval-main',
        decision: { behavior: 'allow', updatedInput: {} }
      }
    },
    { seq: 4, event: { kind: 'assistant-text', messageId: 'answer-1', text: 'synthetic answer' } },
    result(5)
  ]

  it.each(Array.from({ length: 7 }, (_, i) => i))(
    'replay prefix %i plus overlapping queued deliveries converges to one finished turn',
    async (cut) => {
      const events = trace()
      const { result: r } = setup()
      for (const entry of events.slice(cut)) {
        live(entry.seq, entry.event)
        live(entry.seq, entry.event) // relay / direct overlap of the same saved event
      }
      await finishLoad(0, events.slice(0, cut))
      const settled = () => {
        expect(texts(r)).toEqual(['synthetic request'])
        expect(replies(r)).toEqual(['synthetic answer'])
        expect(pendingToolIds(r)).toEqual([])
        expect(r.current.inFlight).toBe(false)
        expect(r.current.state.resultCount).toBe(1)
        expect(r.current.state.userMessagesSent).toBe(1)
      }
      settled()
      // Old packets must not reopen the approval or count completion twice.
      for (const entry of events) live(entry.seq, entry.event)
      settled()

      await act(() => r.current.reload())
      live(5, events[5].event)
      await finishLoad(1, events)
      settled()
      expect(sent).toEqual([]) // Replay and reconnect never invent a provider send.
    }
  )

  it('a lost acknowledgement reconciles the accepted answer without resending the request', async () => {
    const { result: r } = setup()
    await finishLoad(0, [])
    sendFails = new Error('acknowledgement lost')
    await act(async () => {
      await r.current.sendMessage('accepted remotely').catch(() => undefined)
    })
    expect(sent).toHaveLength(1)
    const id = sent[0].message.id
    await act(() => r.current.reload())
    await finishLoad(1, [
      { seq: 0, event: { kind: 'user-message', id, text: 'accepted remotely' } },
      { seq: 1, event: { kind: 'user-message-delivery', id, state: 'answered' } },
      {
        seq: 2,
        event: { kind: 'assistant-text', messageId: 'remote-answer', text: 'completed remotely' }
      },
      result(3)
    ])
    expect(sent).toHaveLength(1)
    expect(texts(r)).toEqual(['accepted remotely'])
    expect(replies(r)).toEqual(['completed remotely'])
    expect(r.current.inFlight).toBe(false)
    expect(r.current.timeline.find((row) => row?.kind === 'user-text')).toMatchObject({
      id,
      delivery: 'answered'
    })
  })
})

describe('live CLI model lists', () => {
  it('keeps newer queued model metadata over an older replay snapshot', async () => {
    setup()
    const queryKey = modelQueryKey({ taskId: 't1', mode: 'claude-chat' })
    const models = [{ id: 'model-new', label: 'New model' }]
    liveOnly(-1, 2, { kind: 'cli-models', models })
    await finishLoad(0, {
      events: [],
      live: { afterSeq: -1, liveSeq: 1, events: [{ kind: 'cli-models', models: [] }] }
    })
    expect(queryClient.getQueryData(queryKey)).toEqual(models)
  })

  it('restores model metadata from a replay when initialize preceded the subscription', async () => {
    setup()
    const queryKey = modelQueryKey({ taskId: 't1', mode: 'claude-chat' })
    queryClient.setQueryData(queryKey, [])
    const models = [{ id: 'model-new', label: 'New model' }]
    await finishLoad(0, {
      events: HISTORY,
      live: {
        afterSeq: HISTORY[HISTORY.length - 1].seq,
        liveSeq: 1,
        events: [{ kind: 'cli-models', models }]
      }
    })
    expect(queryClient.getQueryData(queryKey)).toEqual(models)
  })

  it('updates the picker cache and prevents an older empty query overwriting it', async () => {
    setup()
    const queryKey = modelQueryKey({ taskId: 't1', mode: 'claude-chat' })
    const oldReply = deferred<unknown[]>()
    const oldQuery = queryClient
      .fetchQuery({ queryKey, queryFn: () => oldReply.promise })
      .catch(() => {})
    const models = [{ id: 'model-new', label: 'New model' }]
    liveOnly(-1, 1, { kind: 'cli-models', models })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(queryClient.getQueryData(queryKey)).toEqual(models)
    oldReply.resolve([])
    await oldQuery
    expect(queryClient.getQueryData(queryKey)).toEqual(models)
  })
})

describe('useChatSession — must keep working', () => {
  it('loading until the replay lands; history replayed in order', async () => {
    const { result } = setup()
    expect(result.current.hydrating).toBe(true)
    await finishLoad(0, HISTORY)
    expect(result.current.hydrating).toBe(false)
    expect(texts(result)).toEqual(['one', 'two'])
  })

  it('live events during a load are queued, then applied once after the replay (deduped by seq)', async () => {
    const { result } = setup()
    live(1, userMsg('two')) // also in the buffer → must not double
    live(3, userMsg('three'))
    expect(texts(result)).toEqual([])
    await finishLoad(0, HISTORY)
    expect(texts(result)).toEqual(['one', 'two', 'three'])
    live(4, userMsg('four'))
    expect(texts(result)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('a pending permission request (AskUserQuestion) comes back from the replay', async () => {
    const { result } = setup()
    await finishLoad(0, HISTORY)
    expect(pendingToolIds(result)).toEqual(['tu-1'])
  })

  it('a slow load for the old folder neither applies nor ends the new load', async () => {
    const { result, rerender } = setup()
    rerender({ cwd: '/wt' })
    await finishLoad(0, [{ seq: 0, event: userMsg('stale') }])
    expect(result.current.hydrating).toBe(true)
    expect(texts(result)).toEqual([])
    await finishLoad(1, HISTORY)
    expect(result.current.hydrating).toBe(false)
    expect(texts(result)).toEqual(['one', 'two'])
  })

  it('a message sent while the first load runs is confirmed, not duplicated', async () => {
    const { result } = setup()
    // Shown at once; it goes out once the tab's hydrate answered.
    await act(async () => {
      void result.current.sendMessage('hi')
    })
    expect(texts(result)).toEqual(['hi'])
    await finishLoad(0, [])
    expect(texts(result)).toEqual(['hi']) // still on screen before the echo lands
    // The server echoes the message with the id the client minted.
    live(0, { kind: 'user-message', id: sent[0].message.id, text: 'hi' })
    expect(texts(result)).toEqual(['hi'])
  })
})

describe('useChatSession — hydrate failure', () => {
  it('is reported once as hydrateError beside the loaded history, never as a timeline row', async () => {
    const { result } = setup()
    await act(async () => {
      bufferLoad = 0
      loads[0].hydrate.reject(new Error('Provider conversation belongs to another storage owner'))
      await Promise.resolve()
    })
    await act(async () => {
      loads[0].buffer.resolve(HISTORY)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.hydrateError).toBe(
      'Provider conversation belongs to another storage owner'
    )
    expect(result.current.loadError).toBeNull()
    expect(texts(result)).toEqual(['one', 'two'])
    expect(result.current.timeline.some((it) => it?.kind === 'turn-error')).toBe(false)
  })

  it('a later successful load clears it', async () => {
    const { result, rerender } = setup()
    await act(async () => {
      bufferLoad = 0
      loads[0].hydrate.reject(new Error('boom'))
      await Promise.resolve()
    })
    await act(async () => {
      loads[0].buffer.resolve(HISTORY)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.hydrateError).toBe('boom')
    rerender({ cwd: '/wt' })
    await finishLoad(1, HISTORY)
    expect(result.current.hydrateError).toBeNull()
  })
})

describe('useChatSession — hub connection lost while opening', () => {
  async function failHydrate(message: string) {
    await act(async () => {
      bufferLoad = 0
      loads[0].hydrate.reject(new Error(message))
      await Promise.resolve()
    })
    await act(async () => {
      loads[0].buffer.resolve(HISTORY)
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('reopens by itself when the hub socket comes back', async () => {
    const { result } = setup()
    await failHydrate('Lost connection to hub ws://127.0.0.1:1/trpc (socket close, code 1006)')
    expect(result.current.hydrateError).toMatch(/lost connection/i)
    act(() => hubReopen?.(true))
    expect(loads).toHaveLength(2)
    await finishLoad(1, HISTORY)
    expect(result.current.hydrateError).toBeNull()
    expect(texts(result)).toEqual(['one', 'two'])
  })

  it('a reopen with nothing failed does not reload (the stream catches up)', async () => {
    setup()
    await finishLoad(0, HISTORY)
    act(() => hubReopen?.(true))
    expect(loads).toHaveLength(1)
  })

  it('reports the hub socket reconnecting', () => {
    hubSocket = 'connecting'
    const { result } = setup()
    expect(result.current.hubReconnecting).toBe(true)
  })
})

describe('useChatSession — bugs', () => {
  it('Bug 2: a reload (folder change on the same tab) does not show every message twice', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/wt' })
    await finishLoad(1, HISTORY)
    expect(texts(result)).toEqual(['one', 'two'])
    expect(pendingToolIds(result)).toEqual(['tu-1'])
  })
})

describe('useChatSession — reload edge cases', () => {
  it('a reload mid-reply keeps the reply streaming, once, and the turn still ends', async () => {
    // Fragments are live-only (never saved): the replay's live snapshot redraws them.
    const midReply = (text: string, liveSeq: number): Replay => ({
      events: [{ seq: 0, event: userMsg('one') }],
      live: {
        afterSeq: 0,
        liveSeq,
        events: [
          { kind: 'stream-message-start', messageId: 'm0' },
          { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
          { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text }
        ]
      }
    })
    const { result: r, rerender } = setup()
    await finishLoad(0, midReply('Hel', 3))
    expect(replies(r)).toEqual(['Hel'])
    expect(r.current.inFlight).toBe(true)

    rerender({ cwd: '/repo', flags: '--verbose' })
    expect(loads[1].providerFlagsOverride).toBe('--verbose')
    // "lo" streams during the reload; the snapshot was taken before it.
    liveOnly(0, 4, { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'lo' })
    await finishLoad(1, midReply('Hel', 3))
    expect(texts(r)).toEqual(['one'])
    expect(replies(r)).toEqual(['Hello'])
    expect(r.current.inFlight).toBe(true)

    liveOnly(0, 5, { kind: 'stream-block-stop', blockIndex: 0 })
    liveOnly(0, 6, { kind: 'stream-message-stop' })
    // The block's one saved event, then the turn's end.
    live(1, { kind: 'assistant-text', messageId: 'm0', text: 'Hello' })
    live(2, result(2).event)
    expect(replies(r)).toEqual(['Hello'])
    expect(r.current.inFlight).toBe(false)
  })

  it('a snapshot taken after a queued fragment does not apply that fragment twice', async () => {
    const { result: r } = setup()
    liveOnly(0, 4, { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'lo' })
    await finishLoad(0, {
      events: [{ seq: 0, event: userMsg('one') }],
      live: {
        afterSeq: 0,
        liveSeq: 4,
        events: [
          { kind: 'stream-message-start', messageId: 'm0' },
          { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
          { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hello' }
        ]
      }
    })
    expect(replies(r)).toEqual(['Hello'])
  })

  it('a live fragment that belongs before an already-applied saved event is dropped', async () => {
    const { result: r } = setup()
    await finishLoad(0, [{ seq: 0, event: userMsg('one') }])
    live(1, { kind: 'assistant-text', messageId: 'm0', text: 'done' })
    liveOnly(0, 1, { kind: 'stream-message-start', messageId: 'm-stale' })
    liveOnly(0, 2, { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' })
    liveOnly(0, 3, { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'ghost' })
    expect(replies(r)).toEqual(['done'])
  })

  it('switching chat agent (Claude → Codex) on the same tab reloads once, no duplicates', async () => {
    const { result: r, rerender } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/repo', mode: 'codex-chat' })
    expect(r.current.hydrating).toBe(true)
    expect(loads[1].mode).toBe('codex-chat')
    await finishLoad(1, HISTORY)
    expect(r.current.hydrating).toBe(false)
    expect(texts(r)).toEqual(['one', 'two'])
    expect(pendingToolIds(r)).toEqual(['tu-1'])
  })
})

describe('useChatSession — fix behaviour', () => {
  it('a reload drops a permission request the reloaded history no longer has', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/wt' })
    await finishLoad(1, HISTORY.slice(0, 2))
    expect(pendingToolIds(result)).toEqual([])
  })

  it('loading shows from the first frame drawn for the new folder', async () => {
    const { rerender, frames } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/wt' })
    expect(frames.filter((f) => f.cwd === '/wt' && !f.hydrating)).toEqual([])
  })

  it('switching folder away and back still waits for the new load', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/wt' })
    rerender({ cwd: '/repo' })
    expect(result.current.hydrating).toBe(true)
    await finishLoad(1, [])
    expect(result.current.hydrating).toBe(true)
    await finishLoad(2, HISTORY)
    expect(result.current.hydrating).toBe(false)
    expect(texts(result)).toEqual(['one', 'two'])
  })
})

describe('useChatSession — answering prompts', () => {
  const allow = { requestId: 'req-tu-1', decision: { behavior: 'allow' as const }, optionId: 'yes' }

  it('a second click while the answer is in flight sends nothing more', async () => {
    const { result } = setup()
    await finishLoad(0, HISTORY)
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = result.current.respondPermission(allow)
      second = result.current.respondPermission(allow)
    })
    expect(result.current.submittingPrompts.has('req-tu-1')).toBe(true)
    await act(async () => {
      respondReply.resolve(true)
      await first
    })
    expect(await second).toBe(false)
    expect(respondCalls).toEqual([{ tabId: 'tab-1', args: allow }])
    expect(result.current.submittingPrompts.size).toBe(0)
  })

  it('a refused answer (request no longer pending server-side) shows the prompt as expired', async () => {
    const { result } = setup()
    await finishLoad(0, HISTORY)
    let answer!: Promise<boolean>
    act(() => {
      answer = result.current.respondPermission(allow)
    })
    await act(async () => {
      respondReply.resolve(false)
      await answer
    })
    expect(await answer).toBe(false)
    expect(result.current.prompts.map((p) => p.status)).toEqual(['expired'])
  })
})

describe('useChatSession — outbox', () => {
  // The computer holds a tab's session only once its hydrate ran there; a send that
  // overtakes it fails ("No chat session for tab") and the reply never comes.
  it('a send while the tab hydrates goes out only once the hydrate answered', async () => {
    const { result } = setup()
    let done = false
    await act(async () => {
      void result.current.sendMessage('hi').then(() => {
        done = true
      })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(texts(result)).toEqual(['hi']) // on screen at once
    expect(sent).toEqual([])
    await finishLoad(0, [])
    expect(sent.map((s) => s.message.content)).toEqual([[{ type: 'text', text: 'hi' }]])
    expect(done).toBe(true)
  })

  it('a send during a reload waits for the reload’s hydrate, not just the first one', async () => {
    const { result } = setup()
    await finishLoad(0, [])
    await act(() => result.current.reload())
    await act(async () => {
      void result.current.sendMessage('during reload')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(sent).toEqual([])
    await finishLoad(1, [])
    expect(sent).toHaveLength(1)
  })

  it('a failed hydrate does not hold the send back (it fails or goes out on its own)', async () => {
    const { result } = setup()
    await act(async () => {
      void result.current.sendMessage('hi')
      loads[0].hydrate.reject(new Error('computer offline'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(sent).toHaveLength(1)
  })

  it('a send carries a client id + content blocks and is confirmed by that id', async () => {
    const { result } = setup()
    await finishLoad(0, [])
    await act(() => result.current.sendMessage('hi'))
    expect(sent).toHaveLength(1)
    const { id, content } = sent[0].message
    expect(content).toEqual([{ type: 'text', text: 'hi' }])
    live(0, { kind: 'user-message', id, text: 'hi', content })
    liveOnly(0, 1, { kind: 'user-message-delivery', id, state: 'sending' })
    live(1, { kind: 'user-message-delivery', id, state: 'delivered' })
    const items = result.current.timeline.filter((it) => it?.kind === 'user-text')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id, delivery: 'delivered', optimistic: false })
  })

  it('a send the hub never got stays on screen as failed; Retry sends the same id again', async () => {
    const { result } = setup()
    await finishLoad(0, [])
    sendFails = new Error('hub unreachable')
    await act(async () => {
      await result.current.sendMessage('hi').catch(() => undefined)
    })
    const item = result.current.timeline.find((it) => it?.kind === 'user-text')
    expect(item).toMatchObject({ text: 'hi', delivery: 'failed', deliveryError: 'hub unreachable' })
    expect(result.current.inFlight).toBe(false)
    sendFails = null
    const id = sent[0].message.id
    await act(() => result.current.retryMessage(id))
    expect(sent[0].operationId).toBeTypeOf('string')
    expect(sent[1].operationId).toBeTypeOf('string')
    expect(sent[1].operationId).not.toBe(sent[0].operationId)
    expect(sent.map((s) => s.message.id)).toEqual([id, id])
    expect(result.current.timeline.find((it) => it?.kind === 'user-text')).toMatchObject({
      delivery: 'queued'
    })
  })
})

describe('useChatSession — stream fragments, one render per frame (plan 3.2)', () => {
  /** rAF under test control: queued callbacks run on `frame()`. */
  function controlFrames() {
    const queued: FrameRequestCallback[] = []
    const raf = vi.fn((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    })
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    return {
      raf,
      frame: () =>
        act(() => {
          for (const cb of queued.splice(0)) cb(performance.now())
        })
    }
  }
  const streamStart = [
    { kind: 'stream-message-start', messageId: 'm0' },
    { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  ]
  const textDelta = (text: string) => ({
    kind: 'stream-block-delta',
    blockIndex: 0,
    deltaType: 'text',
    text
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fragments of one frame are applied together, in one render', async () => {
    const frames = controlFrames()
    const { result: r } = setup()
    await finishLoad(0, [{ seq: 0, event: userMsg('one') }])
    // The open's own frames (its painted-rows timing, `chat-open-timing.ts`) first.
    frames.frame()
    frames.frame()
    frames.raf.mockClear()
    liveOnly(0, 1, streamStart[0])
    liveOnly(0, 2, streamStart[1])
    liveOnly(0, 3, textDelta('Hel'))
    liveOnly(0, 4, textDelta('lo'))
    // Nothing yet: one frame is asked for, once.
    expect(replies(r)).toEqual([])
    expect(frames.raf).toHaveBeenCalledTimes(1)
    const before = r.current
    frames.frame()
    expect(replies(r)).toEqual(['Hello'])
    expect(r.current).not.toBe(before)
  })

  it('a saved event flushes the pending fragments first (order kept)', async () => {
    controlFrames()
    const { result: r } = setup()
    await finishLoad(0, [{ seq: 0, event: userMsg('one') }])
    liveOnly(0, 1, streamStart[0])
    liveOnly(0, 2, streamStart[1])
    liveOnly(0, 3, textDelta('Hello'))
    live(1, { kind: 'assistant-text', messageId: 'm0', text: 'Hello world' })
    expect(replies(r)).toEqual(['Hello world'])
    expect(r.current.timeline.filter((it) => it?.kind === 'text')).toHaveLength(1)
  })

  it('a reload drops the old load’s pending fragments', async () => {
    const frames = controlFrames()
    const { result: r, rerender } = setup()
    await finishLoad(0, [{ seq: 0, event: userMsg('one') }])
    liveOnly(0, 1, streamStart[0])
    liveOnly(0, 2, streamStart[1])
    liveOnly(0, 3, textDelta('stale'))
    rerender({ cwd: '/elsewhere' })
    await finishLoad(1, [{ seq: 0, event: userMsg('one') }])
    frames.frame()
    expect(replies(r)).toEqual([])
  })
})

describe('useChatSession — a turn the agent starts by itself', () => {
  const finished = (): Buffered => [
    { seq: 0, event: userMsg('run it in the background') },
    { seq: 1, event: { kind: 'assistant-text', messageId: 'm1', text: 'started' } },
    result(2)
  ]

  it('claude-chat: reads in flight from its first output to its result', async () => {
    const { result: r } = setup()
    await finishLoad(0, saved(finished()))
    expect(r.current.inFlight).toBe(false)
    live(3, { kind: 'turn-init', sessionId: 's', model: 'm', cwd: '/repo', tools: [] })
    expect(r.current.inFlight).toBe(false)
    live(4, { kind: 'assistant-text', messageId: 'm2', text: 'the loop finished' })
    expect(r.current.inFlight).toBe(true)
    live(5, result(5).event)
    expect(r.current.inFlight).toBe(false)
  })

  it('codex-chat: unchanged — output after a result never reads in flight', async () => {
    const { result: r, rerender } = setup()
    rerender({ cwd: '/repo', mode: 'codex-chat' })
    await finishLoad(loads.length - 1, saved(finished()))
    live(3, { kind: 'assistant-text', messageId: 'm2', text: 'late item' })
    expect(r.current.inFlight).toBe(false)
  })
})

describe('opening a saved session', () => {
  it('reduces the whole history in ONE batch, not one dispatch per event', async () => {
    const history: Buffered = Array.from({ length: 300 }, (_, i) => ({
      seq: i,
      event: i % 2 === 0 ? userMsg(`m${i}`) : result(i).event
    }))
    const { result: r } = setup()
    reducerActions.clear()
    await finishLoad(0, history)
    expect(r.current.hydrating).toBe(false)
    expect(texts(r)).toHaveLength(150)
    const historyEvents = new Set(history.map((b) => b.event))
    const single = [...reducerActions].filter(
      (a) => a.type === 'event' && historyEvents.has((a as { event?: unknown }).event)
    )
    expect(single).toHaveLength(0)
    const batches = [...reducerActions].filter((a) => a.type === 'events')
    expect(batches).toHaveLength(1)
    expect(batches[0].events).toHaveLength(300)
  })
})

describe('row times', () => {
  it('rows show when their events were saved — from the replay and from live saved events', async () => {
    const { result: r } = setup()
    await finishLoad(0, [
      { seq: 0, event: userMsg('first'), at: 1_000 },
      { seq: 1, event: result(1).event, at: 2_000 }
    ])
    live(2, userMsg('second'), 3_000)
    const users = r.current.timeline.filter((it) => it?.kind === 'user-text')
    expect(users.map((it) => it.timestamp)).toEqual([1_000, 3_000])
  })
})

describe('paged history (opened from the hub projection)', () => {
  const PAGE = 4
  const saved = (events: AgentEvent[]) =>
    events.map((event, seq) => ({ seq, event, at: 5_000 + seq }))
  const stateAt = (all: ReturnType<typeof saved>, seq: number) => {
    const upTo = all.slice(0, seq + 1)
    return realReducer(realInitial({ agentStartedTurns: true }), {
      type: 'events',
      events: upTo.map((b) => b.event),
      at: upTo.map((b) => b.at),
      seq: upTo.map((b) => b.seq)
    })
  }
  /** A hub whose projection is a full replay of `all` (rows served as of any seq). */
  function fakeHub(all: ReturnType<typeof saved>, openAt: number) {
    const calls = { opens: 0, pages: [] as Array<{ pages: number[]; asOfSeq: number }> }
    let expireNext = false
    const h: FakeHub & { calls: typeof calls; expireNext(): void } = {
      calls,
      expireNext: () => {
        expireNext = true
      },
      open: async () => {
        calls.opens++
        const st = stateAt(all, openAt)
        const sealed = Math.max(0, Math.floor(st.timeline.length / PAGE) - 2)
        return {
          kind: 'paged',
          snapshot: {
            seq: openAt,
            epoch: st.rowsEpoch,
            pageRows: PAGE,
            state: encodeTimelineState(st, sealed * PAGE),
            summaries: Array.from({ length: sealed }, (_, p) =>
              summarizeRows(st.timeline.slice(p * PAGE, (p + 1) * PAGE) as TimelineItem[], p * PAGE)
            )
          },
          events: [],
          live: { afterSeq: openAt, liveSeq: 0, events: [] }
        }
      },
      pages: async ({ pages, asOfSeq }) => {
        calls.pages.push({ pages, asOfSeq })
        if (expireNext) {
          expireNext = false
          return { expired: true }
        }
        const st = stateAt(all, asOfSeq)
        return {
          expired: false,
          pages: pages.map((page) => ({
            page,
            from: page * PAGE,
            rows: st.timeline.slice(page * PAGE, (page + 1) * PAGE)
          }))
        }
      }
    }
    return h
  }
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
    })
  const openPaged = async (i: number) => {
    await act(async () => {
      loads[i].hydrate.resolve()
    })
    await settle()
  }
  /** Meaning, not the indexes' layout. */
  const meaning = (st: unknown) =>
    JSON.parse(
      JSON.stringify(st, (_k, v: unknown) => {
        if (v instanceof Map) return { $map: [...v.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
        if (v && typeof v === 'object' && !Array.isArray(v) && 'entries' in v) {
          const idx = v as { entries(): Iterable<[string, unknown]> }
          return { $index: [...idx.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
        }
        return v
      })
    )
  const all = saved(buildLongSession({ events: 240, seed: 2 }))

  it('opens from the snapshot: newest rows here, older pages unloaded; loading them all = a full replay', async () => {
    const h = fakeHub(all, all.length - 1)
    hub = h
    const { result: r } = setup()
    await openPaged(0)
    expect(r.current.hydrating).toBe(false)
    const paging = r.current.paging!
    expect(paging.pageRows).toBe(PAGE)
    expect(paging.sealed).toBeGreaterThan(10)
    expect(r.current.timeline.slice(0, PAGE).every((it) => it === undefined)).toBe(true)
    expect(r.current.timeline.at(-1)).toBeDefined()
    act(() => r.current.loadPages(Array.from({ length: paging.sealed }, (_, p) => p)))
    await settle()
    expect(meaning(r.current.state)).toEqual(meaning(stateAt(all, all.length - 1)))
    // As of the events it applied.
    expect(h.calls.pages[0].asOfSeq).toBe(all.length - 1)
    // Dropped again: rows gone, meaning kept.
    act(() => r.current.unloadPages([0, 1]))
    expect(r.current.timeline.slice(0, 2 * PAGE).every((it) => it === undefined)).toBe(true)
  })

  it('applies the setting on open and older page loads without reopening the chat on toggle', async () => {
    const h = fakeHub(all, all.length - 1)
    const open = h.open
    h.open = async (input) => {
      const reply = (await open(input)) as {
        snapshot: { toolPreviews?: true; displaySettings?: typeof CHAT_HISTORY_DISPLAY_VERSION }
      }
      reply.snapshot.toolPreviews = true
      reply.snapshot.displaySettings = CHAT_HISTORY_DISPLAY_VERSION
      return reply
    }
    hub = h
    const opens = vi.spyOn(client.chat.openTimeline, 'query')
    const pages = vi.spyOn(client.chat.timelinePages, 'query')
    const { result, rerender } = setup(true)
    await openPaged(0)
    expect(opens).toHaveBeenCalledWith(
      expect.objectContaining({ display: { hideThinking: true, windowed: true, packedOpen: true } })
    )
    act(() => result.current.loadPages([0]))
    await settle()
    expect(pages).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: { hideThinking: true } })
    )
    rerender({ cwd: '/repo', hideThinking: false })
    act(() => result.current.loadPages([1]))
    await settle()
    expect(pages.mock.lastCall?.[0]).not.toHaveProperty('display')
    expect(opens).toHaveBeenCalledTimes(1)
    expect(loads).toHaveLength(1)
  })

  it('pages an answer left out (over its byte budget) are asked for again at once', async () => {
    const h = fakeHub(all, all.length - 1)
    const pagesOf = h.pages
    // The computer answers at most two pages per request; the rest are `omitted`.
    h.pages = async (input) => {
      const got = (await pagesOf(input)) as {
        expired: false
        pages: Array<{ page: number }>
      }
      return { ...got, pages: got.pages.slice(0, 2), omitted: input.pages.slice(2) }
    }
    hub = h
    const { result: r } = setup()
    await openPaged(0)
    const paging = r.current.paging!
    act(() => r.current.loadPages(Array.from({ length: paging.sealed }, (_, p) => p)))
    await settle()
    expect(meaning(r.current.state)).toEqual(meaning(stateAt(all, all.length - 1)))
    expect(h.calls.pages.length).toBeGreaterThan(Math.ceil(paging.sealed / 32))
  })

  it('a page larger than an answer comes in row slices, asked again from `next` until complete', async () => {
    const h = fakeHub(all, all.length - 1)
    const pagesOf = h.pages
    const starts: Array<number | undefined> = []
    // The computer answers at most a third of a page, from `startRow` on; without
    // one (an older client) whole pages, as before.
    h.pages = async (input) => {
      const { startRow } = input as { startRow?: number }
      starts.push(startRow)
      const got = (await pagesOf(input)) as {
        expired: false
        pages: Array<{ page: number; from: number; rows: unknown[] }>
      }
      if (startRow === undefined) return got
      const first = got.pages[0]
      const skip = Math.max(0, startRow - first.from)
      const rows = first.rows.slice(skip, skip + Math.ceil(PAGE / 3))
      const end = skip + rows.length
      const partial = end < first.rows.length
      return {
        expired: false,
        pages: [{ page: first.page, from: first.from + skip, rows }],
        ...(partial || input.pages.length > 1
          ? { omitted: partial ? input.pages : input.pages.slice(1) }
          : {}),
        ...(partial ? { next: first.from + end } : {})
      }
    }
    hub = h
    const { result: r } = setup()
    await openPaged(0)
    const paging = r.current.paging!
    act(() => r.current.loadPages(Array.from({ length: paging.sealed }, (_, p) => p)))
    await settle()
    expect(meaning(r.current.state)).toEqual(meaning(stateAt(all, all.length - 1)))
    expect(starts.length).toBeGreaterThan(paging.sealed)
    expect(starts.every((s) => s !== undefined)).toBe(true)
    expect(starts.some((s) => s! % PAGE !== 0)).toBe(true)
  })

  it('a live event that needs an old row waits for its page, then applies — as a full replay would', async () => {
    const head = all.slice(0, 200)
    const firstTool = stateAt(all, 199).timeline.findIndex((it) => it?.kind === 'tool')
    const toolRow = stateAt(all, 199).timeline[firstTool] as Extract<TimelineItem, { kind: 'tool' }>
    const late = {
      seq: 200,
      at: 9_999,
      event: {
        kind: 'tool-result',
        toolUseId: toolRow.invocation.id,
        isError: false,
        rawContent: 'late',
        structured: null
      } as AgentEvent
    }
    const withLate = [...head, late]
    const h = fakeHub(withLate, 199)
    hub = h
    const { result: r } = setup()
    await openPaged(0)
    expect(r.current.timeline[firstTool]).toBeUndefined()
    act(() => subs.event!({ tabId: 'tab-1', event: late.event, seq: late.seq, at: late.at }))
    await settle()
    expect(r.current.state.stalled).toBeNull()
    expect(h.calls.pages.at(-1)).toEqual({ pages: [Math.floor(firstTool / PAGE)], asOfSeq: 199 })
    expect((r.current.timeline[firstTool] as typeof toolRow).invocation.result?.rawContent).toBe(
      'late'
    )
    act(() => r.current.loadPages(Array.from({ length: r.current.paging!.sealed }, (_, p) => p)))
    await settle()
    expect(meaning(r.current.state)).toEqual(meaning(stateAt(withLate, 200)))
  })

  it('rows that no longer fit (expired) open the tab again', async () => {
    const h = fakeHub(all, all.length - 1)
    hub = h
    const { result: r } = setup()
    await openPaged(0)
    h.expireNext()
    act(() => r.current.loadPages([0]))
    await settle()
    expect(loads).toHaveLength(2)
    await openPaged(1)
    expect(h.calls.opens).toBe(2)
    expect(r.current.hydrating).toBe(false)
  })

  it('a message sent while the tab opens stays (on top of the opened state)', async () => {
    hub = fakeHub(all, all.length - 1)
    const { result: r } = setup()
    await act(async () => {
      void r.current.sendMessage('typed while it opened').catch(() => undefined)
    })
    await openPaged(0)
    const last = r.current.timeline.at(-1)
    expect(last?.kind === 'user-text' && last.text).toBe('typed while it opened')
  })
})

describe('manual/reconnect reload', () => {
  it('exposes a history error and clears it after a successful reconnect', async () => {
    const { result } = setup()
    await act(async () => {
      bufferLoad = 0
      loads[0].buffer.reject(new Error('Computer offline'))
      loads[0].hydrate.resolve()
    })
    expect(result.current.loadError).toBe('Computer offline')
    expect(result.current.hydrating).toBe(false)
    await act(() => result.current.reload())
    await finishLoad(1, [])
    expect(result.current.loadError).toBeNull()
    expect(result.current.hydrating).toBe(false)
    expect(sent).toEqual([])
  })
  it('keeps failed messages with attachments and messages composed during a full reload', async () => {
    const { result } = setup()
    await finishLoad(0, [])
    const attachment = {
      artifactId: 'file',
      name: 'notes.txt',
      kind: 'text' as const,
      mediaType: 'text/plain' as const,
      size: 5
    }
    sendFails = new Error('computer offline')
    await act(async () => {
      await result.current
        .sendMessage([
          { type: 'attachment', attachment },
          { type: 'text', text: 'keep me' }
        ])
        .catch(() => undefined)
    })
    const id = sent[0].message.id
    await act(() => result.current.reload())
    expect(result.current.hydrating).toBe(true)
    sendFails = null
    await act(async () => {
      void result.current.sendMessage('typed during reconnect')
    })
    await finishLoad(1, [])
    expect(result.current.timeline.filter((i) => i?.kind === 'user-text')).toMatchObject([
      { id, text: 'keep me', attachments: [attachment], delivery: 'failed' },
      { text: 'typed during reconnect', optimistic: true }
    ])
    await act(() => result.current.retryMessage(id))
    expect(sent.at(-1)?.message.content).toEqual([
      { type: 'attachment', attachment },
      { type: 'text', text: 'keep me' }
    ])
    expect(sent.at(-1)?.operationId).not.toBe(sent[0].operationId)
  })
  it('uses a canonical message instead of restoring its older failed copy', async () => {
    const { result } = setup()
    await finishLoad(0, [])
    sendFails = new Error('lost acknowledgement')
    await act(async () => {
      await result.current.sendMessage('accepted remotely').catch(() => undefined)
    })
    const id = sent[0].message.id
    await act(() => result.current.reload())
    await finishLoad(1, [
      { seq: 0, event: { kind: 'user-message', id, text: 'accepted remotely' } },
      { seq: 1, event: { kind: 'user-message-delivery', id, state: 'delivered' } }
    ])
    const rows = result.current.timeline.filter((i) => i?.kind === 'user-text')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, delivery: 'delivered' })
    expect(rows[0]).not.toMatchObject({ optimistic: true })
  })
})

// 2026-11-14: one whole-history answer (202 MB) closed the computer's socket. A full
// replay (no usable projection) is read in bounded pages, and applied once.
describe('full replay in bounded pages', () => {
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
    })
  const many: Buffered = Array.from({ length: 30 }, (_, seq) => ({
    seq,
    event: userMsg(`m${seq}`)
  }))

  it('reads every page, carries on after the last event of each, applies the whole history in one batch', async () => {
    const asked: Array<{ afterSeq: number; page?: unknown }> = []
    vi.spyOn(client.chat.getReplay, 'query').mockImplementation(((input: {
      afterSeq: number
      page?: unknown
    }) => {
      asked.push(input)
      const rest = many.filter((e) => e.seq > input.afterSeq)
      const events = rest.slice(0, 7)
      const hasMore = rest.length > 7
      return Promise.resolve(
        hasMore ? { events, hasMore } : { events, hasMore, live: saved(many).live }
      )
    }) as never)
    const { result } = setup()
    await act(async () => {
      loads[0].hydrate.resolve()
    })
    await settle()
    expect(asked.map((a) => a.afterSeq)).toEqual([-1, 6, 13, 20, 27])
    for (const a of asked) expect(a.page).toBeDefined()
    expect(texts(result)).toEqual(many.map((e) => (e.event as { text: string }).text))
    expect(result.current.hydrating).toBe(false)
    // One reducer batch for the whole history (one render), as before paging.
    const batches = [...reducerActions].filter(
      (a) => a.type === 'events' && (a.events?.length ?? 0) > 0
    )
    expect(batches.some((a) => a.events!.length === many.length)).toBe(true)
  })

  it('an older hub answers the whole replay at once (no hasMore): that is the only page', async () => {
    const replay = vi.spyOn(client.chat.getReplay, 'query')
    const { result } = setup()
    await finishLoad(0, HISTORY)
    expect(replay).toHaveBeenCalledTimes(1)
    expect(texts(result)).toEqual(['one', 'two'])
  })
})

describe('reconnect: the panel catches up with the server, never keeps a stale turn state', () => {
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
    })
  const status = (epoch: string, state: 'idle' | 'running', revision: number) => ({
    kind: 'turn-status',
    authoritative: true,
    epoch,
    revision,
    state,
    reportedState: state,
    turnOpen: state === 'running',
    mainTurnOpen: state === 'running',
    pendingRequestIds: [],
    outboxInFlight: 0
  })
  const opened: Replay = {
    events: [
      { seq: 0, event: userMsg('one') },
      { seq: 1, event: userMsg('two') }
    ],
    live: { afterSeq: 1, liveSeq: 4, events: [status('a', 'running', 3)] }
  }
  const replies = (answer: Replay) => {
    const asked: number[] = []
    vi.spyOn(client.chat.getReplay, 'query').mockImplementation(((input: { afterSeq: number }) => {
      asked.push(input.afterSeq)
      return Promise.resolve(answer)
    }) as never)
    return asked
  }

  it('a restarted hub stream reads what was missed, the current turn status with it', async () => {
    const { result } = setup()
    await finishLoad(0, opened)
    expect(result.current.inFlight).toBe(true)
    // Away: the turn ended and a message was saved; neither reached this panel.
    const asked = replies({
      events: [{ seq: 2, event: userMsg('three') }],
      live: { afterSeq: 2, liveSeq: 6, events: [status('a', 'idle', 5)] }
    })
    act(() => started.event?.())
    await settle()
    expect(asked).toEqual([1])
    expect(texts(result)).toEqual(['one', 'two', 'three'])
    expect(result.current.state.turnStatus).toMatchObject({ state: 'idle', revision: 5 })
    expect(result.current.inFlight).toBe(false)
    // Caught up, not reloaded: no reset, no loading frame.
    expect(result.current.hydrating).toBe(false)
    expect([...reducerActions].some((a) => a.type === 'reset')).toBe(false)
  })

  it('a status from a restarted computer (another epoch, its live counter starting over) catches up', async () => {
    const { result } = setup()
    await finishLoad(0, opened)
    const asked = replies({
      events: [],
      live: { afterSeq: 1, liveSeq: 1, events: [status('b', 'idle', 1)] }
    })
    act(() => subs.event?.({ tabId: 'tab-1', seq: 1, live: 1, event: status('b', 'idle', 1) }))
    await settle()
    expect(asked).toEqual([1])
    expect(result.current.state.turnStatus).toMatchObject({ epoch: 'b', state: 'idle' })
    expect(result.current.inFlight).toBe(false)
    // The new instance's next live event applies (its counter, not the old one's).
    act(() => subs.event?.({ tabId: 'tab-1', seq: 1, live: 2, event: status('b', 'running', 2) }))
    await settle()
    expect(result.current.state.turnStatus).toMatchObject({ epoch: 'b', state: 'running' })
  })

  it('a live event after a saved event this panel never got catches up', async () => {
    const { result } = setup()
    await finishLoad(0, opened)
    const asked = replies({
      events: [{ seq: 2, event: userMsg('three') }],
      live: { afterSeq: 2, liveSeq: 7, events: [status('a', 'running', 6)] }
    })
    act(() => subs.event?.({ tabId: 'tab-1', seq: 2, live: 7, event: status('a', 'running', 6) }))
    await settle()
    expect(asked).toEqual([1])
    expect(texts(result)).toEqual(['one', 'two', 'three'])
  })

  it('says it is reconnecting while the stream is down and while it catches up, not before', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, opened)
    expect(result.current.reconnecting).toBe(false)
    // The routine catch-up when the stream first starts is not shown.
    const answer = deferred<Replay>()
    vi.spyOn(client.chat.getReplay, 'query').mockImplementation((() => answer.promise) as never)
    act(() => started.event?.())
    expect(result.current.reconnecting).toBe(false)
    await act(async () =>
      answer.resolve({ events: [], live: { afterSeq: 1, liveSeq: 4, events: [] } })
    )
    await settle()
    // The socket drops: tRPC reconnects it.
    streamStatus = 'connecting'
    rerender({ cwd: '/repo' })
    expect(result.current.reconnecting).toBe(true)
    // Back: the catch-up runs, still not in step until it lands.
    streamStatus = 'pending'
    const back = deferred<Replay>()
    vi.spyOn(client.chat.getReplay, 'query').mockImplementation((() => back.promise) as never)
    rerender({ cwd: '/repo' })
    act(() => started.event?.())
    expect(result.current.reconnecting).toBe(true)
    await act(async () =>
      back.resolve({
        events: [],
        live: { afterSeq: 1, liveSeq: 6, events: [status('a', 'idle', 5)] }
      })
    )
    await settle()
    expect(result.current.reconnecting).toBe(false)
    expect(result.current.inFlight).toBe(false)
  })

  it('a server behind this panel (its log restarted, or it lost the tab) reloads', async () => {
    const { result } = setup()
    await finishLoad(0, opened)
    replies({ events: [], live: { afterSeq: -1, liveSeq: 0, events: [] } })
    act(() => started.event?.())
    await settle()
    expect(loads).toHaveLength(2)
    expect(result.current.hydrating).toBe(true)
  })
})
