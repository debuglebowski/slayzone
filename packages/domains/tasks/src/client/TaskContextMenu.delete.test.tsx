// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  toast
}))

const { TaskContextMenu } = await import('./TaskContextMenu')

const task = { id: 't1', title: 'Ship it', status: 'todo', priority: 3 } as Task

function setup(onDeleteTask: (id: string) => Promise<void>) {
  render(
    <TaskContextMenu
      task={task}
      projects={[]}
      onUpdateTask={vi.fn()}
      onArchiveTask={vi.fn()}
      onDeleteTask={onDeleteTask}
    >
      <div>Ship it row</div>
    </TaskContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('Ship it row'))
  fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('awaits the delete and reports a failure instead of leaving it unhandled', async () => {
  const onDeleteTask = vi.fn(async () => {
    throw new Error('hub offline')
  })
  setup(onDeleteTask)
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't delete task: hub offline"))
  expect(onDeleteTask).toHaveBeenCalledWith('t1')
})

it('a refusal the delete already reported is not reported twice', async () => {
  const { TaskNotDeletedError } = await import('@slayzone/task/client')
  const onDeleteTask = vi.fn(async () => {
    throw new TaskNotDeletedError('Task is linked to an external provider.')
  })
  setup(onDeleteTask)
  await waitFor(() => expect(onDeleteTask).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 0))
  expect(toast.error).not.toHaveBeenCalled()
})
