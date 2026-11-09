// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { Task } from '@slayzone/task-contracts'

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  toast
}))

const { DeleteTaskDialog } = await import('./DeleteTaskDialog')

const task = { id: '00000000-0000-4000-8000-000000000001', title: 'Ship it' } as Task

function setup(opts: { deleteResult?: unknown; onDeleteTask?: (id: string) => Promise<void> }) {
  const remoteDelete = vi.fn(async () => opts.deleteResult)
  const { wrapper: Wrapper } = createTrpcTest({ procedures: { 'task.delete': remoteDelete } })
  const onDeleted = vi.fn()
  render(
    <Wrapper>
      <DeleteTaskDialog
        task={task}
        open
        onOpenChange={vi.fn()}
        onDeleted={onDeleted}
        onDeleteTask={opts.onDeleteTask}
      />
    </Wrapper>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  return { remoteDelete, onDeleted }
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('DeleteTaskDialog without onDeleteTask', () => {
  it('a task linked to a provider is not deleted and says why', async () => {
    const { remoteDelete, onDeleted } = setup({
      deleteResult: { blocked: true, reason: 'linked_to_provider' }
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Unlink this task from its external provider before deleting it.'
      )
    )
    expect(remoteDelete).toHaveBeenCalledTimes(1)
    expect(onDeleted).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('incomplete erasure deletes the task and names the computers still holding data', async () => {
    const { onDeleted } = setup({
      deleteResult: {
        incomplete: true,
        erasure: {
          computers: [
            { name: 'Laptop', deleted: false },
            { name: 'Desk', deleted: true }
          ]
        }
      }
    })
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(toast.warning).toHaveBeenCalledWith('Data on Laptop has not been deleted yet.')
  })

  it('a completed delete reports success', async () => {
    const { onDeleted } = setup({ deleteResult: true })
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Task permanently deleted.')
  })
})

describe('DeleteTaskDialog with onDeleteTask', () => {
  it('a failed delete is reported, not left unhandled, and onDeleted does not run', async () => {
    const onDeleteTask = vi.fn(async () => {
      throw new Error('hub offline')
    })
    const { onDeleted, remoteDelete } = setup({ onDeleteTask })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't delete task: hub offline")
    )
    expect(onDeleteTask).toHaveBeenCalledWith(task.id)
    expect(remoteDelete).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
