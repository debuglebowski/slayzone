// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { TooltipProvider } from '@slayzone/ui'

vi.mock('convex/react', () => ({ useAction: () => vi.fn() }))

import { FeedbackDialog } from './FeedbackDialog'

const THREAD = {
  id: 't1',
  title: 'Thread one',
  discord_thread_id: null,
  created_at: '2026-01-01 00:00:00'
}
const MESSAGE = {
  id: 'm1',
  thread_id: 't1',
  content: 'First message',
  created_at: '2026-01-01 00:00:00'
}

let wrapper: (props: { children: ReactNode }) => ReactNode
let listThreads: Mock<() => (typeof THREAD)[]>

beforeEach(() => {
  // jsdom has no layout: the messages auto-scroll calls this.
  Element.prototype.scrollIntoView = vi.fn()
  listThreads = vi.fn(() => [THREAD])
  wrapper = createTrpcTest({
    procedures: {
      'feedback.listThreads': listThreads,
      'feedback.getMessages': () => [MESSAGE]
    }
  }).wrapper
})

afterEach(() => {
  cleanup()
})

function renderDialog() {
  const Wrapper = wrapper
  return render(
    <Wrapper>
      <TooltipProvider>
        <FeedbackDialog />
      </TooltipProvider>
    </Wrapper>
  )
}

/** Opens via the sidebar button and lets the thread list land. */
async function openDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
  })
  await screen.findByText('Thread one')
}

async function closeDialog() {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
}

const composeBox = () => screen.queryByRole('textbox')
const startScreen = () => screen.queryByText('Send us feedback')
/** The sidebar's + button (the start screen also has a "New feedback" text button). */
const newFeedbackIcon = () => screen.getByLabelText('New feedback')

describe('FeedbackDialog reopen', () => {
  it('opens on the start screen with the thread list loaded', async () => {
    renderDialog()
    await openDialog()
    expect(startScreen()).not.toBeNull()
    expect(composeBox()).toBeNull()
    expect(listThreads).toHaveBeenCalledTimes(1)
  })

  it('reopening after a draft starts clean and reloads threads', async () => {
    renderDialog()
    await openDialog()
    fireEvent.click(screen.getAllByRole('button', { name: /New feedback/ })[0])
    fireEvent.change(composeBox() as HTMLTextAreaElement, { target: { value: 'draft' } })
    await closeDialog()

    await openDialog()
    expect(startScreen()).not.toBeNull()
    expect(composeBox()).toBeNull()
    expect(screen.queryByDisplayValue('draft')).toBeNull()
    expect(listThreads).toHaveBeenCalledTimes(2)
  })

  it('reopening after viewing a thread starts clean', async () => {
    renderDialog()
    await openDialog()
    fireEvent.click(screen.getByText('Thread one'))
    await screen.findByText('First message')
    await closeDialog()

    await openDialog()
    expect(startScreen()).not.toBeNull()
    expect(screen.queryByText('First message')).toBeNull()
  })

  it('selecting a thread shows its messages and a reply box', async () => {
    renderDialog()
    await openDialog()
    fireEvent.click(screen.getByText('Thread one'))
    await screen.findByText('First message')
    expect((composeBox() as HTMLTextAreaElement).placeholder).toBe('Reply…')
  })

  it('reopening after a thread focuses what a first open focuses', async () => {
    renderDialog()
    await openDialog()
    const firstOpenFocus = document.activeElement
    expect(firstOpenFocus).toBe(newFeedbackIcon())
    fireEvent.click(screen.getByText('Thread one'))
    await screen.findByText('First message')
    await closeDialog()

    await openDialog()
    await act(async () => {})
    expect(document.activeElement).toBe(newFeedbackIcon())
  })
})
