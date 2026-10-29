// @vitest-environment jsdom
// Pins useChatSession's hydrate → replay lifecycle: the loading flag, replay order,
// live events queued during a load, the permission-request side-channel, and stale-load
// isolation. A reload (same tab, new folder / flags) must end in the same timeline a
// fresh open of the tab shows — never the old timeline with the history replayed on top.
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

type Buffered = Array<{ seq: number; event: unknown }>
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
  buffer: Deferred<Buffered>
}> = []
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
          buffer: deferred<Buffered>()
        }
        loads.push(load)
        return load.hydrate.promise
      }
    },
    getBufferSince: { query: () => loads[bufferLoad].buffer.promise },
    send: { mutate: () => Promise.resolve(true) }
  }
}

const { useChatSession } = await import('./useChatSession')

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

/** Finish load `i`: hydrate resolves, then the buffer fetch returns `buffered`. */
async function finishLoad(i: number, buffered: Buffered): Promise<void> {
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

const live = (seq: number, event: unknown): void =>
  act(() => subs.event!({ tabId: 'tab-1', event, seq }))

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

/** The assistant replies on screen. */
const replies = (r: { current: ReturnType<typeof useChatSession> }): string[] =>
  r.current.timeline.flatMap((it) =>
    it.kind === 'text' && it.role === 'assistant' ? [it.text] : []
  )

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

/** The user messages on screen (the reducer adds its own markers between them). */
const texts = (r: { current: ReturnType<typeof useChatSession> }): string[] =>
  r.current.timeline.flatMap((it) => (it.kind === 'user-text' ? [it.text] : []))

afterEach(() => {
  cleanup()
  loads = []
  bufferLoad = -1
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
    expect([...result.current.permissionRequests.keys()]).toEqual(['tu-1'])
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
    live(0, userMsg('hi'))
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
    expect([...result.current.permissionRequests.keys()]).toEqual(['tu-1'])
  })
})

describe('useChatSession — reload edge cases', () => {
  it('a reload mid-reply keeps the reply streaming, once, and the turn still ends', async () => {
    // The agent is streaming "Hel…" when the flags change; "lo" lands during the reload.
    const midReply: Buffered = [
      { seq: 0, event: userMsg('one') },
      { seq: 1, event: { kind: 'stream-message-start', messageId: 'm0' } },
      { seq: 2, event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' } },
      {
        seq: 3,
        event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hel' }
      }
    ]
    const { result: r, rerender } = setup()
    await finishLoad(0, midReply)
    expect(replies(r)).toEqual(['Hel'])
    expect(r.current.inFlight).toBe(true)

    rerender({ cwd: '/repo', flags: '--verbose' })
    expect(loads[1].providerFlagsOverride).toBe('--verbose')
    live(4, { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'lo' })
    await finishLoad(1, midReply)
    expect(texts(r)).toEqual(['one'])
    expect(replies(r)).toEqual(['Hello'])
    expect(r.current.inFlight).toBe(true)

    live(5, { kind: 'stream-block-stop', blockIndex: 0 })
    live(6, { kind: 'stream-message-stop' })
    live(7, result(7).event)
    expect(replies(r)).toEqual(['Hello'])
    expect(r.current.inFlight).toBe(false)
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
    expect([...r.current.permissionRequests.keys()]).toEqual(['tu-1'])
  })
})

describe('useChatSession — fix behaviour', () => {
  it('a reload drops a permission request the reloaded history no longer has', async () => {
    const { result, rerender } = setup()
    await finishLoad(0, HISTORY)
    rerender({ cwd: '/wt' })
    await finishLoad(1, HISTORY.slice(0, 2))
    expect([...result.current.permissionRequests.keys()]).toEqual([])
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
