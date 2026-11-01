// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useBoardRefresh } from './useBoardRefresh'

afterEach(cleanup)

it('refreshes every hub, reports failures, and waits for remaining requests', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const local = vi.fn(async () => undefined)
  const remote = vi.fn(async () => {
    throw new Error('Offline')
  })
  const groups = vi.fn(() => pending)
  const { result } = renderHook(() => useBoardRefresh())
  let refresh!: Promise<void>
  act(() => {
    refresh = result.current.refresh([
      { label: 'Local', requests: [local] },
      { label: 'slay.normain.com', requests: [remote, groups] }
    ])
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(local).toHaveBeenCalledOnce()
  expect(remote).toHaveBeenCalledOnce()
  expect(groups).toHaveBeenCalledOnce()
  expect(result.current.isRefreshing).toBe(true)
  await act(async () => {
    finish()
    await refresh
  })
  expect(result.current.isRefreshing).toBe(false)
  expect(result.current.refreshErrors).toEqual(['slay.normain.com'])

  await act(async () => {
    await result.current.refresh([{ label: 'slay.normain.com', requests: [local] }])
  })
  expect(result.current.refreshErrors).toEqual([])
})

it('coalesces repeated refreshes while a request is pending', async () => {
  let finish!: () => void
  const request = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const targets = [{ label: 'Local', requests: [request] }]
  const { result } = renderHook(() => useBoardRefresh())
  let first!: Promise<void>
  let second!: Promise<void>
  act(() => {
    first = result.current.refresh(targets)
    second = result.current.refresh(targets)
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(request).toHaveBeenCalledOnce()
  expect(second).toBe(first)
  await act(async () => {
    finish()
    await first
  })
})
