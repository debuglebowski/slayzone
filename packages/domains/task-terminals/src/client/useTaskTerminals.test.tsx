// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TerminalTab } from '../shared/types'

type OnChanged = (data: { taskId: string; focusTabId?: string }) => Promise<void>

const TASK = 't1'
let listResult: TerminalTab[] = []
let onChanged: OnChanged | null = null
const mutations: Record<string, ReturnType<typeof vi.fn>> = {
  delete: vi.fn(),
  kill: vi.fn(),
  remove: vi.fn()
}
const client = {
  taskTerminals: {
    ensureMain: { mutate: () => Promise.resolve() },
    list: { query: () => Promise.resolve(listResult) }
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
  agentState: 'new'
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
  mutations.delete.mockReset().mockResolvedValue(true)
  mutations.kill.mockReset().mockResolvedValue(undefined)
  mutations.remove.mockReset().mockResolvedValue(undefined)
})

describe('useTaskTerminals active group', () => {
  it('keeps a valid active group', async () => {
    const { result } = await setup([MAIN, tab('x', 'gx', false, 1)])
    act(() => result.current.setActiveGroupId('gx'))
    expect(result.current.activeGroupId).toBe('gx')
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
