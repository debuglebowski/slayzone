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
test('while the hub reconnects: a waiting state, no failure, no Retry', () => {
  render(
    <ChatOpenFailure
      status={null}
      error="Lost connection to hub ws://127.0.0.1:1/trpc (socket close, code 1006)"
      placement="bottom"
      reconnecting="hub"
      onRetry={() => undefined}
    />
  )
  expect(screen.getByTestId('chat-open-reconnecting')).toBeTruthy()
  expect(screen.getByText('Reconnecting…')).toBeTruthy()
  expect(screen.getByText(/reopens by itself/)).toBeTruthy()
  expect(screen.queryByText('Couldn’t open this chat')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
test('while the reopen runs: says so instead of the old failure', () => {
  render(
    <ChatOpenFailure
      status={null}
      error="boom"
      placement="center"
      reconnecting="reopen"
      onRetry={() => undefined}
    />
  )
  expect(screen.getByText('Reopening chat…')).toBeTruthy()
  expect(screen.queryByText('Couldn’t open this chat')).toBeNull()
})
