/**
 * Timeline rows that need the chat they belong to (`ChatViewContext`): the card of an
 * agent that could not start, with desktop's ways out.
 */
import type { TimelineItem } from '@slayzone/terminal/reducer'
import { render, screen, userEvent } from '@testing-library/react-native'
import { ChatViewContext, type ChatViewValue } from './ChatViewContext'
import { TimelineRow } from './TimelineRow'

function view(over: Partial<ChatViewValue> = {}): ChatViewValue {
  return {
    tabId: 't1',
    retryMessage: jest.fn(),
    prompts: [],
    restartAgent: jest.fn(),
    takeOver: jest.fn(),
    ...over
  }
}

const problem = (code: string): TimelineItem => ({
  kind: 'agent-problem',
  code,
  message: 'This conversation is running in the terminal.',
  timestamp: 0
})

describe('TimelineRow: an agent that could not start', () => {
  it('offers to continue a conversation the terminal runs here (desktop "Continue here")', async () => {
    const value = view()
    await render(
      <ChatViewContext.Provider value={value}>
        <TimelineRow item={problem('conversation-in-use')} />
      </ChatViewContext.Provider>
    )
    expect(screen.getByText('This conversation is running in the terminal')).toBeOnTheScreen()
    expect(screen.getByText(/One conversation runs in one place at a time/)).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('Continue here'))
    expect(value.takeOver).toHaveBeenCalledTimes(1)
    expect(value.restartAgent).not.toHaveBeenCalled()
  })

  it('names a refused start and offers Retry only', async () => {
    const value = view()
    await render(
      <ChatViewContext.Provider value={value}>
        <TimelineRow item={problem('spawn-refused')} />
      </ChatViewContext.Provider>
    )
    expect(screen.getByText('The computer refused to start the agent')).toBeOnTheScreen()
    expect(screen.queryByText('Continue here')).toBeNull()
    await userEvent.setup().press(screen.getByText('Retry'))
    expect(value.restartAgent).toHaveBeenCalledTimes(1)
  })
})
