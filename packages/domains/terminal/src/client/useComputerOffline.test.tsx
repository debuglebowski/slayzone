// @vitest-environment jsdom
// A terminal whose computer is unreachable says so — never a blank or hung pane — and
// catches up (from its last rendered seq, so without a gap) when the computer is back.
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { isComputerOfflineError, useComputerOffline } from './useComputerOffline'
import { TerminalComputerOffline } from './TerminalComputerOffline'

afterEach(cleanup)

function availabilitySource() {
  const subs = new Set<(available: boolean) => void>()
  return {
    subscribe: (_sessionId: string, cb: (available: boolean) => void) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    emit: (available: boolean) => {
      for (const cb of subs) cb(available)
    }
  }
}

it('goes offline when told, and catches up then clears when the computer is back', async () => {
  const source = availabilitySource()
  const catchUp = vi.fn(async () => undefined)
  const { result } = renderHook(() =>
    useComputerOffline({ sessionId: 's', subscribeAvailability: source.subscribe, catchUp })
  )
  expect(result.current.offline).toBe(false)
  act(() => source.emit(false))
  expect(result.current.offline).toBe(true)
  await act(async () => source.emit(true))
  expect(catchUp).toHaveBeenCalledTimes(1)
  expect(result.current.offline).toBe(false)
})

it('an attach that found it offline marks it; a second "back" while not offline does nothing', async () => {
  const source = availabilitySource()
  const catchUp = vi.fn(async () => undefined)
  const { result } = renderHook(() =>
    useComputerOffline({ sessionId: 's', subscribeAvailability: source.subscribe, catchUp })
  )
  act(() => result.current.markOffline())
  expect(result.current.offline).toBe(true)
  await act(async () => source.emit(true))
  await act(async () => source.emit(true))
  expect(catchUp).toHaveBeenCalledTimes(1)
})

it('a catch-up that fails (still offline) stays offline', async () => {
  const source = availabilitySource()
  const catchUp = vi.fn(async () => {
    throw Object.assign(new Error('offline'), { data: { code: 'SERVICE_UNAVAILABLE' } })
  })
  const { result } = renderHook(() =>
    useComputerOffline({ sessionId: 's', subscribeAvailability: source.subscribe, catchUp })
  )
  act(() => source.emit(false))
  await act(async () => source.emit(true))
  expect(result.current.offline).toBe(true)
})

it('recognizes the hub\'s "computer offline" answer', () => {
  expect(isComputerOfflineError({ data: { code: 'SERVICE_UNAVAILABLE' } })).toBe(true)
  expect(isComputerOfflineError(new Error('boom'))).toBe(false)
})

it('the overlay names the cause and that output comes back', () => {
  render(<TerminalComputerOffline />)
  expect(screen.getByText('Computer offline')).toBeTruthy()
  expect(screen.getByTestId('terminal-computer-offline').textContent).toMatch(/reconnects/)
})
