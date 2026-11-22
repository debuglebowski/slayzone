// @vitest-environment jsdom
/**
 * `useHubReopen`: `watchReopen` on the socket of the nearest HubScope's hub, for reads
 * loaded once (a task's tabs) that must load again after a failure or a drop.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { TRPCClientError } from '@trpc/client'
import { behaviorSubject } from '@trpc/server/observable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStateSource } from './connectDeadlineLink'

type State = ReturnType<ConnectionStateSource['get']>
const open: State = { type: 'state', state: 'pending', error: null }
const dropped: State = {
  type: 'state',
  state: 'connecting',
  error: TRPCClientError.from(new Error('closed'))
}

let hubId: string | null = 'remote'
let source = behaviorSubject<State>(open)
let federated = true

vi.mock('./HubScope', () => ({ useHubId: () => hubId }))
vi.mock('./FederationProvider', () => ({
  useFederation: () => null,
  useFederationOrNull: () =>
    federated
      ? {
          resolve: (id: string) =>
            id === 'remote' ? { ws: { wsClient: { connectionState: source } } } : null
        }
      : null
}))

const { useHubReopen } = await import('./hubConnection')

beforeEach(() => {
  hubId = 'remote'
  source = behaviorSubject<State>(open)
  federated = true
})
afterEach(cleanup)

describe('useHubReopen', () => {
  it("calls back when the scope's hub socket reopens after a drop", () => {
    const onReopen = vi.fn()
    renderHook(() => useHubReopen(onReopen))
    act(() => source.next(dropped))
    expect(onReopen).not.toHaveBeenCalled()
    act(() => source.next(open))
    expect(onReopen).toHaveBeenCalledWith(true)
  })

  it('always calls the latest callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const hook = renderHook(({ cb }) => useHubReopen(cb), { initialProps: { cb: first } })
    hook.rerender({ cb: second })
    act(() => source.next(dropped))
    act(() => source.next(open))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(true)
  })

  it('stops listening when unmounted', () => {
    const onReopen = vi.fn()
    const hook = renderHook(() => useHubReopen(onReopen))
    hook.unmount()
    act(() => source.next(dropped))
    act(() => source.next(open))
    expect(onReopen).not.toHaveBeenCalled()
  })

  it('does nothing outside a hub scope or a federation', () => {
    hubId = null
    expect(() => renderHook(() => useHubReopen(vi.fn()))).not.toThrow()
    hubId = 'remote'
    federated = false
    expect(() => renderHook(() => useHubReopen(vi.fn()))).not.toThrow()
  })
})
