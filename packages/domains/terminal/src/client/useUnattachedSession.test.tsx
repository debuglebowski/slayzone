// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useUnattachedSession } from './useUnattachedSession'

const mock = vi.hoisted(() => ({
  kill: vi.fn(),
  stop: vi.fn(),
  attach: vi.fn(),
  onData: undefined as
    | undefined
    | ((rows: Array<{ sessionId: string; computerId: string; status: string }>) => void)
}))
vi.mock('@slayzone/transport/client', () => ({ useSubscription: () => undefined }))
vi.mock('./trpc', () => ({
  useTRPC: () => ({
    pty: {
      onUnattachedChange: {
        subscriptionOptions: (_: unknown, opts: { onData: typeof mock.onData }) => {
          mock.onData = opts.onData
        }
      }
    }
  }),
  useTRPCClient: () => ({
    pty: {
      kill: { mutate: mock.kill },
      unattachedKill: { mutate: mock.stop },
      unattachedAttach: { mutate: mock.attach }
    }
  })
}))
beforeEach(() => {
  vi.clearAllMocks()
  mock.kill.mockResolvedValue(false)
  mock.stop.mockRejectedValue(new Error('offline'))
  mock.attach.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

test.each([false, true])(
  'overlay Restart records canonical intent before remount, listed=%s',
  async (listed) => {
    const remount = vi.fn()
    let finish!: (v: boolean) => void
    mock.kill.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          finish = r
        })
    )
    const { result } = renderHook(() => useUnattachedSession('task:tab', true, remount))
    if (listed)
      act(() => mock.onData?.([{ sessionId: 'task:tab', computerId: 'pc', status: 'unattached' }]))
    act(() => result.current.handleNotAttachedRestart())
    expect(mock.kill).toHaveBeenCalledWith({ sessionId: 'task:tab' })
    expect(mock.stop).not.toHaveBeenCalled()
    expect(remount).not.toHaveBeenCalled()
    await act(async () => {
      finish(false)
    })
    expect(remount).toHaveBeenCalledOnce()
  }
)

test('overlay Restart waits for acknowledged intent on RPC rejection; Attach still adopts', async () => {
  mock.kill.mockRejectedValue(new Error('offline'))
  const remount = vi.fn()
  const { result } = renderHook(() => useUnattachedSession('task:tab', true, remount))
  act(() => mock.onData?.([{ sessionId: 'task:tab', computerId: 'pc', status: 'unattached' }]))
  await act(async () => result.current.handleNotAttachedRestart())
  expect(mock.kill).toHaveBeenCalledWith({ sessionId: 'task:tab' })
  expect(remount).not.toHaveBeenCalled()
  mock.kill.mockClear()
  remount.mockClear()
  await act(async () => result.current.handleNotAttachedAttach())
  expect(mock.attach).toHaveBeenCalledWith({ computerId: 'pc', sessionId: 'task:tab' })
  expect(mock.kill).not.toHaveBeenCalled()
  expect(remount).toHaveBeenCalledOnce()
})
