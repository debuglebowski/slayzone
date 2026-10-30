// @vitest-environment jsdom
// Pins useChatSession's hydrate → replay lifecycle: the loading flag, replay order,
// live events queued during a load, prompts rebuilt by the replay, and stale-load
// isolation. A reload (same tab, new folder / flags) must end in the same timeline a
// fresh open of the tab shows — never the old timeline with the history replayed on top.
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
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
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// One pending hydrate + buffer fetch per load, resolved by the test in its own order.
let loads: Array<{
  cwd: string
  mode: string
  providerFlagsOverride: string | null
  hydrate: Deferred<void>
  buffer: Deferred<Buffered | Replay>
}> = []
const sent: Array<{ tabId: string; message: { id: string; content: unknown } }> = []
let sendFails: Error | null = null
// The load whose hydrate the test just resolved — its buffer fetch follows.
let bufferLoad = -1
const subs: Record<string, ((data: unknown) => void) | null> = { event: null, exit: null }

// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    chat: {
      onEvent: { subscriptionOptions: (_i: unknown, o: object) => ({ ...o, name: 'event' }) },
      onExit: { subscriptionOptions: (_i: unknown, o: object) => ({ ...o, name: 'exit' }) }
    }
  }),
  useTRPCClient: () => client,
  useSubscription: (o: { name: string; enabled: boolean; onData: (d: unknown) => void }) => {
    subs[o.name] = o.enabled ? o.onData : null
  }
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
}

function setup() {
  // Every COMMITTED (cwd, hydrating) pair — a layout effect only runs for a render that
  // reaches the screen.
  const frames: Array<{ cwd: string; hydrating: boolean }> = []
  const hook = renderHook(
    ({ cwd, mode = 'claude-chat', flags = null }: Props) => {
      const r = useChatSession({
        tabId: 'tab-1',
        taskId: 't1',
        mode,
        cwd,
        providerFlagsOverride: flags
      })
      const hydrating = r.hydrating
      useLayoutEffect(() => {
        frames.push({ cwd, hydrating })
      })
      return r
    },
    { initialProps: { cwd: '/repo' } as Props }
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
  cleanup()
  hub = null
  reducerActions.clear()
  loads = []
  bufferLoad = -1
  respondReply = deferred<boolean>()
  respondCalls.length = 0
  sent.length = 0
  sendFails = null
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
    await act(() => result.current.sendMessage('hi'))
    expect(texts(result)).toEqual(['hi'])
    await finishLoad(0, [])
    expect(texts(result)).toEqual(['hi']) // still on screen before the echo lands
    // The server echoes the message with the id the client minted.
    live(0, { kind: 'user-message', id: sent[0].message.id, text: 'hi' })
    expect(texts(result)).toEqual(['hi'])
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
