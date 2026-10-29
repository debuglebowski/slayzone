// @vitest-environment jsdom
// Pins useChatMode's hybrid optimistic / server-authoritative mode state: mount
// hydration (live session > DB cache), drift sync from the subprocess's permission
// mode, and the serialized one-IPC-at-a-time setMode loop with revert on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const pending = <T,>() => new Promise<T>(() => {})

type Info = { chatMode?: string | null } | null
type Capability = { eligible: boolean; optedIn: boolean }

const m = vi.hoisted(() => {
  const getInfo = vi.fn<(input: { tabId: string }) => Promise<unknown>>()
  const getMode = vi.fn<(input: { taskId: string; mode: string }) => Promise<unknown>>()
  const setMode = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>()
  const getAutoEligibility = vi.fn<() => Promise<unknown>>()
  return {
    getInfo,
    getMode,
    setMode,
    getAutoEligibility,
    toast: vi.fn(),
    // One identity for the hook's lifetime, like the real client.
    client: {
      chat: {
        getInfo: { query: getInfo },
        getMode: { query: getMode },
        setMode: { mutate: setMode },
        getAutoEligibility: { query: getAutoEligibility }
      }
    }
  }
})

vi.mock('../trpc', () => ({ useTRPCClient: () => m.client }))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
  toast: m.toast
}))

import { useChatMode } from './useChatMode'

interface Props {
  taskId: string
  mode: string
  tabId: string
  cwd: string
  livePermissionMode?: string | null
}
const base: Props = { taskId: 'task1', mode: 'claude-chat', tabId: 'tab1', cwd: '/repo' }

/** Let resolved IPC promises (and their state updates) land. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

async function setup(over: Partial<Props> = {}) {
  const hook = renderHook((props: Props) => useChatMode(props), {
    initialProps: { ...base, ...over }
  })
  await flush()
  return hook
}

beforeEach(() => {
  m.getInfo.mockReset().mockResolvedValue(null)
  m.getMode.mockReset().mockResolvedValue('auto-accept')
  m.setMode.mockReset().mockImplementation((input) => Promise.resolve({ chatMode: input.chatMode }))
  m.getAutoEligibility
    .mockReset()
    .mockResolvedValue({ eligible: true, optedIn: true } satisfies Capability)
  m.toast.mockReset()
})
afterEach(cleanup)

describe('useChatMode hydration', () => {
  it('defaults to auto-accept with auto mode hidden before any IPC lands', () => {
    m.getInfo.mockReturnValue(pending())
    m.getAutoEligibility.mockReturnValue(pending())
    const { result } = renderHook(() => useChatMode(base))
    expect(result.current.chatMode).toBe('auto-accept')
    expect(result.current.autoCapability).toEqual({ eligible: false, optedIn: false })
  })

  it('prefers the live session mode and skips the DB cache', async () => {
    m.getInfo.mockResolvedValue({ chatMode: 'plan' } satisfies Info)
    const { result } = await setup()
    expect(result.current.chatMode).toBe('plan')
    expect(m.getInfo).toHaveBeenCalledWith({ tabId: 'tab1' })
    expect(m.getMode).not.toHaveBeenCalled()
  })

  it('falls back to the DB cache when no session exists', async () => {
    m.getMode.mockResolvedValue('bypass')
    const { result } = await setup()
    expect(result.current.chatMode).toBe('bypass')
    expect(m.getMode).toHaveBeenCalledWith({ taskId: 'task1', mode: 'claude-chat' })
  })

  it('falls back to the DB cache when the session has no mode', async () => {
    m.getInfo.mockResolvedValue({ chatMode: null } satisfies Info)
    m.getMode.mockResolvedValue('plan')
    const { result } = await setup()
    expect(result.current.chatMode).toBe('plan')
  })

  it('keeps the default when hydration fails', async () => {
    m.getInfo.mockRejectedValue(new Error('hub down'))
    const { result } = await setup()
    expect(result.current.chatMode).toBe('auto-accept')
    expect(m.getMode).not.toHaveBeenCalled()
  })

  it('re-hydrates when the tab changes', async () => {
    const { rerender } = await setup()
    rerender({ ...base, tabId: 'tab2' })
    await flush()
    expect(m.getInfo).toHaveBeenCalledTimes(2)
    expect(m.getInfo).toHaveBeenLastCalledWith({ tabId: 'tab2' })
  })

  it('drops a session read that lands after the tab changed', async () => {
    const first = deferred<Info>()
    const second = deferred<Info>()
    m.getInfo.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = await setup()
    rerender({ ...base, tabId: 'tab2' })
    await act(async () => second.resolve({ chatMode: 'plan' }))
    await act(async () => first.resolve({ chatMode: 'bypass' }))
    expect(result.current.chatMode).toBe('plan')
  })

  it('drops a DB-cache read that lands after the tab changed', async () => {
    const stale = deferred<unknown>()
    m.getMode.mockReturnValueOnce(stale.promise).mockResolvedValueOnce('plan')
    const { result, rerender } = await setup()
    rerender({ ...base, tabId: 'tab2' })
    await flush()
    await act(async () => stale.resolve('bypass'))
    expect(result.current.chatMode).toBe('plan')
  })

  it('does not fall back to the DB cache after unmount', async () => {
    const info = deferred<Info>()
    m.getInfo.mockReturnValue(info.promise)
    const { unmount } = await setup()
    unmount()
    await act(async () => info.resolve(null))
    expect(m.getMode).not.toHaveBeenCalled()
  })

  it('loads the auto-mode capability', async () => {
    m.getAutoEligibility.mockResolvedValue({ eligible: true, optedIn: false } satisfies Capability)
    const { result } = await setup()
    expect(result.current.autoCapability).toEqual({ eligible: true, optedIn: false })
  })

  it('keeps auto mode hidden when the capability read fails', async () => {
    m.getAutoEligibility.mockRejectedValue(new Error('hub down'))
    const { result } = await setup()
    expect(result.current.autoCapability).toEqual({ eligible: false, optedIn: false })
  })
})

describe('useChatMode drift sync', () => {
  beforeEach(() => {
    // Hydration never lands: drift is the only writer.
    m.getInfo.mockReturnValue(pending())
  })

  it('applies the subprocess permission mode on mount', async () => {
    const { result } = await setup({ livePermissionMode: 'bypassPermissions' })
    expect(result.current.chatMode).toBe('bypass')
  })

  it('applies a live permission mode transition', async () => {
    const { result, rerender } = await setup()
    rerender({ ...base, livePermissionMode: 'plan' })
    expect(result.current.chatMode).toBe('plan')
  })

  it('ignores an unmapped permission mode', async () => {
    const { result, rerender } = await setup()
    rerender({ ...base, livePermissionMode: 'dontAsk' })
    expect(result.current.chatMode).toBe('auto-accept')
  })

  it('the CLI default mode is "Ask before edits" (e.g. after "manually approve edits")', async () => {
    const { result, rerender } = await setup()
    rerender({ ...base, livePermissionMode: 'default' })
    expect(result.current.chatMode).toBe('ask')
  })

  it('does not re-apply an unchanged live mode over a later user change', async () => {
    const { result, rerender } = await setup({ livePermissionMode: 'plan' })
    await act(() => result.current.handleModeChange('bypass'))
    rerender({ ...base, livePermissionMode: 'plan' })
    expect(result.current.chatMode).toBe('bypass')
  })

  it('skips drift while a user change is in flight', async () => {
    const ipc = deferred<unknown>()
    m.setMode.mockReturnValueOnce(ipc.promise)
    const { result, rerender } = await setup()
    let change!: Promise<void>
    act(() => {
      change = result.current.handleModeChange('bypass')
    })
    // The dying session reports its old mode before the respawn lands.
    rerender({ ...base, livePermissionMode: 'acceptEdits' })
    expect(result.current.chatMode).toBe('bypass')
    await act(async () => {
      ipc.resolve({ chatMode: 'bypass' })
      await change
    })
    expect(result.current.chatMode).toBe('bypass')
  })
})

describe('useChatMode handleModeChange', () => {
  it('does nothing for the current mode', async () => {
    const { result } = await setup()
    await act(() => result.current.handleModeChange('auto-accept'))
    expect(m.setMode).not.toHaveBeenCalled()
  })

  it('refuses auto mode without the opt-in', async () => {
    m.getAutoEligibility.mockResolvedValue({ eligible: true, optedIn: false } satisfies Capability)
    const { result } = await setup()
    await act(() => result.current.handleModeChange('auto'))
    expect(m.toast).toHaveBeenCalledWith(
      'Auto mode requires Max/Team/Enterprise + opt-in via `claude` CLI'
    )
    expect(m.setMode).not.toHaveBeenCalled()
    expect(result.current.chatMode).toBe('auto-accept')
  })

  it('sends auto mode once opted in', async () => {
    const { result } = await setup()
    await act(() => result.current.handleModeChange('auto'))
    expect(m.setMode).toHaveBeenCalledTimes(1)
    expect(result.current.chatMode).toBe('auto')
  })

  it('paints the new mode before the IPC answers', async () => {
    m.setMode.mockReturnValueOnce(pending())
    const { result } = await setup()
    act(() => {
      void result.current.handleModeChange('plan')
    })
    expect(result.current.chatMode).toBe('plan')
    expect(m.setMode).toHaveBeenCalledWith({
      tabId: 'tab1',
      taskId: 'task1',
      mode: 'claude-chat',
      cwd: '/repo',
      chatMode: 'plan'
    })
  })

  it('applies the server-resolved mode (a downgrade)', async () => {
    m.setMode.mockResolvedValueOnce({ chatMode: 'auto-accept' })
    m.getMode.mockResolvedValue('plan')
    const { result } = await setup()
    await act(() => result.current.handleModeChange('auto'))
    expect(result.current.chatMode).toBe('auto-accept')
  })

  it('keeps the requested mode when the server answers without one', async () => {
    m.setMode.mockResolvedValueOnce(null)
    const { result } = await setup()
    await act(() => result.current.handleModeChange('plan'))
    expect(result.current.chatMode).toBe('plan')
  })

  it('sends clicks made during an IPC as one follow-up for the latest target', async () => {
    const first = deferred<unknown>()
    m.setMode.mockReturnValueOnce(first.promise)
    const { result } = await setup()
    let loop!: Promise<void>
    act(() => {
      loop = result.current.handleModeChange('plan')
    })
    // Clicks during the IPC join the running loop (they settle with it).
    act(() => {
      void result.current.handleModeChange('bypass')
    })
    act(() => {
      void result.current.handleModeChange('auto')
    })
    expect(m.setMode).toHaveBeenCalledTimes(1)
    expect(result.current.chatMode).toBe('auto')

    await act(async () => {
      first.resolve({ chatMode: 'plan' })
      await loop
    })
    expect(m.setMode.mock.calls.map(([input]) => input.chatMode)).toEqual(['plan', 'auto'])
    expect(result.current.chatMode).toBe('auto')
  })

  it('ignores a superseded answer, including its downgrade', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    m.setMode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = await setup()
    act(() => {
      void result.current.handleModeChange('plan')
    })
    act(() => {
      void result.current.handleModeChange('bypass')
    })
    await act(async () => first.resolve({ chatMode: 'auto-accept' }))
    expect(result.current.chatMode).toBe('bypass')
    expect(m.setMode).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ chatMode: 'bypass' }))
    expect(result.current.chatMode).toBe('bypass')
  })

  it('reverts to the last confirmed mode, toasts and re-throws on failure', async () => {
    m.getMode.mockResolvedValue('plan')
    m.setMode.mockRejectedValueOnce(new Error('respawn failed'))
    const { result } = await setup()
    let thrown: unknown
    await act(() => result.current.handleModeChange('bypass').catch((e: unknown) => (thrown = e)))
    expect(result.current.chatMode).toBe('plan')
    expect(m.toast).toHaveBeenCalledWith('Mode change failed: respawn failed')
    expect(thrown).toEqual(new Error('respawn failed'))
  })

  it('reverts past superseded targets to the mode confirmed before the loop', async () => {
    const first = deferred<unknown>()
    m.setMode.mockReturnValueOnce(first.promise).mockRejectedValueOnce('boom')
    const { result } = await setup()
    let loop!: Promise<void>
    act(() => {
      loop = result.current.handleModeChange('plan')
    })
    act(() => {
      void result.current.handleModeChange('bypass').catch(() => {})
    })
    await act(async () => {
      first.resolve({ chatMode: 'plan' })
      await loop.catch(() => {})
    })
    expect(result.current.chatMode).toBe('auto-accept')
    expect(m.toast).toHaveBeenCalledWith('Mode change failed: boom')
  })

  it('accepts a new change after a failed one', async () => {
    m.setMode.mockRejectedValueOnce(new Error('respawn failed'))
    const { result } = await setup()
    await act(() => result.current.handleModeChange('plan').catch(() => {}))
    await act(() => result.current.handleModeChange('bypass'))
    expect(m.setMode).toHaveBeenCalledTimes(2)
    expect(result.current.chatMode).toBe('bypass')
  })

  // A caller that awaits the change to branch on success relies on the promise
  // settling with its own target's outcome (chat bug N4).
  it('keeps a click that joined an in-flight IPC pending until its target is applied', async () => {
    m.setMode.mockReturnValueOnce(pending())
    const { result } = await setup()
    act(() => {
      void result.current.handleModeChange('plan')
    })
    let joinedSettled = false
    act(() => {
      void result.current.handleModeChange('bypass').finally(() => (joinedSettled = true))
    })
    await flush()
    expect(m.setMode).toHaveBeenCalledTimes(1)
    expect(joinedSettled).toBe(false)
  })

  it('rejects a click that joined an in-flight IPC when its target fails', async () => {
    const first = deferred<unknown>()
    m.setMode.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('respawn failed'))
    const { result } = await setup()
    let loop!: Promise<void>
    act(() => {
      loop = result.current.handleModeChange('plan')
    })
    let joinedRejected = false
    act(() => {
      void result.current.handleModeChange('bypass').catch(() => (joinedRejected = true))
    })
    await act(async () => {
      first.resolve({ chatMode: 'plan' })
      await loop.catch(() => {})
    })
    expect(m.setMode).toHaveBeenCalledTimes(2)
    expect(m.toast).toHaveBeenCalledWith('Mode change failed: respawn failed')
    expect(joinedRejected).toBe(true)
  })
})
