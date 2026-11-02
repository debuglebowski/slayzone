// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
const { check, get, set } = vi.hoisted(() => ({ check: vi.fn(), get: vi.fn(), set: vi.fn() }))
vi.mock('./trpc', () => ({ useTRPCClient: () => client }))
const client = {
  aiConfig: { checkSlayConfigured: { query: check } },
  settings: { get: { query: get }, set: { mutate: set } }
}
const { useSlayNudge } = await import('./useSlayNudge')
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  get.mockResolvedValue(null)
  set.mockResolvedValue(undefined)
  check.mockResolvedValue(false)
})
it('includes task and project when checking remote workspace', async () => {
  const { result } = renderHook(() =>
    useSlayNudge({ taskId: 'task', projectId: 'project', projectPath: '/repo' })
  )
  await waitFor(() => expect(result.current.showBanner).toBe(true))
  expect(check).toHaveBeenCalledWith({ taskId: 'task', projectId: 'project', projectPath: '/repo' })
})
it('hides banner when remote check fails', async () => {
  check.mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() =>
    useSlayNudge({ taskId: 'task', projectId: 'project', projectPath: '/repo' })
  )
  await act(async () => {})
  expect(result.current.showBanner).toBe(false)
})
it('ignores old task result after changing tasks at the same path', async () => {
  let resolve!: (value: boolean) => void
  check
    .mockReturnValueOnce(
      new Promise<boolean>((r) => {
        resolve = r
      })
    )
    .mockResolvedValue(true)
  const { result, rerender } = renderHook(
    ({ taskId }) => useSlayNudge({ taskId, projectId: 'project', projectPath: '/repo' }),
    { initialProps: { taskId: 'old' } }
  )
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
  rerender({ taskId: 'new' })
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
  await act(async () => resolve(false))
  expect(result.current.showBanner).toBe(false)
})

it('rechecks when task moves to another computer with the same workspace path', async () => {
  const { result, rerender } = renderHook(
    ({ computerId }) =>
      useSlayNudge({
        taskId: 'task',
        projectId: 'project',
        projectPath: '/repo',
        computerId
      }),
    { initialProps: { computerId: 'first' } }
  )
  await waitFor(() => expect(result.current.showBanner).toBe(true))
  check.mockResolvedValue(true)
  rerender({ computerId: 'second' })
  expect(result.current.showBanner).toBe(false)
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
  expect(result.current.showBanner).toBe(false)
})
