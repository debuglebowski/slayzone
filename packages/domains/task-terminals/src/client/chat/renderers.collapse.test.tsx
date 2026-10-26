// @vitest-environment jsdom
import type React from 'react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'

// Diff/markdown viewers are irrelevant to collapse state and heavy to load.
vi.mock('@slayzone/worktrees/client', () => ({
  DiffView: () => null,
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { ChatViewContext } from './ChatViewContext'
import { ResultFooter, ThinkingBlock, ToolCallAskUserQuestion } from './renderers'

/** Context with a controllable collapse signal + timeline; everything else default. */
function View({
  signal,
  timeline = [],
  children
}: {
  signal: number
  timeline?: TimelineItem[]
  children: React.ReactNode
}) {
  const base = useContext(ChatViewContext)
  return (
    <ChatViewContext.Provider value={{ ...base, collapseSignal: signal, timeline }}>
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
