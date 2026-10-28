// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { Task } from '@slayzone/task-contracts'
import { DEFAULT_AGENT_STATUS_PANEL_WIDTH, useAgentStatusState } from './useAgentStatusState'
import { useActiveSessionTaskIds, useIdleTasks } from './useIdleTasks'

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useAgentStatusState', () => {
  function setup(initialStored: string | null) {
    let stored = initialStored
    const sets: Array<{ key: string; value: string }> = []
    const trpc = createTrpcTest({
      procedures: {
        'settings.get': () => stored,
        'settings.set': (input) => {
          sets.push(input as { key: string; value: string })
          return null
        }
      }
    })
    const hook = renderHook(() => useAgentStatusState(), { wrapper: trpc.wrapper })
    return {
      hook,
      sets,
      setStored: (v: string | null) => {
        stored = v
      },
      queryClient: trpc.queryClient
    }
  }

  const DEFAULTS = {
    isLocked: false,
    filterCurrentProject: false,
    panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH
  }

  it('keeps the defaults when nothing is stored', async () => {
    const { hook } = setup(null)
    expect(hook.result.current[0]).toEqual(DEFAULTS)
    await flush()
    expect(hook.result.current[0]).toEqual(DEFAULTS)
  })

  it('hydrates stored JSON over the defaults; ignores unparsable JSON', async () => {
    const ok = setup('{"isLocked":true,"panelWidth":400}')
    await flush()
    expect(ok.hook.result.current[0]).toEqual({ ...DEFAULTS, isLocked: true, panelWidth: 400 })

    cleanup()
    const bad = setup('{not json')
    await flush()
    expect(bad.hook.result.current[0]).toEqual(DEFAULTS)
  })

  it('updates merge + persist, and a changed stored value re-hydrates', async () => {
    const { hook, sets, setStored, queryClient } = setup('{"panelWidth":300}')
    await flush()
    act(() => {
      hook.result.current[1]({ filterCurrentProject: true })
    })
    expect(hook.result.current[0]).toEqual({
      ...DEFAULTS,
      panelWidth: 300,
      filterCurrentProject: true
    })
    await flush()
    expect(sets.at(-1)).toEqual({
      key: 'agentStatusPanelState',
      value: JSON.stringify({ isLocked: false, filterCurrentProject: true, panelWidth: 300 })
    })

    // Same stored string refetched → no re-hydration (local edit survives).
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(hook.result.current[0].filterCurrentProject).toBe(true)

    setStored('{"isLocked":true}')
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(hook.result.current[0]).toEqual({ ...DEFAULTS, isLocked: true })
  })
})

describe('useIdleTasks / useActiveSessionTaskIds', () => {
  const task = { id: 't1', project_id: 'p1', status: 'in_progress' } as unknown as Task

  function setup() {
    const emits: Array<(data: unknown) => void> = []
    let listCalls = 0
    const trpc = createTrpcTest({
      procedures: {
        'pty.list': () => {
          listCalls++
          return [
            {
              sessionId: 's1',
              taskId: 't1',
              mode: 'claude-code',
              lastOutputTime: Date.now() - 5000,
              state: 'idle'
            }
          ]
        },
        'pty.chatList': () => []
      },
      subscriptions: {
        'pty.onStateChange': (_input, push) => {
          emits.push(push)
          return () => {
            emits.splice(emits.indexOf(push), 1)
          }
        }
      }
    })
    return {
      wrapper: trpc.wrapper,
      emit: (data: unknown) => {
        for (const push of [...emits]) push(data)
      },
      listCalls: () => listCalls
    }
  }

  it('lists idle sessions, refreshes on state change and rechecks after the idle threshold', async () => {
    const { wrapper, emit, listCalls } = setup()
    const { result } = renderHook(() => useIdleTasks([task], null), {
      wrapper: wrapper as (props: { children: ReactNode }) => ReactNode
    })
    await flush()
    expect(result.current.idleTasks.map((t) => t.sessionId)).toEqual(['s1'])
    expect(result.current.count).toBe(1)
    const afterMount = listCalls()

    act(() => {
      emit({ sessionId: 's1', newState: 'running', oldState: 'idle' })
    })
    await flush()
    expect(listCalls()).toBe(afterMount + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(listCalls()).toBe(afterMount + 1)

    act(() => {
      emit({ sessionId: 's1', newState: 'idle', oldState: 'running' })
    })
    await flush()
    expect(listCalls()).toBe(afterMount + 2)
    // Second idle event inside the window restarts (not stacks) the recheck timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => {
      emit({ sessionId: 's1', newState: 'idle', oldState: 'running' })
    })
    await flush()
    expect(listCalls()).toBe(afterMount + 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2099)
    })
    expect(listCalls()).toBe(afterMount + 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush()
    expect(listCalls()).toBe(afterMount + 4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(listCalls()).toBe(afterMount + 4)

    // refresh() is exposed and resolves after the snapshot updates.
    await act(async () => {
      await result.current.refresh()
    })
    expect(listCalls()).toBe(afterMount + 5)
  })

  it('useActiveSessionTaskIds tracks live sessions and refreshes on state change', async () => {
    const { wrapper, emit, listCalls } = setup()
    const { result } = renderHook(() => useActiveSessionTaskIds(), {
      wrapper: wrapper as (props: { children: ReactNode }) => ReactNode
    })
    expect(result.current.size).toBe(0)
    await flush()
    expect([...result.current]).toEqual(['t1'])
    const n = listCalls()
    act(() => {
      emit({ sessionId: 's1', newState: 'running', oldState: 'idle' })
    })
    await flush()
    expect(listCalls()).toBe(n + 1)
  })
})
