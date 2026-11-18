// @vitest-environment jsdom
/**
 * The start-failure card: Retry starts the agent again, says so while it does,
 * and a card the agent started after is history — no Retry to kill that agent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'

const { ChatViewContext, defaultChatView } = await import('./ChatViewContext')
const { AgentProblemCard } = await import('./AgentProblemCard')

type Problem = Extract<TimelineItem, { kind: 'agent-problem' }>
const problem = (over: Partial<Problem> = {}): Problem => ({
  kind: 'agent-problem',
  code: 'spawn-failed',
  message: 'Process start was cancelled',
  timestamp: 1,
  ...over
})

function card(item: Problem, over: Record<string, unknown> = {}) {
  return render(
    <ChatViewContext.Provider value={{ ...defaultChatView, ...over }}>
      <AgentProblemCard item={item} />
    </ChatViewContext.Provider>
  )
}

afterEach(() => cleanup())

describe('AgentProblemCard', () => {
  it('Retry starts the agent again', () => {
    const restartAgent = vi.fn()
    card(problem(), { restartAgent })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(restartAgent).toHaveBeenCalledTimes(1)
  })

  it('while the agent is starting again, Retry is busy and does nothing', () => {
    const restartAgent = vi.fn()
    card(problem(), { restartAgent, restartingAgent: true })
    const button = screen.getByRole('button', { name: 'Retrying…' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it('a card the agent started after says so and offers no Retry', () => {
    const restartAgent = vi.fn()
    card(problem({ resolved: true }), { restartAgent, takeOver: vi.fn() })
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.body.textContent).toContain('The agent started after this')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
