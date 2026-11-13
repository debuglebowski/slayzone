// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'

const getDeleted = vi.fn()
const restore = vi.fn()
const update = vi.fn()
const noteTaskHub = vi.fn()
const remote = {
  task: {
    getDeleted: { query: getDeleted },
    restore: { mutate: restore },
    update: { mutate: update }
  },
  notify: { onTasksChanged: { subscribe: () => ({ unsubscribe: vi.fn() }) } }
}
const resolveHub = vi.fn(() => remote)
vi.mock('./trpc', () => ({ useTRPCClient: () => ({}), getClientForHub: resolveHub }))
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForProject: () => 'remote',
  useHubOwnershipStore: { getState: () => ({ noteTaskHub }) }
}))
const { ProjectTaskLibrary } = await import('./ProjectTaskLibrary')
const project = { id: 'p', name: 'Dummy', columns_config: null } as Project
const scratch = { id: 't', project_id: 'p', title: 'Terminal 1', is_temporary: true } as Task
const deleted = { ...scratch, id: 'deleted', title: 'Deleted terminal', deleted_at: '2026-11-02' }

function setup(tasks: Task[] = [scratch]) {
  const onOpen = vi.fn()
  const onUpdate = vi.fn()
  const onDelete = vi.fn(async () => undefined)
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProjectTaskLibrary
        project={project}
        tasks={tasks}
        onOpen={onOpen}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Scratch terminals (1)' }))
  return { onOpen, onUpdate, onDelete }
}
beforeEach(() => {
  vi.clearAllMocks()
  getDeleted.mockResolvedValue([deleted])
  restore.mockResolvedValue({ ...deleted, deleted_at: null })
  update.mockResolvedValue({ ...scratch, is_temporary: false })
})
afterEach(cleanup)

it('reopens a saved scratch terminal without restoring or deleting it', () => {
  const { onOpen, onDelete } = setup([
    scratch,
    { ...scratch, id: 'other', project_id: 'other', title: 'Other project' }
  ])
  expect(screen.queryByText('Other project')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(onOpen).toHaveBeenCalledWith(scratch)
  expect(restore).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

it('promotes a scratch terminal on its remote hub', async () => {
  const { onUpdate } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Save as task' }))
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ is_temporary: false }))
  )
  expect(resolveHub).toHaveBeenCalledWith('remote', expect.anything())
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 't', isTemporary: false }))
})

it('only deletes on an explicit Delete action', async () => {
  const { onDelete } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(onDelete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith('t'))
})

it('does not offer recoverable Trash or query deleted content', () => {
  setup()
  expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull()
  expect(getDeleted).not.toHaveBeenCalled()
})
