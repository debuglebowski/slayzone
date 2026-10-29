// @vitest-environment jsdom
import type React from 'react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'

// Diff/markdown viewers are irrelevant to collapse state and heavy to load.
vi.mock('@slayzone/diff-view', () => ({
  DiffView: () => null
}))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { ChatViewContext, type ChatViewState } from './ChatViewContext'
import {
  ResultFooter,
  SubAgentRow,
  ThinkingBlock,
  ToolCallAskUserQuestion,
  ToolCallBash,
  ToolCallEdit,
  ToolCallGeneric
} from './renderers'

/** Context with a controllable collapse signal + timeline; everything else default. */
function View({
  signal,
  timeline = [],
  overrides,
  children
}: {
  signal: number
  timeline?: TimelineItem[]
  overrides?: Partial<ChatViewState>
  children: React.ReactNode
}) {
  const base = useContext(ChatViewContext)
  return (
    <ChatViewContext.Provider value={{ ...base, collapseSignal: signal, timeline, ...overrides }}>
      {children}
    </ChatViewContext.Provider>
  )
}

afterEach(cleanup)

describe('ThinkingBlock collapse', () => {
  const item = {
    kind: 'thinking',
    text: 'deep thought',
    messageId: 'm1'
  } as unknown as Extract<TimelineItem, { kind: 'thinking' }>
  const ui = (signal: number) => (
    <View signal={signal}>
      <ThinkingBlock item={item} />
    </View>
  )

  it('starts closed, opens on click, stays open across re-renders, closes on "collapse all"', () => {
    const { rerender } = render(ui(0))
    expect(screen.queryByText('deep thought')).toBeNull()

    fireEvent.click(screen.getByText('Thinking'))
    expect(screen.getByText('deep thought')).toBeDefined()

    rerender(ui(0))
    expect(screen.getByText('deep thought')).toBeDefined()

    rerender(ui(1))
    expect(screen.queryByText('deep thought')).toBeNull()
  })

  it('mounting under an already-bumped signal does not count as a bump', () => {
    const { rerender } = render(ui(3))
    fireEvent.click(screen.getByText('Thinking'))
    rerender(ui(3))
    expect(screen.getByText('deep thought')).toBeDefined()
  })
})

describe('ResultFooter collapse', () => {
  const item = {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1500,
    totalCostUsd: 0.0123,
    numTurns: 2,
    text: 'final reply text',
    timestamp: 0
  } as unknown as Extract<TimelineItem, { kind: 'result' }>
  const ui = (signal: number) => (
    <View signal={signal}>
      <ResultFooter item={item} />
    </View>
  )

  it('expands on click and collapses on "collapse all"', () => {
    const { rerender } = render(ui(0))
    expect(screen.queryByText('final reply text')).toBeNull()

    fireEvent.click(screen.getByText('1.5s'))
    expect(screen.getByText('final reply text')).toBeDefined()

    rerender(ui(0))
    expect(screen.getByText('final reply text')).toBeDefined()

    rerender(ui(1))
    expect(screen.queryByText('final reply text')).toBeNull()
  })
})

describe('AskUserQuestion collapse', () => {
  const ask = (id: string): ToolInvocation =>
    ({
      id,
      name: 'AskUserQuestion',
      status: 'pending',
      input: {
        questions: [
          {
            question: `Question ${id}?`,
            header: 'Q',
            multiSelect: false,
            options: [{ label: `Option ${id}`, description: '' }]
          }
        ]
      }
    }) as unknown as ToolInvocation
  const toolItem = (invocation: ToolInvocation) =>
    ({ kind: 'tool', invocation }) as unknown as TimelineItem
  const first = ask('a1')
  const second = ask('a2')
  const ui = (signal: number, timeline: TimelineItem[]) => (
    <View signal={signal} timeline={timeline}>
      <ToolCallAskUserQuestion invocation={first} />
    </View>
  )
  const isExpanded = () => screen.queryByText('Option a1') !== null
  const toggle = () => fireEvent.click(screen.getByText('Question'))

  it('latest ask starts expanded; a newer ask collapses it', () => {
    const { rerender } = render(ui(0, [toolItem(first)]))
    expect(isExpanded()).toBe(true)

    rerender(ui(0, [toolItem(first), toolItem(second)]))
    expect(isExpanded()).toBe(false)

    // Manual toggle still works and survives unrelated re-renders.
    toggle()
    expect(isExpanded()).toBe(true)
    rerender(ui(0, [toolItem(first), toolItem(second)]))
    expect(isExpanded()).toBe(true)
  })

  it('an older ask starts collapsed and re-expands when it becomes the latest again', () => {
    const { rerender } = render(ui(0, [toolItem(second), toolItem(first), toolItem(second)]))
    expect(isExpanded()).toBe(false)

    rerender(ui(0, [toolItem(second), toolItem(first)]))
    expect(isExpanded()).toBe(true)
  })

  it('"collapse all" collapses it, but mounting under a bumped signal does not', () => {
    const { rerender } = render(ui(5, [toolItem(first)]))
    expect(isExpanded()).toBe(true)

    rerender(ui(5, [toolItem(first)]))
    expect(isExpanded()).toBe(true)

    rerender(ui(6, [toolItem(first)]))
    expect(isExpanded()).toBe(false)

    toggle()
    expect(isExpanded()).toBe(true)
  })

  it('a bump in the same update as losing latest-ask still ends collapsed', () => {
    const { rerender } = render(ui(0, [toolItem(first)]))
    toggle()
    toggle()
    expect(isExpanded()).toBe(true)

    rerender(ui(1, [toolItem(first), toolItem(second)]))
    expect(isExpanded()).toBe(false)
  })
})

describe('ToolShell default-open', () => {
  const tool = (
    name: string,
    status: ToolInvocation['status'],
    input: Record<string, unknown>,
    rawContent?: string
  ): ToolInvocation =>
    ({
      id: `${name}-1`,
      name,
      status,
      input,
      result: rawContent === undefined ? undefined : { rawContent, structured: null }
    }) as unknown as ToolInvocation
  const bash = tool('Bash', 'done', { command: 'ls -la', description: 'List files' })
  const bashUi = (signal: number) => (
    <View signal={signal}>
      <ToolCallBash invocation={bash} />
    </View>
  )
  const isBashOpen = () => screen.queryByText('ls -la') !== null

  it('a defaultOpen card (Bash) stays open after mount; "collapse all" still closes it', () => {
    const { rerender } = render(bashUi(0))
    expect(isBashOpen()).toBe(true)

    rerender(bashUi(0))
    expect(isBashOpen()).toBe(true)

    rerender(bashUi(1))
    expect(isBashOpen()).toBe(false)

    // Manual toggle still works after a collapse.
    fireEvent.click(screen.getByText('List files'))
    expect(isBashOpen()).toBe(true)
  })

  it('mounting under an already-bumped signal does not collapse the default', () => {
    const { rerender } = render(bashUi(4))
    expect(isBashOpen()).toBe(true)
    rerender(bashUi(4))
    expect(isBashOpen()).toBe(true)
  })

  it('file edits follow fileEditsOpenByDefault', () => {
    const edit = tool('Edit', 'done', {
      file_path: '/a/b.ts',
      old_string: 'old line',
      new_string: 'new line'
    })
    const editUi = (openByDefault: boolean) => (
      <View signal={0} overrides={{ fileEditsOpenByDefault: openByDefault }}>
        <ToolCallEdit invocation={edit} />
      </View>
    )
    render(editUi(true))
    expect(screen.queryByText('+ new line')).not.toBeNull()
    cleanup()

    render(editUi(false))
    expect(screen.queryByText('+ new line')).toBeNull()
  })

  it('an errored tool starts open; a successful one without defaultOpen starts closed', () => {
    const failed = tool('Lookup', 'error', { q: 1 }, 'lookup exploded')
    render(
      <View signal={0}>
        <ToolCallGeneric invocation={failed} />
      </View>
    )
    expect(screen.queryByText('lookup exploded')).not.toBeNull()
    cleanup()

    const ok = tool('Lookup', 'done', { q: 1 }, 'lookup result')
    render(
      <View signal={0}>
        <ToolCallGeneric invocation={ok} />
      </View>
    )
    expect(screen.queryByText('lookup result')).toBeNull()
  })
})

describe('SubAgentRow default-open', () => {
  const launcher = {
    kind: 'tool',
    invocation: { id: 'sa1', name: 'Agent', status: 'error', input: { prompt: 'p' } }
  } as unknown as TimelineItem
  const row = (phase: 'completed' | 'failed') =>
    ({
      kind: 'sub-agent',
      toolUseId: 'sa1',
      phase,
      description: 'investigate',
      timestamp: 0
    }) as unknown as Extract<TimelineItem, { kind: 'sub-agent' }>
  const ui = (signal: number, phase: 'completed' | 'failed') => (
    <View signal={signal} timeline={[launcher]}>
      <SubAgentRow item={row(phase)} />
    </View>
  )
  const isOpen = () => screen.queryByTestId('sub-agent-children') !== null

  it('an errored sub-agent stays open after mount; "collapse all" closes it', () => {
    const { rerender } = render(ui(0, 'failed'))
    expect(isOpen()).toBe(true)

    rerender(ui(0, 'failed'))
    expect(isOpen()).toBe(true)

    rerender(ui(1, 'failed'))
    expect(isOpen()).toBe(false)
  })

  it('a successful sub-agent starts closed', () => {
    render(ui(0, 'completed'))
    expect(isOpen()).toBe(false)
  })
})
