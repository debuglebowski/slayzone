// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { TooltipProvider } from '@slayzone/ui'
import type { Task } from '@slayzone/task-contracts'

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  toast
}))
vi.mock('@slayzone/terminal', () => ({ PtyProgressDot: () => null }))

const { TaskOverviewRow } = await import('./TaskOverviewRow')

const sub = { id: 'sub-1', title: 'Write docs', status: 'todo', priority: 3, progress: 0 } as Task

function setup(onDelete: (id: string) => Promise<void>) {
  const { wrapper: Wrapper } = createTrpcTest({ procedures: {} })
  render(
    <Wrapper>
      <TooltipProvider>
        <TaskOverviewRow
          sub={sub}
          statusOptions={[{ value: 'todo', label: 'Todo' }]}
          onUpdate={vi.fn()}
          onDelete={onDelete}
        />
      </TooltipProvider>
    </Wrapper>
  )
  fireEvent.contextMenu(screen.getByText('Write docs'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('asks before deleting a subtask, with the task delete wording', async () => {
  const onDelete = vi.fn(async () => undefined)
  setup(onDelete)
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain(
    'Permanently delete "Write docs" and its SlayZone files and history? This cannot be undone.'
  )
  expect(onDelete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith('sub-1'))
})

it('cancel keeps the subtask', async () => {
  const onDelete = vi.fn(async () => undefined)
  setup(onDelete)
  await screen.findByRole('alertdialog')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(onDelete).not.toHaveBeenCalled()
})
