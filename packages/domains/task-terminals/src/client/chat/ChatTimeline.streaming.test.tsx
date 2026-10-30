// @vitest-environment jsdom
/**
 * Plan 3.2 performance contract: a stream delta re-renders the ONE row that
 * streams — never the timeline. Driven like ChatPanel drives it (the reducer's
 * state, `state.live` published to the panel's LiveBlockStore in a layout
 * effect, the real ChatTimeline + renderers, compiled by the React Compiler as
 * they ship), counting which components actually ran per commit through a fake
 * React DevTools hook (`PerformedWork` on each fiber).
 */
import type React from 'react'
import { vi } from 'vitest'

/** Component name → renders in the commits since the last `reset`. */
const rendered = vi.hoisted(() => {
  const counts = new Map<string, number>()
  /** Text rows that rendered, by messageId. */
  const textRows = new Map<string, number>()
  const PERFORMED_WORK = 1
  type Fiber = {
    type: unknown
    flags: number
    alternate: Fiber | null
    child: Fiber | null
    sibling: Fiber | null
    memoizedProps: { item?: { messageId?: string } } | null
  }
  const nameOf = (type: unknown): string | null => {
    if (typeof type === 'function') return (type as { name?: string }).name || null
    if (type && typeof type === 'object') {
      const t = type as { type?: unknown; render?: unknown; displayName?: string }
      if (t.displayName) return t.displayName
      return nameOf(t.type ?? t.render)
    }
    return null
  }
  const walk = (fiber: Fiber | null): void => {
    for (let f = fiber; f; f = f.sibling) {
      // Ran in this commit (an update, not a mount: mounts have no alternate).
      // A bailed-out subtree keeps its fibers — and their flags from the commit
      // they last rendered in — so the flag is cleared once counted.
      const ran = f.alternate !== null && (f.flags & PERFORMED_WORK) !== 0
      f.flags &= ~PERFORMED_WORK
      if (ran) {
        const name = nameOf(f.type)
        if (name) {
          counts.set(name, (counts.get(name) ?? 0) + 1)
          if (name === 'AssistantText') {
            const id = f.memoizedProps?.item?.messageId ?? '?'
            textRows.set(id, (textRows.get(id) ?? 0) + 1)
          }
        }
      }
      walk(f.child)
    }
  }
  ;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => walk(root.current.child)
  }
  return {
    counts,
    textRows,
    reset: () => {
      counts.clear()
      textRows.clear()
    }
  }
})

vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
const fakeTrpc = {
  settings: { set: { mutationOptions: () => ({ mutationFn: async () => undefined }) } },
  chat: {
    stopCommandTask: {
      mutationOptions: (o: object) => ({ ...o, mutationFn: async () => undefined })
    },
    backgroundCommandTask: {
      mutationOptions: (o: object) => ({ ...o, mutationFn: async () => true })
    },
    commandTaskOutput: {
      queryOptions: (input: unknown) => ({
        queryKey: ['commandTaskOutput', input],
        queryFn: async () => ({ state: 'gone' })
      })
    }
  }
}
const fakeClient = {
  app: { shell: { openPath: { mutate: vi.fn() }, openExternal: { mutate: vi.fn() } } }
}
vi.mock('../trpc', () => ({ useTRPC: () => fakeTrpc, useTRPCClient: () => fakeClient }))
vi.mock('../../trpc', () => ({ useTRPC: () => fakeTrpc, useTRPCClient: () => fakeClient }))

const { useCallback, useLayoutEffect, useMemo, useReducer, useState } = await import('react')
const { act, cleanup, render } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { afterEach, describe, expect, it } = await import('vitest')
const terminal = await import('@slayzone/terminal/client')
const { reducer, initialState } = await import('@slayzone/terminal/reducer')
const { ChatTimeline } = await import('./ChatTimeline')
const { useFollowBottom } = await import('./useFollowBottom')
const { useVirtualTimeline } = await import('./useVirtualTimeline')
const { installTimelineLayout } = await import('./__tests__/timeline-layout')
const { ChatViewContext } = await import('./ChatViewContext')
const { CommandTaskContext } = await import('./tool-cards')
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { ChatTimelineState, TimelineItem } from '@slayzone/terminal/client'

type Dispatch = (events: AgentEvent[]) => void

/** ChatPanel's part of the loop: reducer state, live store, contexts, ChatTimeline. */
function Harness({
  initial,
  onReady
}: {
  initial: ChatTimelineState
  onReady: (d: Dispatch) => void
}) {
  const [state, dispatch] = useReducer(reducer, initial)
  const [store] = useState(() => new terminal.LiveBlockStore())
  useLayoutEffect(() => {
    store.publish(state.live)
  }, [store, state.live])
  useLayoutEffect(() => {
    onReady((events) => dispatch({ type: 'events', events }))
  }, [onReady])
  const view = useMemo(
    () => ({
      collapseSignal: 0,
      finalOnly: false,
      fileEditsOpenByDefault: true,
      showMessageMeta: true,
      search: { query: '', caseSensitive: false },
      timeline: state.timeline,
      childIndex: state.childIndex
    }),
    [state.timeline, state.childIndex]
  )
  const scope = useMemo(() => ({ tabId: 'tab', active: true }), [])
  const itemKey = useCallback(
    (item: TimelineItem, index: number) => terminal.streamKeyOf(item) ?? `${item.kind}:${index}`,
    []
  )
  const search = useMemo(
    () => ({
      open: false,
      query: '',
      setQuery: () => {},
      caseSensitive: false,
      setCaseSensitive: () => {},
      matchCount: 0,
      activeIdx: -1,
      activeItemIdx: -1,
      matchedIndices: [],
      itemMatches: new Map(),
      next: () => {},
      prev: () => {},
      close: () => {},
      requestOpen: () => {},
      focusToken: 0
    }),
    []
  )
  const noop = useCallback(() => {}, [])
  const asyncNoop = useCallback(async () => {}, [])
  const follow = useFollowBottom()
  const virtual = useVirtualTimeline(follow)
  return (
    <ChatViewContext.Provider value={view}>
      <terminal.LiveBlockStoreContext.Provider value={store}>
        <CommandTaskContext.Provider value={scope}>
          <ChatTimeline
            search={search as never}
            state={state}
            hydrating={false}
            isEmpty={false}
            inFlight
            awaitingUser={false}
            appearance={{ chatWidth: 'narrow' } as never}
            items={state.timeline as TimelineItem[]}
            virtual={virtual}
            scrollRef={virtual.bindScroller}
            itemKey={itemKey}
            contentRef={follow.contentRef}
            isAtBottom
            scrollToBottom={noop}
            sendMessage={asyncNoop}
            copyLastResponse={noop}
            copyAllMessages={noop}
            copySessionId={noop}
            setCollapseSignal={noop}
            handleReset={noop}
            resetting={false}
          />
        </CommandTaskContext.Provider>
      </terminal.LiveBlockStoreContext.Provider>
    </ChatViewContext.Provider>
  )
}

/** A long finished session: `n` turns of user message, reply and a tool call. */
function longSession(n: number): ChatTimelineState {
  const events: AgentEvent[] = [
    { kind: 'turn-init', sessionId: 's', model: 'haiku', cwd: '/r', tools: [] }
  ]
  for (let i = 0; i < n; i++) {
    events.push(
      { kind: 'user-message', text: `question ${i}` },
      { kind: 'assistant-text', messageId: `m${i}`, text: `answer ${i}` },
      { kind: 'tool-call', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } },
      {
        kind: 'tool-result',
        toolUseId: `t${i}`,
        isError: false,
        rawContent: `${i}`,
        structured: null
      }
    )
  }
  events.push({ kind: 'user-message', text: 'stream please' })
  return reducer(initialState(), { type: 'events', events })
}

// A viewport tall enough for every row of these sessions: the virtualized list
// mounts them all, as the paginated one did.
let layout = installTimelineLayout({ viewport: 100_000, rowHeight: () => 40 })
afterEach(() => {
  cleanup()
  rendered.reset()
  layout.restore()
  layout = installTimelineLayout({ viewport: 100_000, rowHeight: () => 40 })
})

describe('a stream delta re-renders only the row that streams', () => {
  it('300 finished rows + a streaming reply: per delta, one AssistantText and nothing else of the timeline', async () => {
    let dispatch: Dispatch = () => {}
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <Harness
          initial={longSession(100)}
          onReady={(d) => {
            dispatch = d
          }}
        />
      </QueryClientProvider>
    )
    // The reply's row appears (a structural change: the timeline grows once).
    act(() =>
      dispatch([
        { kind: 'stream-message-start', messageId: 'm-stream' },
        { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
        { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hel' }
      ])
    )
    rendered.reset()

    const DELTAS = 25
    for (let i = 0; i < DELTAS; i++) {
      await act(async () => {
        dispatch([{ kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: ` w${i}` }])
      })
    }

    // Only the streaming row re-rendered (useDeferredValue may render it twice per delta).
    expect([...rendered.textRows.keys()]).toEqual(['m-stream'])
    expect(rendered.textRows.get('m-stream')).toBeGreaterThanOrEqual(DELTAS)
    expect(rendered.textRows.get('m-stream')).toBeLessThanOrEqual(2 * DELTAS)
    // The rest of the timeline never ran.
    for (const name of [
      'VirtualTimelineRows',
      'TimelineRow',
      'RowContent',
      'UserMessage',
      'ToolRow',
      'BashCard',
      'ToolShell'
    ]) {
      expect(rendered.counts.get(name) ?? 0, name).toBe(0)
    }
    // And the live text is on screen.
    const row = document.querySelector('[data-chat-text][data-streaming="true"]')
    expect(row?.textContent).toContain(`w${DELTAS - 1}`)
  })

  it('the saved block finalizes the row in place: same DOM node, no caret', async () => {
    let dispatch: Dispatch = () => {}
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness
          initial={longSession(3)}
          onReady={(d) => {
            dispatch = d
          }}
        />
      </QueryClientProvider>
    )
    await act(async () => {
      dispatch([
        { kind: 'stream-message-start', messageId: 'm-stream' },
        { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
        { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hello ' },
        { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'world' }
      ])
    })
    const live = document.querySelector('[data-chat-text][data-streaming="true"]')
    expect(live?.textContent).toBe('Hello world')
    await act(async () => {
      dispatch([
        { kind: 'assistant-text', messageId: 'm-stream', text: 'Hello world' },
        { kind: 'stream-block-stop', blockIndex: 0 },
        { kind: 'stream-message-stop' }
      ])
    })
    const rows = document.querySelectorAll('[data-chat-text]')
    const final = rows[rows.length - 1]
    expect(final).toBe(live)
    expect(final.getAttribute('data-streaming')).toBe(null)
    expect(final.textContent).toBe('Hello world')
  })
})
