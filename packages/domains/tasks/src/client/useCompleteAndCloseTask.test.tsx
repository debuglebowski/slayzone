// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { getDoneStatus, type Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'

const mutate = vi.fn()
const restore = vi.fn()
const ptyKill = vi.fn()
const client = {
  task: { update: { mutate }, restore: { mutate: restore } },
  pty: { kill: { mutate: ptyKill } }
}
const tabState = {
  tabs: [] as Array<{ type: string; taskId?: string }>,
  _taskLookup: { tasks: [] as Task[] },
  closeTab: vi.fn()
}

vi.mock('@slayzone/transport/client', () => ({
  getClientForHub: () => client,
  getHubIdForTask: () => undefined,
  useHubOwnershipStore: { getState: () => ({ noteTaskHub: vi.fn() }) },
  useTRPCClient: () => client
}))
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/tabs-state', () => ({
  useTabStore: Object.assign(() => undefined, {
    getState: () => tabState,
    setState: vi.fn()
  })
}))
const toast = Object.assign(vi.fn(), { error: vi.fn() })
vi.mock('@slayzone/ui', () => ({ toast }))

const { useCompleteAndCloseTask } = await import('./useCompleteAndCloseTask')
const { useCloseTaskTab } = await import('./useCloseTaskTab')

const project = { id: 'p1', columns_config: null } as unknown as Project
const DONE = getDoneStatus(null)
const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    project_id: 'p1',
    title: 'T',
    status: 'in_progress',
    ...over
  }) as Task

/** A promise the test settles by hand — the hub write "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(t: Task = task()) {
  const updateTask = vi.fn()
  const closeTabByTaskId = vi.fn(async () => undefined)
  const openTask = vi.fn()
  const undo = { push: vi.fn(), undo: vi.fn() }
  const { result } = renderHook(() =>
    useCompleteAndCloseTask(
      {
        tasks: [t],
        projects: [project],
        updateTask,
        closeTabByTaskId,
        openTask
      },
      undo
    )
  )
  return {
    complete: result.current,
    updateTask,
    closeTabByTaskId,
    openTask,
    undo
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tabState.tabs = [{ type: 'home' }, { type: 'task', taskId: 't1' }]
  tabState._taskLookup = { tasks: [] }
})
afterEach(cleanup)

describe('useCompleteAndCloseTask (⌘⇧D)', () => {
  it('flips the status and closes the tab at once, before the hub answers', () => {
    const write = deferred<Task>()
    mutate.mockReturnValue(write.promise)
    const { complete, updateTask, closeTabByTaskId } = setup()

    void complete('t1')

    // Same synchronous turn as the click: one render shows done + closed together.
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', status: DONE }))
    expect(closeTabByTaskId).toHaveBeenCalledWith('t1', {
      after: expect.any(Promise)
    })
  })

  it('lands the server row and pushes undo once the write succeeds', async () => {
    const server = task({ status: DONE, updated_at: 'x' } as Partial<Task>)
    mutate.mockResolvedValue(server)
    const { complete, updateTask, undo } = setup()

    await act(() => complete('t1'))

    expect(updateTask).toHaveBeenLastCalledWith(server)
    expect(undo.push).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith('Completed "T"', expect.anything())
  })

  it('rolls back status and reopens the tab when the write fails', async () => {
    const prev = task()
    mutate.mockRejectedValue(new Error('hub down'))
    const { complete, updateTask, openTask, undo } = setup(prev)

    await act(() => complete('t1'))

    expect(updateTask).toHaveBeenLastCalledWith(prev)
    expect(openTask).toHaveBeenCalledWith('t1')
    expect(undo.push).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('does not reopen a tab that was not open', async () => {
    tabState.tabs = [{ type: 'home' }]
    mutate.mockRejectedValue(new Error('hub down'))
    const { complete, openTask } = setup()

    await act(() => complete('t1'))

    expect(openTask).not.toHaveBeenCalled()
  })
})

describe('undo of ⌘⇧D', () => {
  /** Complete `t`, then hand back the pushed undo action with the mocks reset. */
  async function completed(t: Task) {
    mutate.mockResolvedValue({ ...t, status: DONE })
    const s = setup(t)
    await act(() => s.complete('t1'))
    const action = s.undo.push.mock.calls[0][0] as { undo: () => Promise<void> }
    vi.clearAllMocks()
    return { ...s, action }
  }

  it('reverts the status and reopens the tab at once, before the hub answers', async () => {
    const { action, updateTask, openTask } = await completed(task())
    mutate.mockReturnValue(deferred<Task>().promise)

    void action.undo()

    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'in_progress' })
    )
    expect(openTask).toHaveBeenCalledWith('t1')
  })

  it('reopens a temporary task at once; its status write waits for the restore', async () => {
    const { action, openTask } = await completed(task({ is_temporary: true } as Partial<Task>))
    const restored = deferred<Task>()
    restore.mockReturnValue(restored.promise)
    mutate.mockResolvedValue(task({ is_temporary: true } as Partial<Task>))

    const undone = action.undo()

    expect(openTask).toHaveBeenCalledWith('t1')
    expect(mutate).not.toHaveBeenCalled()
    restored.resolve(task({ is_temporary: true } as Partial<Task>))
    await act(() => undone)
    expect(mutate).toHaveBeenCalledWith({ id: 't1', status: 'in_progress' })
  })

  it('re-completes and re-closes when the undo write fails', async () => {
    const { action, updateTask, closeTabByTaskId } = await completed(task())
    mutate.mockRejectedValue(new Error('hub down'))

    await expect(act(() => action.undo())).rejects.toThrow('hub down')

    expect(updateTask).toHaveBeenLastCalledWith(expect.objectContaining({ status: DONE }))
    expect(closeTabByTaskId).toHaveBeenCalledWith('t1')
    expect(toast.error).toHaveBeenCalled()
  })
})

describe('useCloseTaskTab with a pending write', () => {
  function closer() {
    const deleteTask = vi.fn(async () => undefined)
    const { result } = renderHook(() => useCloseTaskTab(deleteTask))
    return { ...result.current, deleteTask }
  }

  beforeEach(() => {
    tabState._taskLookup = {
      tasks: [task({ is_temporary: true } as Partial<Task>)]
    }
  })

  it('closes the tab now but deletes a temporary task only after the write lands', async () => {
    const write = deferred<unknown>()
    const { closeTabByTaskId, deleteTask } = closer()

    const closed = closeTabByTaskId('t1', { after: write.promise })
    expect(tabState.closeTab).toHaveBeenCalledWith(1, { hubId: undefined })
    expect(deleteTask).not.toHaveBeenCalled()

    write.resolve(undefined)
    await closed
    expect(deleteTask).toHaveBeenCalledWith('t1')
  })

  it('keeps a temporary task when the write fails', async () => {
    const write = deferred<unknown>()
    const { closeTabByTaskId, deleteTask } = closer()

    const closed = closeTabByTaskId('t1', { after: write.promise })
    write.reject(new Error('hub down'))
    await expect(closed).rejects.toThrow('hub down')
    expect(deleteTask).not.toHaveBeenCalled()
  })
})
