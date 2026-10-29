// @vitest-environment jsdom
/**
 * The prompt dock answers the agent's pending prompts — permission requests,
 * AskUserQuestion, plan approval — with the TUI's rows, keys and wording. What
 * it sends is asserted as the `respondPermission` call (request id, wire
 * decision, picked row).
 */
import type React from 'react'
import { useContext, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatPrompt, TimelineItem } from '@slayzone/terminal/client'
import type { PermissionRequestEvent } from '@slayzone/terminal-contracts'

vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
const toast = vi.fn()
vi.mock('@slayzone/ui', async (orig) => ({
  ...(await orig<typeof import('@slayzone/ui')>()),
  toast: (...args: unknown[]) => toast(...args)
}))

import { ChatViewContext, type ChatViewState } from '../ChatViewContext'
import { PromptDock, type PromptKeyHandler } from './PromptDock'
import { feedbackDenial, REJECT_MESSAGE } from './prompt-options'

afterEach(() => {
  cleanup()
  toast.mockReset()
})

function prompt(
  request: Partial<PermissionRequestEvent> & { toolName: string },
  over: Partial<ChatPrompt> = {}
): ChatPrompt {
  const req: PermissionRequestEvent = {
    kind: 'permission-request',
    requestId: over.requestId ?? 'r1',
    toolUseId: over.toolUseId ?? 'tu1',
    input: {},
    ...request
  }
  return {
    requestId: req.requestId,
    toolUseId: req.toolUseId,
    toolName: req.toolName,
    input: req.input,
    request: req,
    status: 'pending',
    decision: null,
    optionId: null,
    ...over
  }
}

const BASH = prompt({
  toolName: 'Bash',
  input: { command: 'npm run build', description: 'Build the project' },
  description: 'Build the project',
  permissionSuggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }],
      behavior: 'allow',
      destination: 'localSettings'
    }
  ]
})

let keys: { current: PromptKeyHandler | null } = { current: null }

function Dock({ overrides }: { overrides: Partial<ChatViewState> }) {
  const base = useContext(ChatViewContext)
  const keysRef = useRef<PromptKeyHandler | null>(null)
  keys = keysRef
  return (
    <ChatViewContext.Provider
      value={{
        ...base,
        promptCards: true,
        autoModeAvailable: false,
        cwd: '/repo',
        submittingPrompts: new Set(),
        ...overrides
      }}
    >
      <PromptDock keysRef={keysRef} />
      <textarea aria-label="composer" />
    </ChatViewContext.Provider>
  )
}

function setup(prompts: ChatPrompt[], overrides: Partial<ChatViewState> = {}) {
  const respondPermission = vi.fn(async () => true)
  const sendMessage = vi.fn()
  render(<Dock overrides={{ prompts, respondPermission, sendMessage, ...overrides }} />)
  return { respondPermission, sendMessage }
}

/** A key the panel routes to the dock (focus outside text fields). */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  let handled = false
  act(() => {
    handled = keys.current?.(e) ?? false
  })
  return handled
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('permission card', () => {
  it('shows the TUI card for a Bash command and answers "Yes"', async () => {
    const { respondPermission } = setup([BASH])
    expect(screen.getByText('Bash command')).toBeTruthy()
    expect(screen.getByText('npm run build')).toBeTruthy()
    expect(screen.getByText('Do you want to proceed?')).toBeTruthy()
    await act(async () => fireEvent.click(button(/^Yes$/)))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: { behavior: 'allow' },
      optionId: 'yes'
    })
  })

  it('number keys pick a row; Enter confirms the selected one', () => {
    const { respondPermission } = setup([BASH])
    expect(press('2')).toBe(true)
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: { behavior: 'allow', updatedPermissions: BASH.request.permissionSuggestions },
      optionId: 'yes-rules'
    })
    respondPermission.mockClear()
    // Rows: Yes / don't ask again / No — from row 2, one ↓ reaches No.
    press('ArrowDown')
    press('Enter')
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        optionId: 'no',
        decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }
      })
    )
  })

  it('Esc answers No (the turn stops)', () => {
    const { respondPermission } = setup([BASH])
    expect(press('Escape')).toBe(true)
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true },
      optionId: 'no'
    })
  })

  it('Tab opens "tell Claude what to do differently"; Enter sends it, the turn continues', async () => {
    const { respondPermission } = setup([BASH])
    press('Tab')
    const field = screen.getByRole('textbox', { name: /tell Claude what to do differently/i })
    fireEvent.change(field, { target: { value: 'use pnpm' } })
    await act(async () => fireEvent.keyDown(field, { key: 'Enter' }))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: feedbackDenial('use pnpm'),
      optionId: 'no-feedback'
    })
  })

  it('keys typed in the composer are left alone', () => {
    const { respondPermission } = setup([BASH])
    const composer = screen.getByRole('textbox', { name: 'composer' })
    composer.focus()
    expect(press('1')).toBe(false)
    expect(respondPermission).not.toHaveBeenCalled()
  })

  it('Shift+Tab on an Edit picks "switch to accept edits"', () => {
    const edit = prompt({
      toolName: 'Edit',
      input: { file_path: '/repo/f1.txt', old_string: 'color = red', new_string: 'color = blue' },
      description: 'f1.txt',
      permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    })
    const { respondPermission } = setup([edit])
    expect(screen.getByText('color = red')).toBeTruthy()
    expect(screen.getByText('color = blue')).toBeTruthy()
    press('Tab', { shiftKey: true })
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({ optionId: 'yes-mode-acceptEdits' })
    )
  })

  it('the oldest pending prompt is shown first, with a count', () => {
    setup([
      BASH,
      prompt({ toolName: 'Bash', input: { command: 'ls' } }, { requestId: 'r2', toolUseId: 'tu2' })
    ])
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(screen.getByText('npm run build')).toBeTruthy()
  })

  it('while the answer is on its way, the rows are disabled', () => {
    setup([BASH], { submittingPrompts: new Set(['r1']) })
    expect(button(/^Yes$/).disabled).toBe(true)
    expect(press('1')).toBe(true)
  })

  it('a refused answer (no longer pending) is reported', async () => {
    setup([BASH], { respondPermission: vi.fn(async () => false) })
    await act(async () => fireEvent.click(button(/^Yes$/)))
    expect(toast).toHaveBeenCalledWith(
      'This request is no longer active — Claude stopped waiting for it.'
    )
  })

  it('nothing for providers without prompt cards (Codex), or with nothing pending', () => {
    const { container } = render(<Dock overrides={{ prompts: [BASH], promptCards: false }} />)
    expect(container.querySelector('[data-prompt-dock]')).toBeNull()
    cleanup()
    const { container: c2 } = render(
      <Dock overrides={{ prompts: [{ ...BASH, status: 'resolved' }] }} />
    )
    expect(c2.querySelector('[data-prompt-dock]')).toBeNull()
  })

  it('a subagent prompt names the agent from the Task that spawned it', () => {
    const fetch = prompt(
      {
        toolName: 'WebFetch',
        input: { url: 'https://example.com/', prompt: 'title?' },
        agentId: 'a1'
      },
      { toolUseId: 'tu-fetch' }
    )
    const timeline = [
      {
        kind: 'tool',
        timestamp: 0,
        invocation: {
          id: 'tu-task',
          name: 'Task',
          input: { subagent_type: 'web-fetch' },
          status: 'pending'
        }
      },
      {
        kind: 'tool',
        timestamp: 0,
        parentToolUseId: 'tu-task',
        invocation: { id: 'tu-fetch', name: 'WebFetch', input: {}, status: 'pending' }
      }
    ] as unknown as TimelineItem[]
    setup([fetch], { timeline })
    expect(screen.getByText(/from the web-fetch agent/)).toBeTruthy()
  })
})

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
const FRUITS = {
  question: 'Which fruits?',
  header: 'Fruits',
  multiSelect: true,
  options: [
    { label: 'Apple', description: '' },
    { label: 'Pear', description: '' }
  ]
}
const LAYOUT = {
  question: 'Which layout?',
  header: 'Layout',
  multiSelect: false,
  options: [
    { label: 'Stacked', description: 'one above the other', preview: '[header]\n[content]' },
    { label: 'Side by side', description: 'next to each other', preview: '[header|content]' }
  ]
}
const ask = (questions: unknown[]) =>
  prompt({ toolName: 'AskUserQuestion', input: { questions }, requiresUserInteraction: true })

describe('question card', () => {
  it('Submit sends every answer merged into the asked input', async () => {
    const q = ask([COLOR, FRUITS])
    const { respondPermission } = setup([q])
    expect(button('Submit').disabled).toBe(true)
    fireEvent.click(button(/^Red/))
    fireEvent.click(button(/^Blue/))
    fireEvent.click(button(/^Apple/))
    fireEvent.click(button(/^Pear/))
    await act(async () => fireEvent.click(button('Submit')))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: {
        behavior: 'allow',
        updatedInput: {
          questions: [COLOR, FRUITS],
          answers: { 'Which color do you prefer?': 'Blue', 'Which fruits?': 'Apple, Pear' }
        }
      },
      optionId: 'answer'
    })
  })

  it('"Type something" answers in free text', async () => {
    const { respondPermission } = setup([ask([COLOR])])
    fireEvent.click(button(/Type something/))
    const field = screen.getByPlaceholderText('Type something…')
    fireEvent.change(field, { target: { value: 'Green' } })
    await act(async () => fireEvent.keyDown(field, { key: 'Enter', metaKey: true }))
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          updatedInput: expect.objectContaining({
            answers: { 'Which color do you prefer?': 'Green' }
          })
        })
      })
    )
  })

  it("shows the focused option's preview; notes ride along as annotations", async () => {
    const { respondPermission } = setup([ask([LAYOUT])])
    fireEvent.click(button(/^Stacked/))
    expect(
      screen.getByText(
        (_t, el) => el?.tagName === 'PRE' && el.textContent === '[header]\n[content]'
      )
    ).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Add notes on this design…'), {
      target: { value: 'slimmer header' }
    })
    await act(async () => fireEvent.click(button('Submit')))
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          updatedInput: expect.objectContaining({
            answers: { 'Which layout?': 'Stacked' },
            annotations: {
              'Which layout?': { preview: '[header]\n[content]', notes: 'slimmer header' }
            }
          })
        })
      })
    )
  })

  it('Cancel declines only the question: the reject text, no interrupt', async () => {
    const abortAgent = vi.fn()
    const { respondPermission } = setup([ask([COLOR])], { abortAgent } as Partial<ChatViewState>)
    await act(async () => fireEvent.click(button('Cancel')))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: { behavior: 'deny', message: REJECT_MESSAGE },
      optionId: 'decline'
    })
    expect(abortAgent).not.toHaveBeenCalled()
  })

  it('Esc declines the question too', () => {
    const { respondPermission } = setup([ask([COLOR])])
    press('Escape')
    expect(respondPermission).toHaveBeenCalledWith(expect.objectContaining({ optionId: 'decline' }))
  })

  it('"Chat about this" hands the questions back to Claude', async () => {
    const { respondPermission } = setup([ask([COLOR])])
    await act(async () => fireEvent.click(button('Chat about this')))
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        optionId: 'clarify',
        decision: expect.objectContaining({ behavior: 'deny' })
      })
    )
  })
})

// --- ExitPlanMode ---

const PLAN = prompt({
  toolName: 'ExitPlanMode',
  input: { plan: '1. Write hello.txt' },
  requiresUserInteraction: true
})

describe('plan approval', () => {
  it('offers the TUI rows; auto mode when the account has it', () => {
    setup([PLAN], { autoModeAvailable: true })
    expect(screen.getByText('Ready to code?')).toBeTruthy()
    expect(
      screen.getByText(
        'Claude has written up a plan and is ready to execute. Would you like to proceed?'
      )
    ).toBeTruthy()
    expect(button(/^Yes, and use auto mode/)).toBeTruthy()
    expect(button(/^Yes, manually approve edits/)).toBeTruthy()
    expect(button(/^Tell Claude what to change/)).toBeTruthy()
  })

  it('approving switches the mode in the same answer — no hidden chat message', async () => {
    const { respondPermission, sendMessage } = setup([PLAN], { autoModeAvailable: true })
    await act(async () => fireEvent.click(button(/^Yes, and use auto mode/)))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }]
      },
      optionId: 'plan-auto'
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('keep planning: the feedback goes back as the TUI rejection text', async () => {
    const { respondPermission } = setup([PLAN])
    fireEvent.click(button(/^Tell Claude what to change/))
    const field = screen.getByRole('textbox', { name: /Tell Claude what to change/ })
    fireEvent.change(field, { target: { value: 'add tests' } })
    await act(async () => fireEvent.keyDown(field, { key: 'Enter' }))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'r1',
      decision: feedbackDenial('add tests'),
      optionId: 'plan-feedback'
    })
  })

  it('approve with this feedback (shift+tab): approve, then send the feedback as a message', async () => {
    const { respondPermission, sendMessage } = setup([PLAN])
    fireEvent.click(button(/^Tell Claude what to change/))
    const field = screen.getByRole('textbox', { name: /Tell Claude what to change/ })
    fireEvent.change(field, { target: { value: 'add tests' } })
    await act(async () => fireEvent.keyDown(field, { key: 'Tab', shiftKey: true }))
    expect(respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({ optionId: 'plan-accept-edits' })
    )
    expect(sendMessage).toHaveBeenCalledWith('add tests')
  })
})
