// @vitest-environment jsdom
/**
 * Timeline cards of prompts (AskUserQuestion, ExitPlanMode, a tool waiting for
 * approval). They show the prompt's content and what became of it — derived
 * from the event log, so a reload shows the same thing. Answering happens in
 * the prompt dock (prompts/PromptDock.test.tsx), never on these cards.
 */
import type React from 'react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ChatPrompt, TimelineItem, ToolInvocation } from '@slayzone/terminal/client'
import type { PermissionDecision } from '@slayzone/terminal-contracts'

vi.mock('@slayzone/diff-view', () => ({
  DiffView: () => null
}))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { ChatViewContext, type ChatViewState } from './ChatViewContext'
import { ToolCallAskUserQuestion, ToolCallExitPlanMode, renderTool } from './renderers'
import { feedbackDenial, REJECT_MESSAGE } from './prompts/prompt-options'

afterEach(cleanup)

function View({
  timeline,
  overrides,
  children
}: {
  timeline: TimelineItem[]
  overrides?: Partial<ChatViewState>
  children: React.ReactNode
}) {
  const base = useContext(ChatViewContext)
  return (
    <ChatViewContext.Provider
      value={{ ...base, timeline, promptCards: true, cwd: '/repo', ...overrides }}
    >
      {children}
    </ChatViewContext.Provider>
  )
}

const toolItem = (invocation: ToolInvocation) =>
  ({ kind: 'tool', invocation, timestamp: 0 }) as unknown as TimelineItem

function promptFor(
  invocation: ToolInvocation,
  status: ChatPrompt['status'],
  decision: PermissionDecision | null = null,
  optionId: string | null = null
): ChatPrompt {
  return {
    requestId: `req-${invocation.id}`,
    toolUseId: invocation.id,
    toolName: invocation.name,
    input: invocation.input,
    request: {
      kind: 'permission-request',
      requestId: `req-${invocation.id}`,
      toolName: invocation.name,
      toolUseId: invocation.id,
      input: invocation.input
    },
    status,
    decision,
    optionId
  }
}

const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name })

// --- AskUserQuestion ---

const COLOR = {
  question: 'Which color do you prefer?',
  header: 'Color',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'Pick red' },
    { label: 'Blue', description: 'Pick blue' }
  ]
}
const ask = (over: Partial<ToolInvocation> = {}): ToolInvocation =>
  ({
    id: 'toolu_ask',
    name: 'AskUserQuestion',
    status: 'pending',
    input: { questions: [COLOR] },
    ...over
  }) as unknown as ToolInvocation

function renderAsk(
  invocation: ToolInvocation,
  prompts: ChatPrompt[],
  overrides: Partial<ChatViewState> = {}
) {
  render(
    <View timeline={[toolItem(invocation)]} overrides={{ prompts, ...overrides }}>
      <ToolCallAskUserQuestion invocation={invocation} />
    </View>
  )
}

describe('AskUserQuestion card', () => {
  it('while pending: the questions, and a pointer to the answer below — no answer controls here', () => {
    const inv = ask()
    renderAsk(inv, [promptFor(inv, 'pending')])
    expect(screen.getByText('Which color do you prefer?')).toBeTruthy()
    expect(screen.getByText('Red')).toBeTruthy()
    expect(screen.getByText('Answer below ↓')).toBeTruthy()
    expect(queryButton('Submit')).toBeNull()
    expect(queryButton('Cancel')).toBeNull()
  })

  it('an invocation answered before a reload shows its answer and is not answerable again', () => {
    const inv = ask({ status: 'done' } as Partial<ToolInvocation>)
    renderAsk(inv, [
      promptFor(
        inv,
        'resolved',
        {
          behavior: 'allow',
          updatedInput: { questions: [COLOR], answers: { 'Which color do you prefer?': 'Blue' } }
        },
        'answer'
      )
    ])
    expect(screen.getByText("User answered Claude's questions:")).toBeTruthy()
    expect(screen.getByText('Which color do you prefer? → Blue')).toBeTruthy()
    expect(queryButton(/^Red/)).toBeNull()
    expect(queryButton('Submit')).toBeNull()
  })

  it('declined / handed back to Claude, in TUI wording', () => {
    const inv = ask()
    renderAsk(inv, [
      promptFor(inv, 'resolved', { behavior: 'deny', message: REJECT_MESSAGE }, 'decline')
    ])
    expect(screen.getByText('User declined to answer questions')).toBeTruthy()
    cleanup()
    renderAsk(inv, [promptFor(inv, 'resolved', { behavior: 'deny', message: 'x' }, 'clarify')])
    expect(screen.getByText('User asked Claude for more questions')).toBeTruthy()
  })

  it('a question its process can no longer take shows as expired', () => {
    const inv = ask()
    renderAsk(inv, [promptFor(inv, 'expired')])
    expect(screen.getByText('Expired — Claude is no longer waiting for this answer.')).toBeTruthy()
  })

  it('older logs without an answer record: the answer comes from the tool result', () => {
    const inv = ask({
      status: 'done',
      result: { rawContent: '', structured: { answers: { 'Which color do you prefer?': 'Red' } } }
    } as unknown as Partial<ToolInvocation>)
    renderAsk(inv, [promptFor(inv, 'resolved')])
    expect(screen.getByText('Which color do you prefer? → Red')).toBeTruthy()
  })

  it('without prompt cards (Codex) there is no prompt status', () => {
    const inv = ask()
    renderAsk(inv, [promptFor(inv, 'pending')], { promptCards: false })
    expect(screen.queryByText('Answer below ↓')).toBeNull()
  })
})

// --- ExitPlanMode ---

const plan = (over: Partial<ToolInvocation> = {}): ToolInvocation =>
  ({
    id: 'toolu_plan',
    name: 'ExitPlanMode',
    status: 'pending',
    input: { plan: '# Plan: create hello.txt' },
    ...over
  }) as unknown as ToolInvocation

function renderPlan(invocation: ToolInvocation, prompts: ChatPrompt[]) {
  render(
    <View timeline={[toolItem(invocation)]} overrides={{ prompts }}>
      <ToolCallExitPlanMode invocation={invocation} />
    </View>
  )
}

describe('ExitPlanMode card', () => {
  it('renders the plan; while pending it points at the approval below', () => {
    const inv = plan()
    renderPlan(inv, [promptFor(inv, 'pending')])
    expect(screen.getByText('# Plan: create hello.txt')).toBeTruthy()
    expect(screen.getByText('Waiting for your approval below ↓')).toBeTruthy()
    expect(queryButton(/Approve/)).toBeNull()
  })

  it('shows how it was answered', () => {
    const inv = plan()
    const cases: Array<[string, PermissionDecision, string]> = [
      ['plan-auto', { behavior: 'allow' }, 'Approved · auto mode'],
      ['plan-accept-edits', { behavior: 'allow' }, 'Approved · auto-accept edits'],
      ['plan-manual', { behavior: 'allow' }, 'Approved · manually approve edits'],
      ['plan-feedback', feedbackDenial('add tests'), 'Keep planning: add tests'],
      ['plan-reject', { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }, 'Rejected']
    ]
    for (const [optionId, decision, text] of cases) {
      renderPlan(inv, [promptFor(inv, 'resolved', decision, optionId)])
      expect(screen.getByText(text)).toBeTruthy()
      cleanup()
    }
  })

  it('a plan from an older log (denied, no prompt record) offers nothing to click', () => {
    const inv = plan({ status: 'denied', denied: true } as Partial<ToolInvocation>)
    renderPlan(inv, [])
    expect(screen.getByText('# Plan: create hello.txt')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

// --- other tools ---

describe('a tool waiting for approval', () => {
  const bash = {
    id: 'toolu_bash',
    name: 'Bash',
    status: 'pending',
    input: { command: 'npm run build' }
  } as unknown as ToolInvocation

  function renderBash(prompts: ChatPrompt[], overrides: Partial<ChatViewState> = {}) {
    render(
      <View timeline={[toolItem(bash)]} overrides={{ prompts, ...overrides }}>
        {renderTool(bash, 0)}
      </View>
    )
  }

  it('says so under its card, then what was decided', () => {
    renderBash([promptFor(bash, 'pending')])
    expect(screen.getByText('Waiting for your approval below ↓')).toBeTruthy()
    cleanup()
    renderBash([promptFor(bash, 'resolved', { behavior: 'allow' }, 'yes')])
    expect(screen.getByText('Allowed')).toBeTruthy()
    cleanup()
    renderBash([promptFor(bash, 'resolved', feedbackDenial('use pnpm'), 'no-feedback')])
    expect(screen.getByText('Rejected · use pnpm')).toBeTruthy()
    cleanup()
    renderBash([promptFor(bash, 'expired')])
    expect(screen.getByText('Expired')).toBeTruthy()
  })

  it('nothing for Codex', () => {
    renderBash([promptFor(bash, 'pending')], { promptCards: false })
    expect(screen.queryByText('Waiting for your approval below ↓')).toBeNull()
  })
})
