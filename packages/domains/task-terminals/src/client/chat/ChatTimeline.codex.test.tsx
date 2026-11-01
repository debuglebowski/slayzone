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
const { act, cleanup, fireEvent, render } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const terminal = await import('@slayzone/terminal/client')
const { reducer, initialState } = await import('@slayzone/terminal/reducer')
const { ChatTimeline } = await import('./ChatTimeline')
const { ChatViewContext } = await import('./ChatViewContext')
const { CommandTaskContext } = await import('./tool-cards')
const { ToolFocusContext, ToolFocusStore } = await import('./tool-cards/tool-focus')
const { appearanceDefaults } = await import('@slayzone/ui')
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

function Harness({
  events,
  hidden = false,
  compactTools = false,
  inFlight = false,
  showSummary = true,
  showLatest = true,
  grouped = false,
  appearanceOverrides
}: {
  events: AgentEvent[]
  hidden?: boolean
  compactTools?: boolean
  inFlight?: boolean
  showSummary?: boolean
  showLatest?: boolean
  grouped?: boolean
  appearanceOverrides?: Partial<typeof appearanceDefaults>
}) {
  const [state] = useState(() => reducer(initialState(), { type: 'events', events }))
  const [store] = useState(() => new terminal.LiveBlockStore())
  const follow = useFollowBottom()
  const d = useChatDisplay({
    timeline: state.timeline,
    finalOnly: compactTools,
    showLastMessageTools: false,
    groupActivity: grouped,
    inFlight,
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
              inFlight={inFlight}
              awaitingUser={false}
              appearance={{
                ...appearanceDefaults,
                chatWidth: 'narrow',
                chatShowToolCallSummary: showSummary,
                chatShowLatestToolCall: showLatest,
                chatShowActivities: showSummary,
                chatPreviewLatestActivity: showLatest,
                ...appearanceOverrides
              }}
              items={d.displayedTimeline}
              hiddenTools={compactTools && !grouped ? state.timeline : undefined}
              activityTurns={d.activityTurns}
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
  vi.unstubAllGlobals()
  display = null
})

describe('Codex chat on the virtualized timeline', () => {
  it('keeps loading visible after an intermediate reply while the agent is still running', async () => {
    const start: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' }
    ]
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <Harness key="before-progress" events={start} grouped inFlight />
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelector('[data-testid="chat-working-indicator"]')).not.toBeNull()
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness
          key="after-progress"
          events={[
            ...start,
            { kind: 'assistant-text', messageId: 'progress', text: 'Checking now' }
          ]}
          grouped
          inFlight
        />
      </QueryClientProvider>
    )
    await settle()
    expect(document.body.textContent).toContain('Checking now')
    expect(document.querySelector('[data-testid="chat-working-indicator"]')).not.toBeNull()
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness
          key="tool-after-progress"
          events={[
            ...start,
            { kind: 'assistant-text', messageId: 'progress', text: 'Checking now' },
            {
              kind: 'tool-call',
              id: 'cmd',
              name: 'codex/commandExecution',
              input: { command: 'git status' }
            }
          ]}
          grouped
          inFlight
        />
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelector('[data-testid="chat-working-indicator"]')).not.toBeNull()
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness
          key="completed"
          events={[
            ...start,
            { kind: 'assistant-text', messageId: 'final', text: 'All done' },
            codexSession(1).at(-1)!
          ]}
          grouped
        />
      </QueryClientProvider>
    )
    await settle()
    expect(document.body.textContent).toContain('All done')
    expect(document.querySelector('[data-testid="chat-working-indicator"]')).toBeNull()
  })

  it('puts recoverable CLI diagnostics under Activities and keeps turn failures visible', async () => {
    const events = codexSession(1)
    const result = events.pop()!
    events.push(
      { kind: 'stderr', text: '\x1b[31mapply_patch verification failed\x1b[0m' },
      { kind: 'error', message: 'API unavailable' },
      result
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} grouped />
      </QueryClientProvider>
    )
    await settle()
    expect(document.body.textContent).toContain('done with turn 0')
    expect(document.body.textContent).toContain('API unavailable')
    expect(document.body.textContent).not.toContain('apply_patch verification failed')
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    fireEvent.click(activity.querySelector('button')!)
    const diagnostics = Array.from(activity.querySelectorAll('button')).find(
      (button) => button.textContent === 'Agent diagnostics'
    )!
    expect(diagnostics.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(diagnostics)
    expect(activity.querySelector('pre')?.textContent).toBe('apply_patch verification failed')
    act(() => display!.search.setQuery('verification failed'))
    await settle()
    expect(display!.search.matchCount).toBe(1)
    expect(document.body.textContent).toContain('apply_patch verification failed')
  })

  it('places Activities and file changes together after the answer', async () => {
    const events = codexSession(1)
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <Harness key="shown" events={events} grouped />
      </QueryClientProvider>
    )
    await settle()
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    const summary = Array.from(activity.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Activities')
    )
    const files = activity.querySelector('[data-testid="chat-files-changed"]')
    expect(summary).toBeDefined()
    expect(files).not.toBeNull()
    expect(activity.closest('[data-testid="chat-answer-footer"]')?.classList.contains('flex')).toBe(
      true
    )
    expect(document.querySelectorAll('[data-testid="chat-files-changed"]')).toHaveLength(1)
    expect(document.body.textContent!.indexOf('done with turn 0')).toBeLessThan(
      document.body.textContent!.indexOf('Activities')
    )
    fireEvent.click(summary!)
    expect(summary?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(files!.querySelector('[data-testid="chat-files-changed-toggle"]')!)
    expect(files!.querySelector('[data-testid="chat-files-changed-file"]')).not.toBeNull()

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness key="hidden" events={events} grouped showSummary={false} />
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelector('[data-testid="chat-files-changed"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Activities')
  })

  it('shows a live preview and completed activity below the answer without an avatar', async () => {
    const start: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' },
      { kind: 'assistant-text', messageId: 'progress', text: 'Checking now' },
      {
        kind: 'assistant-thinking',
        messageId: 'thought',
        text: 'Inspect status',
        hasSignature: false
      },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      }
    ]
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <Harness key="active" events={start} grouped inFlight />
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelectorAll('[data-testid="chat-agent-avatar"]')).toHaveLength(0)
    expect(document.querySelector('[data-testid="chat-working-indicator"]')?.textContent).toContain(
      'Running command…'
    )
    expect(document.querySelector('[data-testid="chat-activity"]')?.textContent).toContain(
      'git status'
    )
    const preview = document.querySelector('[data-testid="tool-codex-command"]')!
    expect(preview.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(preview.querySelector('[data-testid="codex-command"]')).toBeNull()
    fireEvent.click(preview.querySelector('button')!)
    expect(preview.querySelector('[data-testid="codex-command"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Checking now')

    const complete: AgentEvent[] = [
      ...start,
      { kind: 'tool-result', toolUseId: 'cmd', isError: false, rawContent: '', structured: null },
      { kind: 'assistant-text', messageId: 'final', text: 'All done' },
      codexSession(1).at(-1)!
    ]
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness key="complete" events={complete} grouped />
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelectorAll('[data-testid="chat-agent-avatar"]')).toHaveLength(0)
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    expect(document.body.textContent!.indexOf('All done')).toBeLessThan(
      document.body.textContent!.indexOf('Activities')
    )
    expect(activity.textContent).toContain('3 items')
    fireEvent.click(activity.querySelector('button')!)
    expect(activity.textContent!.indexOf('Checking now')).toBeLessThan(
      activity.textContent!.indexOf('Inspect status')
    )
    expect(activity.textContent!.indexOf('Inspect status')).toBeLessThan(
      activity.textContent!.indexOf('git status')
    )
  })

  it('previews the latest enabled kind even when activities are hidden', async () => {
    const events: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' },
      {
        kind: 'assistant-thinking',
        messageId: 'thought',
        text: 'Inspect status',
        hasSignature: false
      },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      }
    ]
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness
          events={events}
          grouped
          inFlight
          showSummary={false}
          appearanceOverrides={{ chatShowActivityTools: false }}
        />
      </QueryClientProvider>
    )
    await settle()
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    expect(activity.textContent).toContain('Inspect status')
    expect(activity.textContent).not.toContain('git status')
    const preview = activity.querySelector('button')!
    expect(preview.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(preview)
    expect(preview.getAttribute('aria-expanded')).toBe('true')
  })

  it('opens activity with all tool calls collapsed', async () => {
    const events: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Review changes' },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      },
      { kind: 'tool-result', toolUseId: 'cmd', isError: false, rawContent: '', structured: null },
      {
        kind: 'tool-call',
        id: 'edit',
        name: 'Edit',
        input: { file_path: '/repo/a.ts', old_string: 'old', new_string: 'new' }
      },
      { kind: 'tool-result', toolUseId: 'edit', isError: false, rawContent: '', structured: null },
      { kind: 'assistant-text', messageId: 'final', text: 'Done' },
      codexSession(1).at(-1)!
    ]
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} grouped />
      </QueryClientProvider>
    )
    await settle()
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    const disclosure = activity.querySelector('button')!
    fireEvent.click(disclosure)
    const history = document.getElementById(disclosure.getAttribute('aria-controls')!)!
    let tools = Array.from(history.querySelectorAll('button[aria-expanded]'))
    expect(tools).toHaveLength(2)
    expect(tools.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    fireEvent.click(tools[0])
    expect(tools[0].getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(disclosure)
    fireEvent.click(disclosure)
    tools = Array.from(history.querySelectorAll('button[aria-expanded]'))
    expect(tools.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
  })

  it('searches messages inside collapsed activity', async () => {
    const events: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' },
      { kind: 'assistant-text', messageId: 'progress', text: 'Looking for the walrus' },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      },
      { kind: 'assistant-text', messageId: 'final', text: 'All done' },
      codexSession(1).at(-1)!
    ]
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness events={events} grouped />
      </QueryClientProvider>
    )
    await settle()
    expect(document.body.textContent).not.toContain('Looking for the walrus')
    act(() => display!.search.setQuery('walrus'))
    await settle()
    expect(display!.search.matchCount).toBe(1)
    expect(document.body.textContent).toContain('Looking for the walrus')
  })

  it('reveals a requested tool even when activity and tool filters are hidden', async () => {
    const events: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      },
      { kind: 'tool-result', toolUseId: 'cmd', isError: false, rawContent: '', structured: null },
      { kind: 'assistant-text', messageId: 'final', text: 'All done' },
      codexSession(1).at(-1)!
    ]
    const focus = new ToolFocusStore()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToolFocusContext.Provider value={focus}>
          <Harness
            events={events}
            grouped
            showSummary={false}
            appearanceOverrides={{ chatShowActivityTools: false }}
          />
        </ToolFocusContext.Provider>
      </QueryClientProvider>
    )
    await settle()
    expect(document.querySelector('[data-testid="chat-activity"]')).toBeNull()
    act(() => {
      focus.request('cmd')
      display!.revealItem('tool:cmd')
    })
    await settle()
    const activity = document.querySelector('[data-testid="chat-activity"]')!
    expect(activity.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(activity.textContent).toContain('git status')
  })

  it('shows a running tool outside history and folds it when it finishes', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const start: AgentEvent[] = [
      { kind: 'turn-init', sessionId: 'thread-1', model: 'codex', cwd: '/repo', tools: [] },
      { kind: 'user-message', text: 'Check status' },
      {
        kind: 'tool-call',
        id: 'cmd',
        name: 'codex/commandExecution',
        input: { command: 'git status' }
      }
    ]
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <Harness key="running" events={start} compactTools inFlight />
      </QueryClientProvider>
    )
    await settle()
    let activity = document.querySelector('[data-testid="chat-tool-activity"]')!
    expect(activity.textContent).toContain('1 running: codex/commandExecution')
    expect(activity.querySelector('.order-2')).not.toBeNull()

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness key="running" events={start} compactTools inFlight showSummary={false} />
      </QueryClientProvider>
    )
    await settle()
    activity = document.querySelector('[data-testid="chat-tool-activity"]')!
    expect(activity.querySelector(':scope > button')).toBeNull()
    expect(activity.querySelector('.order-2')).not.toBeNull()

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness key="running" events={start} compactTools inFlight showLatest={false} />
      </QueryClientProvider>
    )
    await settle()
    activity = document.querySelector('[data-testid="chat-tool-activity"]')!
    expect(activity.querySelector(':scope > button')?.textContent).toContain('1 tool call')
    expect(activity.querySelector('.order-2')).toBeNull()

    view.rerender(
      <QueryClientProvider client={client}>
        <Harness
          key="running"
          events={start}
          compactTools
          inFlight
          showSummary={false}
          showLatest={false}
        />
      </QueryClientProvider>
    )
    await settle()
    activity = document.querySelector('[data-testid="chat-tool-activity"]')!
    expect(activity.querySelector(':scope > button')).toBeNull()
    expect(activity.querySelector('.order-2')).toBeNull()

    const finished: AgentEvent[] = [
      ...start,
      {
        kind: 'tool-result',
        toolUseId: 'cmd',
        isError: false,
        rawContent: '',
        structured: null
      }
    ]
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness key="finished" events={finished} compactTools inFlight />
      </QueryClientProvider>
    )
    await settle()
    activity = document.querySelector('[data-testid="chat-tool-activity"]')!
    expect(activity.textContent).not.toContain('running:')
    expect(activity.querySelector('.order-2')).toBeNull()
    expect(document.querySelector('[data-testid="chat-working-indicator"]')?.textContent).toContain(
      'Waiting for agent…'
    )
  })

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
