// @vitest-environment jsdom
// Pins useTaskTerminalSession's detected-conversation-id persist: one task.update per
// detected id, never re-issued by re-renders — including the re-renders the mutation's
// own state changes cause. Uses the REAL TanStack useMutation (new result object every
// render, host re-render on every mutation state change), because that identity churn is
// exactly what turned a failing write into an endless task.update retry loop.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '@slayzone/task/shared'

const updateFn = vi.fn<(input: unknown) => Promise<Task>>()
const sub = { subscriptionOptions: () => ({}) }
const trpc = {
  task: {
    update: { mutationOptions: () => ({ mutationFn: (input: unknown) => updateFn(input) }) }
  },
  menu: { onSyncSessionId: sub },
  pty: { onRespawnSuggested: sub, onEnsureAlive: sub }
}
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({}),
  useSubscription: () => undefined
}))
vi.mock('@slayzone/terminal', () => ({ markSkipCache: vi.fn() }))
vi.mock('@slayzone/task-terminals', () => ({ markForceStart: vi.fn(), requestAgentStart: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  useStableCallback: (await importOriginal<typeof import('@slayzone/ui')>()).useStableCallback
}))

const { useTaskTerminalSession } = await import('./useTaskTerminalSession')

// codex has a session-id discovery command, so detected ids are persisted.
const task = (conversationId: string | null = null): Task =>
  ({
    id: 't1',
    terminal_mode: 'codex',
    provider_config: {},
    currentConversationByMode: conversationId ? { codex: conversationId } : {}
  }) as unknown as Task

const getMainSessionId = (id: string): string => `${id}:main`
const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 100)))

afterEach(() => {
  cleanup()
  updateFn.mockReset()
})

function setup(initial: Task) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const onTaskUpdated = vi.fn()
  let detect: (id: string) => void = () => {}
  const subscribeSessionDetected = (_sid: string, cb: (id: string) => void) => {
    detect = cb
    return () => {}
  }
  const hook = renderHook(
    ({ t }: { t: Task }) =>
      useTaskTerminalSession({
        task: t,
        onTaskUpdated,
        shortcutActive: false,
        getMainSessionId,
        resetTaskState: vi.fn(),
        subscribeSessionDetected,
        setTerminalKey: vi.fn()
      }),
    { initialProps: { t: initial }, wrapper }
  )
  return { ...hook, onTaskUpdated, detect: (id: string) => act(() => detect(id)) }
}

describe('useTaskTerminalSession — detected conversation id persist', () => {
  it('a failing write is not retried by re-renders; a new task object retries once', async () => {
    updateFn.mockRejectedValue(new Error('hub unreachable'))
    const first = task()
    const { rerender, detect, onTaskUpdated } = setup(first)
    detect('sess-1')
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(1)
    expect(updateFn).toHaveBeenCalledWith({
      id: 't1',
      providerConfig: { codex: { conversationId: 'sess-1' } }
    })

    // A parent re-render with the same task: no retry.
    rerender({ t: first })
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(1)

    // A board refetch (fresh task object) is the transient-failure retry — once.
    rerender({ t: task() })
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(2)
    expect(onTaskUpdated).not.toHaveBeenCalled()
  })

  it('a successful write fires once, hands the task up, and clears the detected id', async () => {
    const updated = task('sess-1')
    updateFn.mockResolvedValue(updated)
    const { result, rerender, detect, onTaskUpdated } = setup(task())
    detect('sess-1')
    expect(result.current.detectedSessionId).toBe('sess-1')
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(1)
    expect(onTaskUpdated).toHaveBeenCalledExactlyOnceWith(updated)
    expect(result.current.detectedSessionId).toBeNull()

    rerender({ t: updated })
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(1)
  })

  it('re-renders while the write is in flight do not issue a second write', async () => {
    let resolve: (t: Task) => void = () => {}
    updateFn.mockImplementation(() => new Promise<Task>((r) => (resolve = r)))
    const { rerender, detect } = setup(task())
    detect('sess-1')
    rerender({ t: task() })
    rerender({ t: task() })
    await settle()
    expect(updateFn).toHaveBeenCalledTimes(1)
    await act(async () => resolve(task('sess-1')))
    expect(updateFn).toHaveBeenCalledTimes(1)
  })
})
