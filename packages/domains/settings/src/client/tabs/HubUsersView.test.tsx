// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HubUsersView } from './HubUsersView'

afterEach(cleanup)
const users = [
  { id: 'alice', name: 'Alice', email: 'alice@example.com', disabledAt: null },
  { id: 'bob', name: 'Bob', email: 'bob@example.com', disabledAt: '2026-11-09' }
]
const report = {
  id: 'job',
  state: 'incomplete' as const,
  counts: { projects: 1, tasks: 2, artifacts: 3, versions: 4 },
  computers: [{ id: 'pc', name: 'Bob laptop', deleted: false }],
  failures: [],
  retainedSharedBlobs: 0,
  retainedBackupBlobs: 0
}
function setup() {
  const onDisable = vi.fn(async () => undefined)
  const onErase = vi.fn(async () => report)
  render(
    <HubUsersView
      users={users}
      reports={[]}
      statusUserId={null}
      onShowReports={() => {}}
      onDisable={onDisable}
      onErase={onErase}
      onRetry={async () => report}
      onPreview={async () => ({ counts: report.counts })}
    />
  )
  return { onDisable, onErase }
}
test('Disable requires its own confirmation modal and never erases content', async () => {
  const { onDisable, onErase } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Disable Alice' }))
  expect(onDisable).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Disable user' }))
  await waitFor(() => expect(onDisable).toHaveBeenCalledWith('alice@example.com'))
  expect(onErase).not.toHaveBeenCalled()
})
test('only disabled users get erasure; confirming the wrong identity never submits', async () => {
  const { onErase } = setup()
  expect(screen.queryByRole('button', { name: 'Erase content for Alice' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Erase content for Bob' }))
  await screen.findByText('1 project · 2 tasks · 3 files · 4 saved versions')
  const button = screen.getByRole('button', { name: 'Erase all content' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm user email'), {
    target: { value: 'alice@example.com' }
  })
  expect(button.disabled).toBe(true)
  expect(onErase).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Confirm user email'), {
    target: { value: 'bob@example.com' }
  })
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(onErase).toHaveBeenCalledWith('bob', 'bob@example.com'))
})
