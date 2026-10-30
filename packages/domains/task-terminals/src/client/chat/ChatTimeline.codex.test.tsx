// @vitest-environment jsdom
/**
 * Codex chat shares the timeline: under virtualization (plan 4.1) a long Codex
 * session still renders, opens at the bottom, searches every row (mounted or
 * not), reveals a match far up, and keeps its place across a hidden tab.
 *
 * The events have the exact shapes `codex-chat-session.ts` emits: the
 * handshake `turn-init`, replies bridged onto `stream-*` events (one message per
 * Codex item), `codex/commandExecution` / `codex/fileChange` tool calls with
 * the item as `structured`, `agent-plan`, and a `result` with no text.
 */
import type React from 'react'
import { vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { TimelineItem } from '@slayzone/terminal/client'

vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
const fakeTrpc = {
  settings: { set: { mutationOptions: () => ({ mutationFn: async () => undefined }) } },
  chat: {
    stopCommandTask: { mutationOptions: (o: object) => ({ ...o, mutationFn: async () => {} }) },
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

const { useMemo, useState } = await import('react')
const { act, cleanup, render } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const terminal = await import('@slayzone/terminal/client')
const { reducer, initialState } = await import('@slayzone/terminal/reducer')
const { ChatTimeline } = await import('./ChatTimeline')
const { ChatViewContext } = await import('./ChatViewContext')
const { CommandTaskContext } = await import('./tool-cards')
const { useFollowBottom } = await import('./useFollowBottom')
const { useChatDisplay } = await import('./useChatDisplay')
const { installTimelineLayout } = await import('./__tests__/timeline-layout')

/** `turns` Codex turns, each: prompt, a shell command, a file change, a plan, the reply. */
function codexSession(turns: number): AgentEvent[] {
  const events: AgentEvent[] = [
    // The app-server handshake: Codex's synthetic turn-init before any message.
    { kind: 'turn-init', sessionId: 'thread-1', model: 'gpt-5-codex', cwd: '/repo', tools: [] }
  ]
  for (let i = 0; i < turns; i++) {
    const reply = i === 7 ? `the walrus lives in turn ${i}` : `done with turn ${i}`
    events.push(
      { kind: 'user-message', text: `codex question ${i}` },
      {
        kind: 'tool-call',
        id: `cmd-${i}`,
        name: 'codex/commandExecution',
        input: { command: `ls -la dir${i}`, cwd: '/repo' }
      },
      {
        kind: 'tool-result',
        toolUseId: `cmd-${i}`,
        isError: false,
        rawContent: `file${i}.ts`,
        structured: {
          type: 'commandExecution',
          id: `cmd-${i}`,
          status: 'completed',
          aggregatedOutput: `file${i}.ts`
        }
      },
      {
        kind: 'tool-call',
        id: `fc-${i}`,
        name: 'codex/fileChange',
        input: { changes: [{ path: `/repo/f${i}.ts`, kind: 'update' }] }
      },
      {
        kind: 'tool-result',
        toolUseId: `fc-${i}`,
        isError: false,
        rawContent: '',
        structured: { type: 'fileChange', id: `fc-${i}`, status: 'completed' }
      },
      {
        kind: 'agent-plan',
        steps: [{ step: `step for ${i}`, status: 'completed' }]
      } as AgentEvent,
      { kind: 'stream-message-start', messageId: `msg-${i}` },
      { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
      { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: reply },
      { kind: 'stream-block-stop', blockIndex: 0 },
      { kind: 'stream-message-stop' },
      {
        kind: 'result',
        subtype: 'completed',
        isError: false,
        durationMs: 10,
        durationApiMs: 10,
        numTurns: 1,
        totalCostUsd: 0,
        stopReason: null,
        terminalReason: null,
        text: null,
        modelUsage: {},
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        permissionDenials: []
      } as AgentEvent
    )
  }
  return events
}

let display: ReturnType<typeof useChatDisplay> | null = null

function Harness({ events, hidden = false }: { events: AgentEvent[]; hidden?: boolean }) {
  const [state] = useState(() => reducer(initialState(), { type: 'events', events }))
  const [store] = useState(() => new terminal.LiveBlockStore())
  const follow = useFollowBottom()
  const d = useChatDisplay({
    timeline: state.timeline,
    finalOnly: false,
    showLastMessageTools: false,
    follow
  })
  display = d
  const view = useMemo(
    () => ({
      collapseSignal: 0,
      finalOnly: false,
      fileEditsOpenByDefault: true,
      showMessageMeta: true,
      search: { query: d.search.query, caseSensitive: false },
      timeline: state.timeline,
      childIndex: state.childIndex
    }),
    [state.timeline, state.childIndex, d.search.query]
  )
  const scope = useMemo(() => ({ tabId: 'tab', active: true }), [])
  const noop = () => {}
  return (
    <div style={hidden ? { display: 'none' } : undefined}>
      <ChatViewContext.Provider value={view}>
        <terminal.LiveBlockStoreContext.Provider value={store}>
          <CommandTaskContext.Provider value={scope}>
            <ChatTimeline
              search={d.search}
              state={state}
              hydrating={false}
              isEmpty={false}
              inFlight={false}
              awaitingUser={false}
              appearance={{ chatWidth: 'narrow' } as never}
              items={d.displayedTimeline}
              virtual={d.virtual}
              scrollRef={d.virtual.bindScroller}
              itemKey={d.itemKey}
              contentRef={follow.contentRef}
              isAtBottom={follow.isAtBottom}
              scrollToBottom={follow.scrollToBottom}
              sendMessage={async () => {}}
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
    </div>
  )
}

let layout: ReturnType<typeof installTimelineLayout>

async function settle(frames = 6): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      layout.flushResize()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
}

const mounted = (): TimelineItem[] => {
  const rows = document.querySelectorAll<HTMLElement>('[data-virtual-list] > [data-index]')
  return Array.from(rows).map((r) => display!.displayedTimeline[Number(r.dataset.index)])
}

beforeEach(() => {
  layout = installTimelineLayout({ viewport: 600, rowHeight: () => 60 })
})
afterEach(() => {
  cleanup()
  layout.restore()
  display = null
})

describe('Codex chat on the virtualized timeline', () => {
  it('renders a long Codex session at the bottom, mounting only the rows in view', async () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <Harness events={codexSession(400)} />
      </QueryClientProvider>
    )
    await settle()
    const rows = mounted()
    expect(display!.displayedTimeline.length).toBeGreaterThan(2_000)
    expect(rows.length).toBeLessThan(60)
    // The last turn's reply, its plan and its command card are on screen.
    expect(document.body.textContent).toContain('done with turn 399')
    expect(document.body.textContent).toContain('ls -la dir399')
    expect(rows.some((r) => r.kind === 'plan')).toBe(true)
  })

  it('search counts a match in an unmounted row and reveals it', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={codexSession(400)} />
      </QueryClientProvider>
    )
    await settle()
    expect(document.body.textContent).not.toContain('the walrus lives')
    act(() => display!.search.setQuery('walrus'))
    expect(display!.search.matchCount).toBe(1)
    await settle()
    expect(document.body.textContent).toContain('the walrus lives in turn 7')
  })

  it('keeps its place across a hidden tab', async () => {
    const events = codexSession(300)
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} />
      </QueryClientProvider>
    )
    await settle()
    layout.scroller()!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    layout.scrollTo(30_000)
    await settle()
    const top = layout.scroller()!.scrollTop
    const before = mounted().map((r) => display!.itemKey(r, 0))
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} hidden />
      </QueryClientProvider>
    )
    await settle()
    layout.scroller()!.scrollTop = 0
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} />
      </QueryClientProvider>
    )
    await settle()
    expect(layout.scroller()!.scrollTop).toBe(top)
    expect(mounted().map((r) => display!.itemKey(r, 0))).toEqual(before)
  })
})
