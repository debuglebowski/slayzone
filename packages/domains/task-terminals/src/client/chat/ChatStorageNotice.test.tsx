// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatStorageNotice } from './ChatStorageNotice'
afterEach(cleanup)
test('offline notice names the owning computer and offers explicit Retry', () => {
  const retry = vi.fn()
  render(
    <ChatStorageNotice
      status={{ state: 'offline', computer: { id: 'pc', name: 'Office Mac' } }}
      onRetry={retry}
    />
  )
  expect(screen.getByRole('status').textContent).toContain('Office Mac is offline')
  expect(screen.getByText(/Chat is stored there/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledTimes(1)
})
test('migration explains why an active task must wait', () => {
  render(
    <ChatStorageNotice
      status={{
        state: 'migrating',
        computer: { id: 'pc', name: 'Laptop' },
        waitingForAgents: true
      }}
      onRetry={() => undefined}
    />
  )
  expect(screen.getByText(/Stop this task’s agents/)).toBeTruthy()
})
test.each(['ready', 'preparing'] as const)(
  '%s storage has no separate notice; a history load failure remains retryable',
  (state) => {
    const { rerender } = render(
      <ChatStorageNotice
        status={{ state, computer: { id: 'pc', name: 'Laptop' } }}
        onRetry={() => undefined}
      />
    )
    expect(screen.queryByRole('status')).toBeNull()
    rerender(
      <ChatStorageNotice
        status={{ state, computer: { id: 'pc', name: 'Laptop' } }}
        error="Storage cannot be read"
        onRetry={() => undefined}
      />
    )
    expect(screen.getByText('Storage cannot be read')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  }
)
