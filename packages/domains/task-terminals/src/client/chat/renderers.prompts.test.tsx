// @vitest-environment jsdom
import type React from 'react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'
import { expectKnownBug } from '@slayzone/test-utils/known-bug'

// Diff/markdown viewers are irrelevant to the prompt cards and heavy to load.
vi.mock('@slayzone/diff-view', () => ({
  DiffView: () => null
}))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { ChatViewContext, type ChatViewState } from './ChatViewContext'
import {
  PLAN_APPROVED_MARKER,
  PLAN_CANCELLED_MARKER,
  ToolCallAskUserQuestion,
  ToolCallExitPlanMode
} from './renderers'

/** Context with a controllable timeline + callbacks; everything else default. */
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
    <ChatViewContext.Provider value={{ ...base, timeline, ...overrides }}>
      {children}
    </ChatViewContext.Provider>
  )
}

const toolItem = (invocation: ToolInvocation) =>
  ({ kind: 'tool', invocation, timestamp: 0 }) as unknown as TimelineItem
const userText = (text: string) =>
  ({ kind: 'user-text', text, timestamp: 0 }) as unknown as TimelineItem

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name })

afterEach(cleanup)

// --- AskUserQuestion ---

type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string }>
}

const COLOR: Question = {
  question: 'Which color do you prefer?',
  header: 'Color',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'Pick red' },
    { label: 'Blue', description: 'Pick blue' }
  ]
}
const FRUITS: Question = {
  question: 'Which fruits?',
  header: 'Fruits',
  multiSelect: true,
  options: [
    { label: 'Apple', description: '' },
    { label: 'Pear', description: '' },
    { label: 'Plum', description: '' }
  ]
}

const ask = (questions: Question[], over: Partial<ToolInvocation> = {}): ToolInvocation =>
  ({
    id: 'toolu_ask',
    name: 'AskUserQuestion',
    status: 'pending',
    input: { questions },
    ...over
  }) as unknown as ToolInvocation

const sendMessage = vi.fn<(text: string) => void>()
const respondPermission = vi.fn<NonNullable<ChatViewState['respondPermission']>>()
const abortAgent = vi.fn<() => Promise<void>>()

function renderAsk(invocation: ToolInvocation, overrides: Partial<ChatViewState> = {}) {
  return render(
    <View timeline={[toolItem(invocation)]} overrides={overrides}>
      <ToolCallAskUserQuestion invocation={invocation} />
    </View>
  )
}

/** A live `can_use_tool` request for the ask, as the stdio permission channel delivers it. */
const pending = (invocation: ToolInvocation) =>
  new Map([
    [
      invocation.id,
      { requestId: 'req-1', toolName: 'AskUserQuestion', input: invocation.input as unknown }
    ]
  ])

const pick = (label: string | RegExp) => fireEvent.click(button(label))
const otherFor = (index = 0) => screen.getAllByRole('button', { name: 'Other…' })[index]
const otherInput = () => screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement

beforeEach(() => {
  sendMessage.mockReset()
  respondPermission.mockReset().mockResolvedValue(true)
  abortAgent.mockReset().mockResolvedValue(undefined)
})

describe('AskUserQuestion choosing', () => {
  it('a single-select pick replaces the previous one', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    pick(/Red/)
    pick(/Blue/)
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Color: Blue')
  })

  it('a multi-select pick toggles, keeping pick order', () => {
    renderAsk(ask([FRUITS]), { sendMessage })
    pick(/Plum/)
    pick(/Apple/)
    pick(/Pear/)
    pick(/Pear/)
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Fruits: Plum, Apple')
  })

  it('"Other…" opens a free-text answer that replaces the picked options', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    pick(/Red/)
    expect(screen.queryByPlaceholderText('Type your answer…')).toBeNull()
    fireEvent.click(otherFor())
    fireEvent.change(otherInput(), { target: { value: '  teal  ' } })
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Color: teal')
  })

  it('picking an option again closes the "Other…" answer', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    fireEvent.click(otherFor())
    expect(otherInput()).toBeDefined()
    pick(/Blue/)
    expect(screen.queryByPlaceholderText('Type your answer…')).toBeNull()
  })

  it('Cmd+Enter or Ctrl+Enter in the "Other…" answer submits; plain Enter does not', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    fireEvent.click(otherFor())
    fireEvent.change(otherInput(), { target: { value: 'teal' } })
    fireEvent.keyDown(otherInput(), { key: 'Enter' })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(otherInput(), { key: 'Enter', ctrlKey: true })
    expect(sendMessage).toHaveBeenCalledWith('Color: teal')
  })

  it('Cmd+Enter submits too', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    fireEvent.click(otherFor())
    fireEvent.change(otherInput(), { target: { value: 'teal' } })
    fireEvent.keyDown(otherInput(), { key: 'Enter', metaKey: true })
    expect(sendMessage).toHaveBeenCalledWith('Color: teal')
  })
})

describe('AskUserQuestion submit gating', () => {
  it('Submit stays disabled until every question has an answer', () => {
    renderAsk(ask([COLOR, FRUITS]), { sendMessage })
    expect(button('Submit').disabled).toBe(true)
    pick(/Blue/)
    expect(button('Submit').disabled).toBe(true)
    pick(/Pear/)
    expect(button('Submit').disabled).toBe(false)
  })

  it('a multi-select with everything unticked counts as unanswered', () => {
    renderAsk(ask([FRUITS]), { sendMessage })
    pick(/Pear/)
    pick(/Pear/)
    expect(button('Submit').disabled).toBe(true)
  })

  it('an "Other…" answer needs non-blank text', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    fireEvent.click(otherFor())
    fireEvent.change(otherInput(), { target: { value: '   ' } })
    expect(button('Submit').disabled).toBe(true)
    fireEvent.change(otherInput(), { target: { value: 'teal' } })
    expect(button('Submit').disabled).toBe(false)
  })

  it('without any way to answer, Submit and Cancel are disabled and the footer says why', () => {
    renderAsk(ask([COLOR]))
    pick(/Blue/)
    expect(screen.getByText('Cannot submit — chat send unavailable.')).toBeDefined()
    expect(button('Submit').disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
  })

  it('a card with no questions says so and offers no Submit', () => {
    renderAsk(ask([]), { sendMessage })
    expect(screen.getByText('No questions provided.')).toBeDefined()
    expect(queryButton('Submit')).toBeNull()
  })
})

describe('AskUserQuestion submit', () => {
  it('with a pending permission request, resolves it with the answers merged into the input', () => {
    const inv = ask([COLOR, FRUITS])
    renderAsk(inv, { sendMessage, respondPermission, permissionRequests: pending(inv) })
    expect(screen.getByText('Submit resolves the tool with your answers.')).toBeDefined()
    pick(/Blue/)
    pick(/Apple/)
    pick(/Plum/)
    fireEvent.click(button('Submit'))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'req-1',
      decision: {
        behavior: 'allow',
        updatedInput: {
          questions: [COLOR, FRUITS],
          answers: { 'Which color do you prefer?': 'Blue', 'Which fruits?': 'Apple, Plum' }
        }
      }
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a pending request for another tool id falls back to a chat message', () => {
    const inv = ask([COLOR])
    renderAsk(inv, {
      sendMessage,
      respondPermission,
      permissionRequests: pending({ ...inv, id: 'toolu_other' })
    })
    pick(/Blue/)
    fireEvent.click(button('Submit'))
    expect(respondPermission).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith('Color: Blue')
  })

  it('without a pending request, sends one "header: answer" line per question', () => {
    renderAsk(ask([COLOR, FRUITS]), { sendMessage })
    expect(screen.getByText('Answer is sent as your next chat message.')).toBeDefined()
    pick(/Red/)
    pick(/Pear/)
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Color: Red\nFruits: Pear')
  })

  it('a line falls back to the question, then to "Q<n>", when there is no header', () => {
    const noHeader: Question = { ...COLOR, header: '' }
    const blank: Question = { ...FRUITS, question: '', header: '' }
    renderAsk(ask([noHeader, blank]), { sendMessage })
    pick(/Red/)
    pick(/Pear/)
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Which color do you prefer?: Red\nQ2: Pear')
  })

  it('after submitting, the card shows the answer and cannot be answered again', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    pick(/Blue/)
    fireEvent.click(button('Submit'))
    expect(screen.getByText('Color: Blue')).toBeDefined()
    expect(queryButton('Submit')).toBeNull()
    expect(button(/Red/).disabled).toBe(true)
    pick(/Red/)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('stays answerable when the SDK already auto-closed the tool (status/denied are ignored)', () => {
    renderAsk(ask([COLOR], { status: 'denied', denied: true }), { sendMessage })
    pick(/Blue/)
    fireEvent.click(button('Submit'))
    expect(sendMessage).toHaveBeenCalledWith('Color: Blue')
  })

  it('an invocation answered before a reload is not answerable again', async () => {
    const answered = ask([COLOR], {
      status: 'done',
      result: {
        rawContent:
          'Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue with these answers in mind.',
        structured: { questions: [COLOR], answers: { 'Which color do you prefer?': 'Blue' } },
        isError: false
      }
    })
    renderAsk(answered, { sendMessage })
    expect(screen.getByText('Which color do you prefer?')).toBeDefined()

    // Try to answer again through whatever the card still offers.
    const red = queryButton(/Red/) as HTMLButtonElement | null
    if (red && !red.disabled) fireEvent.click(red)
    const submit = queryButton('Submit') as HTMLButtonElement | null
    if (submit && !submit.disabled) fireEvent.click(submit)

    await expectKnownBug(
      {
        fixedBy: '2.2',
        what: 'an answered AskUserQuestion card is answerable again after a reload'
      },
      () => expect(sendMessage).not.toHaveBeenCalled()
    )
  })
})

describe('AskUserQuestion cancel', () => {
  it('interrupts the agent when it can, and nothing else', () => {
    const inv = ask([COLOR])
    renderAsk(inv, { sendMessage, respondPermission, abortAgent, permissionRequests: pending(inv) })
    fireEvent.click(button('Cancel'))
    expect(abortAgent).toHaveBeenCalledTimes(1)
    expect(respondPermission).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('without abortAgent, denies the pending permission request', () => {
    const inv = ask([COLOR])
    renderAsk(inv, { sendMessage, respondPermission, permissionRequests: pending(inv) })
    fireEvent.click(button('Cancel'))
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: 'req-1',
      decision: { behavior: 'deny', message: 'User cancelled the question.' }
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('without abortAgent or a pending request, sends "Cancelled"', () => {
    renderAsk(ask([COLOR]), { sendMessage })
    fireEvent.click(button('Cancel'))
    expect(sendMessage).toHaveBeenCalledWith('Cancelled')
  })

  it('locks the card and shows "Cancelled"', () => {
    renderAsk(ask([COLOR]), { abortAgent })
    fireEvent.click(button('Cancel'))
    expect(screen.getByText('Cancelled')).toBeDefined()
    expect(queryButton('Cancel')).toBeNull()
    expect(button(/Blue/).disabled).toBe(true)
  })
})

// --- ExitPlanMode ---

const planCall = (id: string, over: Partial<ToolInvocation> = {}): ToolInvocation =>
  ({
    id,
    name: 'ExitPlanMode',
    status: 'denied',
    denied: true,
    input: { plan: `Plan ${id}: create hello.txt` },
    ...over
  }) as unknown as ToolInvocation

const setChatMode = vi.fn<NonNullable<ChatViewState['setChatMode']>>()

function renderPlan(
  invocation: ToolInvocation,
  timeline: TimelineItem[] = [toolItem(invocation)],
  overrides: Partial<ChatViewState> = { sendMessage, setChatMode }
) {
  return render(
    <View timeline={timeline} overrides={overrides}>
      <ToolCallExitPlanMode invocation={invocation} />
    </View>
  )
}

const approvePrompt = () => screen.queryByText('Approve plan?')

beforeEach(() => {
  setChatMode.mockReset().mockResolvedValue(undefined)
})

describe('ExitPlanMode card', () => {
  it('renders the plan', () => {
    renderPlan(planCall('p1'))
    expect(screen.getByText('Plan p1: create hello.txt')).toBeDefined()
  })

  it('offers approval for the latest denied plan', () => {
    renderPlan(planCall('p1'))
    expect(approvePrompt()).not.toBeNull()
  })

  it('offers no approval when the plan was not denied', () => {
    renderPlan(planCall('p1', { status: 'done', denied: false }))
    expect(approvePrompt()).toBeNull()
  })

  it('offers no approval on a plan superseded by a later one', () => {
    const first = planCall('p1')
    renderPlan(first, [toolItem(first), toolItem(planCall('p2'))])
    expect(approvePrompt()).toBeNull()
  })

  it.each([
    ['approved', PLAN_APPROVED_MARKER],
    ['cancelled', PLAN_CANCELLED_MARKER]
  ])('offers no approval once the plan was %s', (_name, marker) => {
    const plan = planCall('p1')
    renderPlan(plan, [toolItem(plan), userText(marker)])
    expect(approvePrompt()).toBeNull()
  })

  it('ordinary user text after the plan, or a marker before it, does not resolve it', () => {
    const plan = planCall('p1')
    renderPlan(plan, [userText(PLAN_APPROVED_MARKER), toolItem(plan), userText('Approved')])
    expect(approvePrompt()).not.toBeNull()
  })
})

describe('ExitPlanMode approval', () => {
  it('Cancel sends the cancel marker', () => {
    renderPlan(planCall('p1'))
    fireEvent.click(button('Cancel'))
    expect(sendMessage).toHaveBeenCalledWith(PLAN_CANCELLED_MARKER)
    expect(setChatMode).not.toHaveBeenCalled()
  })

  it('Cancel is disabled without sendMessage', () => {
    renderPlan(planCall('p1'), undefined, { setChatMode })
    expect(button('Cancel').disabled).toBe(true)
  })

  it('"Approve & exit plan" is absent without setChatMode', () => {
    renderPlan(planCall('p1'), undefined, { sendMessage })
    expect(approvePrompt()).not.toBeNull()
    expect(queryButton('Approve & exit plan')).toBeNull()
  })

  it('approving switches to auto-accept, then sends the approval marker', async () => {
    let finishModeSwitch = () => {}
    setChatMode.mockReturnValue(
      new Promise<void>((r) => {
        finishModeSwitch = r
      })
    )
    renderPlan(planCall('p1'))
    fireEvent.click(button('Approve & exit plan'))
    expect(setChatMode).toHaveBeenCalledWith('auto-accept')
    expect(sendMessage).not.toHaveBeenCalled()
    await act(async () => finishModeSwitch())
    expect(sendMessage).toHaveBeenCalledWith(PLAN_APPROVED_MARKER)
  })

  it('a failed mode switch sends nothing', async () => {
    setChatMode.mockRejectedValue(new Error('respawn failed'))
    renderPlan(planCall('p1'))
    await act(async () => {
      fireEvent.click(button('Approve & exit plan'))
    })
    expect(setChatMode).toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
