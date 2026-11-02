// @vitest-environment jsdom
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
import { ChatViewContext, defaultChatView } from './ChatViewContext'
import { AssistantAnswer } from './AssistantAnswer'
import { activityView } from './activity-view'
import type { ConversationActionsView } from './useConversationActions'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  }
)
afterEach(cleanup)
const reply: Extract<TimelineItem, { kind: 'text' }> = {
  kind: 'text',
  role: 'assistant',
  messageId: 'answer',
  text: 'Yes.',
  timestamp: 1000
}
const result: Extract<TimelineItem, { kind: 'result' }> = {
  kind: 'result',
  model: 'gpt-6.1',
  tokenUsage: { inputTokens: 1800, outputTokens: 640 },
  subtype: 'success',
  isError: false,
  durationMs: 12800,
  totalCostUsd: 0.01,
  turnCostUsd: 0.01,
  numTurns: 3,
  text: null,
  copyText: 'Yes.',
  timestamp: 2000
}

describe('assistant answer presentation', () => {
  it('offers Copy directly in the hover toolbar for short and long answers', () => {
    for (const text of ['Yes.', 'A longer answer. '.repeat(100)]) {
      const mounted = render(<AssistantAnswer item={{ ...reply, text }} />)
      const toolbar = screen.getByRole('toolbar', { name: 'Answer actions' })
      expect(within(toolbar).getByRole('button', { name: 'Copy response' })).toBeDefined()
      mounted.unmount()
    }
  })

  it('does not attach another question’s threads when a provider reuses an answer id', () => {
    const view = {
      ...defaultChatView,
      threads: {
        threads: [
          {
            id: 'side',
            answerId: 'answer:0',
            sourceMessageId: 'other-question',
            title: 'Other question',
            taskId: 'task',
            mode: 'claude-chat',
            parentTabId: 'parent',
            parentConversationId: 'conversation',
            sourceUuid: 'record',
            conversationId: 'side-conversation',
            createdAt: 0
          }
        ],
        start: vi.fn(),
        open: vi.fn()
      }
    }
    render(
      <ChatViewContext.Provider value={view}>
        <AssistantAnswer
          item={reply}
          turn={{
            items: [],
            files: [],
            final: reply,
            result,
            userMessageId: 'question',
            active: false,
            hostIsActivity: false,
            subAgents: []
          }}
        />
      </ChatViewContext.Provider>
    )
    expect(screen.queryByRole('button', { name: /Threads/ })).toBeNull()
  })
  it('keeps details beside activity and associates the result with the answer once', () => {
    const user: TimelineItem = {
      kind: 'user-text',
      id: 'question',
      text: 'Can I reopen it?',
      timestamp: 0
    }
    const view = activityView([user, reply, result], false)
    expect(view.rows).toEqual([user, reply])
    const turn = view.turns.get(reply)!
    expect(turn.result).toBe(result)
    expect(turn.userMessageId).toBe('question')
    render(
      <AssistantAnswer
        item={reply}
        turn={turn}
        appearance={{
          chatShowActivities: true,
          chatPreviewLatestActivity: true,
          chatShowActivityMessages: true,
          chatShowThinking: true,
          chatShowActivityTools: true
        }}
      />
    )
    const footer = screen.getByTestId('chat-answer-footer')
    expect(footer.textContent).toContain('gpt-6.1')
    expect(footer.textContent).toContain('2.4k tokens')
    expect(footer.textContent).toContain('12.8s')
    expect(footer.textContent).toContain('3 turns')
  })

  it("the turn's sub-agents are their own button beside Activities, expanding to their rows", () => {
    const user: TimelineItem = { kind: 'user-text', id: 'q', text: 'Spawn two', timestamp: 0 }
    const agent = (toolUseId: string, phase: 'in-flight' | 'completed', description: string) =>
      ({
        kind: 'sub-agent',
        toolUseId,
        phase,
        description,
        backgrounded: true,
        timestamp: 0
      }) as TimelineItem
    const tool = {
      kind: 'tool',
      invocation: { id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'done' },
      timestamp: 0
    } as TimelineItem
    const view = activityView(
      [
        user,
        tool,
        agent('a1', 'completed', 'count files'),
        agent('a2', 'in-flight', 'summarize'),
        reply,
        result
      ],
      false
    )
    render(
      <AssistantAnswer
        item={reply}
        turn={view.turns.get(reply)!}
        appearance={{
          chatShowActivities: true,
          chatPreviewLatestActivity: true,
          chatShowActivityMessages: true,
          chatShowThinking: true,
          chatShowActivityTools: true
        }}
      />
    )
    const footer = screen.getByTestId('chat-answer-footer')
    expect(within(footer).getByRole('button', { name: /Activities\s*1 item/ })).toBeDefined()
    const toggle = within(footer).getByTestId('chat-sub-agents-toggle')
    expect(toggle.textContent).toContain('Sub-agents')
    expect(toggle.textContent).toContain('1 of 2 running')
    expect(screen.queryAllByTestId('sub-agent-row')).toHaveLength(0)
    fireEvent.click(toggle)
    const rows = screen.getAllByTestId('sub-agent-row')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('count files'),
      expect.stringContaining('summarize')
    ])
  })

  it('quotes only the selected answer into the composer and keeps More keyboard-accessible', () => {
    const quoteReply = vi.fn()
    render(
      <ChatViewContext.Provider value={{ ...defaultChatView, quoteReply }}>
        <AssistantAnswer item={reply} />
      </ChatViewContext.Provider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More answer actions' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote in main chat' }))
    expect(quoteReply).toHaveBeenCalledWith('Yes.')
  })

  it('hides details when the existing preference is off', () => {
    render(
      <ChatViewContext.Provider value={{ ...defaultChatView, showMessageMeta: false }}>
        <AssistantAnswer
          item={reply}
          turn={{
            items: [],
            files: [],
            final: reply,
            result,
            active: false,
            hostIsActivity: false,
            subAgents: [],
            userMessageId: 'question'
          }}
        />
      </ChatViewContext.Provider>
    )
    expect(screen.queryByText('gpt-6.1')).toBeNull()
    expect(screen.getByText('Yes.')).toBeDefined()
  })
})

describe('assistant answer fork', () => {
  const user: TimelineItem = { kind: 'user-text', id: 'question', text: 'Question?', timestamp: 0 }
  const turn = activityView([user, reply, result], false).turns.get(reply)!
  function mount(
    overrides: Partial<ConversationActionsView> = {},
    answer = reply,
    answerTurn = turn
  ) {
    const conversation: ConversationActionsView = {
      canRewind: true,
      canFork: true,
      activeIds: new Set(['question']),
      lastActiveId: 'question',
      busy: false,
      begin: vi.fn(),
      ...overrides
    }
    render(
      <ChatViewContext.Provider value={{ ...defaultChatView, conversation }}>
        <AssistantAnswer item={answer} turn={answerTurn} />
      </ChatViewContext.Provider>
    )
    return conversation
  }

  it('forks the selected answer’s turn using its user message id', () => {
    const conversation = mount({ canRewind: false })
    const toolbar = screen.getByRole('toolbar', { name: 'Answer actions' })
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Fork from here' }))
    expect(conversation.begin).toHaveBeenCalledWith('fork', { id: 'question', text: 'Yes.' })
  })

  it.each([true, false])('keeps interrupted turns actionable (has output: %s)', (hasOutput) => {
    const interrupted: Extract<TimelineItem, { kind: 'interrupted' }> = {
      kind: 'interrupted',
      timestamp: 2000
    }
    const interruptedTurn = activityView(
      [user, ...(hasOutput ? [reply] : []), interrupted],
      false
    ).turns.get(interrupted)!
    const conversation: ConversationActionsView = {
      canRewind: true,
      canFork: true,
      activeIds: new Set(['question']),
      lastActiveId: 'question',
      busy: false,
      begin: vi.fn()
    }
    render(
      <ChatViewContext.Provider value={{ ...defaultChatView, conversation }}>
        <AssistantAnswer item={interrupted} turn={interruptedTurn} />
      </ChatViewContext.Provider>
    )
    expect(screen.getByText('Turn interrupted')).toBeDefined()
    const toolbar = screen.getByRole('toolbar', { name: 'Answer actions' })
    expect(within(toolbar).queryByRole('button', { name: 'Copy response' }) !== null).toBe(
      hasOutput
    )
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Fork from here' }))
    expect(conversation.begin).toHaveBeenCalledWith('fork', {
      id: 'question',
      text: hasOutput ? 'Yes.' : ''
    })
    expect(screen.queryByRole('button', { name: 'Start thread' })).toBeNull()
  })

  it.each([
    ['unsupported provider', { canFork: false }],
    ['folded conversation', { activeIds: new Set<string>() }]
  ] as const)('hides fork for %s', (_, overrides) => {
    mount(overrides)
    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull()
  })

  it('hides fork for streaming answers or answers without a source message', () => {
    mount({}, { ...reply, stream: 'open' })
    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull()
    cleanup()
    mount({}, reply, { ...turn, userMessageId: undefined })
    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull()
  })

  it('disables fork while another conversation action is pending', () => {
    const conversation = mount({ busy: true })
    const fork = screen.getByRole('button', { name: 'Fork from here' }) as HTMLButtonElement
    expect(fork.disabled).toBe(true)
    fireEvent.click(fork)
    expect(conversation.begin).not.toHaveBeenCalled()
  })
})
