// @vitest-environment jsdom
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'

vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { ChatViewContext, defaultChatView } from './ChatViewContext'
import { renderTimelineItem } from './renderers'

const NOW = 100_000

const retry: Extract<TimelineItem, { kind: 'api-retry' }> = {
  kind: 'api-retry',
  attempt: 7,
  maxRetries: 10,
  delayMs: 34_765,
  error: 'unknown',
  errorStatus: null,
  timestamp: NOW - 10_000,
  firstTimestamp: NOW - 80_000
}
const after: TimelineItem = {
  kind: 'text',
  role: 'assistant',
  messageId: 'm',
  text: 'went through',
  blockOrdinal: 0,
  timestamp: NOW
}

function ui(timeline: TimelineItem[], inFlight: boolean) {
  return (
    <ChatViewContext.Provider value={{ ...defaultChatView, timeline, inFlight }}>
      {renderTimelineItem(retry, 'r')}
    </ChatViewContext.Provider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('API retry row', () => {
  it('live (newest row, turn running): attempt, countdown to the next one, why', () => {
    render(ui([retry], true))
    const row = screen.getByTestId('api-retry')
    expect(row.dataset.live).toBe('true')
    expect(row.textContent).toBe(
      'Retrying API request · attempt 7/10 · next in 25s · no response from API'
    )
  })

  it('settled once anything follows: how many retries, over how long, why', () => {
    render(ui([retry, after], true))
    const row = screen.getByTestId('api-retry')
    expect(row.dataset.live).toBe('false')
    expect(row.textContent).toBe('API request retried 7× over 1m 10s · no response from API')
  })

  it('settled when the turn is over, even as the newest row', () => {
    render(ui([retry], false))
    expect(screen.getByTestId('api-retry').dataset.live).toBe('false')
  })
})
