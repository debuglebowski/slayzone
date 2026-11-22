// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TerminalTab } from '../shared/types'

type OnChanged = (data: { taskId: string; focusTabId?: string }) => Promise<void>

const TASK = 't1'
let listResult: TerminalTab[] = []
let onChanged: OnChanged | null = null
let reopen: ((dropped: boolean) => void) | null = null
let listQuery = vi.fn(() => Promise.resolve(listResult))
const mutations: Record<string, ReturnType<typeof vi.fn>> = {
  delete: vi.fn(),
  kill: vi.fn(),
  remove: vi.fn()
}
const client = {
  taskTerminals: {
    ensureMain: { mutate: vi.fn().mockResolvedValue(undefined) },
    list: { query: (...args: unknown[]) => listQuery(...(args as [])) }
  }
}

// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    taskTerminals: {
      create: { mutationOptions: () => ({ __k: 'create' }) },
      split: { mutationOptions: () => ({ __k: 'split' }) },
      delete: { mutationOptions: () => ({ __k: 'delete' }) },
      moveToGroup: { mutationOptions: () => ({ __k: 'moveToGroup' }) },
      update: { mutationOptions: () => ({ __k: 'update' }) },
      onChanged: { subscriptionOptions: (_input: unknown, opts: unknown) => opts }
    },
    pty: { kill: { mutationOptions: () => ({ __k: 'kill' }) } },
    chat: { remove: { mutationOptions: () => ({ __k: 'remove' }) } }
  }),
  useTRPCClient: () => client,
  useSubscription: (opts: { onData: OnChanged }) => {
    onChanged = opts.onData
  },
  useHubReopen: (cb: (dropped: boolean) => void) => {
    reopen = cb
  }
}))

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: { __k: string }) => ({ mutateAsync: mutations[opts.__k] ?? vi.fn() })
}))

vi.mock('@slayzone/terminal', () => ({
  usePty: () => ({ subscribeExit: () => () => {} })
}))

import { useTaskTerminals } from './useTaskTerminals'

const tab = (id: string, groupId: string, isMain = false, position = 0): TerminalTab => ({
  id,
  taskId: TASK,
  groupId,
  label: null,
  mode: 'terminal',
  isMain,
  position,
  createdAt: '2026-01-01',
  agentState: 'new',
  chatFontSize: null
})
const MAIN = tab(TASK, TASK, true, 0)

async function setup(initial: TerminalTab[]) {
  listResult = initial
  const hook = renderHook(() => useTaskTerminals(TASK, 'terminal'))
  await waitFor(() => expect(hook.result.current.tabs).toHaveLength(initial.length))
  return hook
}

beforeEach(() => {
  onChanged = null
  reopen = null
  listQuery = vi.fn(() => Promise.resolve(listResult))
  mutations.delete.mockReset().mockResolvedValue(true)
  mutations.kill.mockReset().mockResolvedValue(undefined)
  mutations.remove.mockReset().mockResolvedValue(undefined)
  client.taskTerminals.ensureMain.mutate.mockReset().mockResolvedValue(undefined)
})

describe('useTaskTerminals active group', () => {
  it('loads existing tabs without a mutation while the task is locked for migration', async () => {
    client.taskTerminals.ensureMain.mutate.mockRejectedValue(new Error('Task is moving'))
    const { result } = await setup([MAIN])
    expect(result.current.tabs).toEqual([MAIN])
    expect(client.taskTerminals.ensureMain.mutate).not.toHaveBeenCalled()
  })

  it('keeps a valid active group', async () => {
    const { result } = await setup([MAIN, tab('x', 'gx', false, 1)])
    act(() => result.current.setActiveGroupId('gx'))
    expect(result.current.activeGroupId).toBe('gx')
  })

  it('still provisions a missing main tab', async () => {
    listResult = []
    client.taskTerminals.ensureMain.mutate.mockImplementation(async () => {
      listResult = [MAIN]
    })
    const { result } = renderHook(() => useTaskTerminals(TASK, 'terminal'))
    await waitFor(() => expect(result.current.tabs).toEqual([MAIN]))
    expect(client.taskTerminals.ensureMain.mutate).toHaveBeenCalledWith({
      taskId: TASK,
      mode: 'terminal'
    })
  })

  it('still synchronizes a changed main-tab mode', async () => {
    listResult = [tab(TASK, TASK, true)]
    client.taskTerminals.ensureMain.mutate.mockImplementation(async () => {
      listResult = [{ ...MAIN, mode: 'claude-code' }]
    })
    const { result } = renderHook(() => useTaskTerminals(TASK, 'claude-code'))
    await waitFor(() => expect(result.current.tabs[0]?.mode).toBe('claude-code'))
  })

  it('falls back to the main group when the active group is closed', async () => {
    const { result } = await setup([MAIN, tab('x', 'gx', false, 1)])
    act(() => result.current.setActiveGroupId('gx'))

    await act(async () => {
      await result.current.closeTab('x')
    })

    expect(result.current.groups.map((g) => g.id)).toEqual([TASK])
    expect(result.current.activeGroupId).toBe(TASK)
  })

  it('falls back to the main group when an external change removes the active group', async () => {
    const { result } = await setup([MAIN, tab('x', 'gx', false, 1), tab('y', 'gy', false, 2)])
    act(() => result.current.setActiveGroupId('gy'))

    listResult = [MAIN, tab('x', 'gx', false, 1)]
    await act(async () => {
      await onChanged!({ taskId: TASK })
    })

    expect(result.current.activeGroupId).toBe(TASK)
  })

  it('falls back to the first group when there is no main group', async () => {
    const { result } = await setup([tab('y', 'gy', false, 0), tab('z', 'gz', false, 1)])
    expect(result.current.activeGroupId).toBe('gy')
  })

  it('a reload (default mode change) keeps the user group', async () => {
    listResult = [MAIN, tab('x', 'gx', false, 1)]
    const hook = renderHook(({ mode }) => useTaskTerminals(TASK, mode), {
      initialProps: { mode: 'terminal' as 'terminal' | 'claude-code' }
    })
    await waitFor(() => expect(hook.result.current.tabs).toHaveLength(2))
    act(() => hook.result.current.setActiveGroupId('gx'))
    hook.rerender({ mode: 'claude-code' })
    await act(async () => {})
    expect(hook.result.current.activeGroupId).toBe('gx')
  })

  it('leaves the id alone while there are no groups', () => {
    listResult = []
    const { result } = renderHook(() => useTaskTerminals(TASK, 'terminal'))
    act(() => result.current.setActiveGroupId('nowhere'))
    expect(result.current.activeGroupId).toBe('nowhere')
  })
})

describe('useTaskTerminals load failures', () => {
  // A hub socket that drops while the first load is in flight (e.g. the machine slept)
  // rejects it. The pane must know the load failed — not read it as "no tabs" — and
  // load again once the hub is reachable.
  const failOnce = () => {
    listQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockImplementation(() => Promise.resolve(listResult))
  }

  it('reports a failed load, distinct from an empty one', async () => {
    listResult = [MAIN]
    failOnce()
    const { result } = renderHook(() => useTaskTerminals(TASK, 'terminal'))
    expect(result.current.loadState).toBe('loading')
    await waitFor(() => expect(result.current.loadState).toBe('failed'))
    expect(result.current.tabs).toEqual([])
  })

  it('loads again when the hub reopens after a failed load', async () => {
    listResult = [MAIN]
    failOnce()
    const { result } = renderHook(() => useTaskTerminals(TASK, 'terminal'))
    await waitFor(() => expect(result.current.loadState).toBe('failed'))
    await act(async () => reopen!(false))
    await waitFor(() => expect(result.current.tabs).toEqual([MAIN]))
    expect(result.current.loadState).toBe('loaded')
  })

  it('reload() loads again after a failed load', async () => {
    listResult = [MAIN]
    failOnce()
    const { result } = renderHook(() => useTaskTerminals(TASK, 'terminal'))
    await waitFor(() => expect(result.current.loadState).toBe('failed'))
    await act(async () => result.current.reload())
    await waitFor(() => expect(result.current.tabs).toEqual([MAIN]))
  })

  it('reloads a loaded list when a dropped connection reopens (pushes may be missed)', async () => {
    const { result } = await setup([MAIN])
    listResult = [MAIN, tab('x', 'gx', false, 1)]
    await act(async () => reopen!(true))
    await waitFor(() => expect(result.current.tabs).toHaveLength(2))
  })

  it("a first open doesn't reload a list that loaded", async () => {
    const { result } = await setup([MAIN])
    const calls = listQuery.mock.calls.length
    await act(async () => reopen!(false))
    expect(listQuery.mock.calls.length).toBe(calls)
    expect(result.current.loadState).toBe('loaded')
  })

  it('a stale load for a previous task never lands', async () => {
    let resolveFirst: (tabs: TerminalTab[]) => void = () => {}
    listQuery = vi
      .fn()
      .mockImplementationOnce(() => new Promise<TerminalTab[]>((r) => (resolveFirst = r)))
      .mockImplementation(() => Promise.resolve([tab('t2', 't2', true)]))
    const hook = renderHook(({ id }) => useTaskTerminals(id, 'terminal'), {
      initialProps: { id: TASK }
    })
    hook.rerender({ id: 't2' })
    await waitFor(() => expect(hook.result.current.tabs[0]?.id).toBe('t2'))
    await act(async () => resolveFirst([MAIN]))
    expect(hook.result.current.tabs[0]?.id).toBe('t2')
  })
})
