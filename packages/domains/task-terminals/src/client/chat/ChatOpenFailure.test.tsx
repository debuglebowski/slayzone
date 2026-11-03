// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatOpenFailure } from './ChatOpenFailure'
afterEach(cleanup)
const CAUSE = 'Provider conversation belongs to another storage owner'
test('one plain title and Retry; the raw cause only behind Details', () => {
  const retry = vi.fn()
  render(
    <ChatOpenFailure
      status={{ state: 'ready', computer: { id: 'pc', name: 'Laptop' } }}
      error={CAUSE}
      placement="center"
      onRetry={retry}
    />
  )
  expect(screen.getByText('Couldn’t open this chat')).toBeTruthy()
  expect(screen.queryByText(CAUSE)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getAllByText(CAUSE)).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  expect(screen.queryByText(CAUSE)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledTimes(1)
})
test('a storage state titles the failure instead of the generic title', () => {
  render(
    <ChatOpenFailure
      status={{ state: 'offline', computer: { id: 'pc', name: 'Office Mac' } }}
      error="hub unreachable"
      placement="bottom"
      onRetry={() => undefined}
    />
  )
  expect(screen.getByText('Office Mac is offline')).toBeTruthy()
  expect(screen.getByText(/Chat is stored there/)).toBeTruthy()
  expect(screen.queryByText('Couldn’t open this chat')).toBeNull()
})
test('a deleted chat offers no Retry', () => {
  render(
    <ChatOpenFailure
      status={{ state: 'deleted', computer: null }}
      error="gone"
      placement="center"
      onRetry={() => undefined}
    />
  )
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
