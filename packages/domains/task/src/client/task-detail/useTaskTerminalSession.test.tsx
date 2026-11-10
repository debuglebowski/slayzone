// @vitest-environment jsdom
// Pins useTaskTerminalSession's detected-conversation-id persist: one
// agentSessions.recordDetected per detected id (on the task's computer, robustness plan
// §9), never re-issued by re-renders — including the re-renders the mutation's own state
// changes cause. Uses the REAL TanStack useMutation (new result object every render, host
// re-render on every mutation state change), because that identity churn is exactly what
// turned a failing write into an endless retry loop.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'

const updateFn = vi.fn<(input: unknown) => Promise<Task>>()
const recordFn = vi.fn<(input: unknown) => Promise<{ ok: true }>>()
/** The main tab's current conversation as the computer answers it. */
let currentId: string | null = null
const sub = { subscriptionOptions: () => ({}) }
// The respawn subscription hands its onData to useSubscription — capture it so a
// test can fire a `pty:respawn-suggested` at the hook.
let respawnSuggested: ((ev: { taskId: string }) => Promise<void>) | null = null
const respawnSub = {
  subscriptionOptions: (_: unknown, opts: { onData: typeof respawnSuggested }) => ({
    respawn: opts.onData
  })
}
const trpcClient = {
  chat: { restart: { mutate: vi.fn(async () => undefined) } },
  pty: {
    exists: { query: vi.fn(async () => false) },
    kill: { mutate: vi.fn(async () => undefined) }
  },
  task: { resetConversation: { mutate: vi.fn(async () => ({}) as Task) } }
}
const trpc = {
  task: {
    update: { mutationOptions: () => ({ mutationFn: (input: unknown) => updateFn(input) }) }
  },
  agentSessions: {
    current: {
      queryOptions: (input: unknown, opts: object) => ({
        queryKey: ['agentSessions.current', input],
        queryFn: async () => currentId,
        ...opts
      })
    },
    recordDetected: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => recordFn(input) })
    },
    onChanged: sub
  },
  menu: { onSyncSessionId: sub },
  pty: { onRespawnSuggested: respawnSub, onEnsureAlive: sub }
}
// The domain's typed view (`../trpc`) re-exports the runtime; point it at this mock.
vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => trpcClient,
  useSubscription: (opts: { respawn?: typeof respawnSuggested }) => {
    if (opts.respawn) respawnSuggested = opts.respawn
  }
}))
vi.mock('@slayzone/terminal', () => ({ markSkipCache: vi.fn() }))
vi.mock('@slayzone/task-terminals', () => ({ markForceStart: vi.fn(), requestAgentStart: vi.fn() }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  useStableCallback: (await importOriginal<typeof import('@slayzone/ui')>()).useStableCallback
}))

const { useTaskTerminalSession } = await import('./useTaskTerminalSession')

// codex has a session-id discovery command, so detected ids are persisted.
const task = (conversationId: string | null = null): Task => {
  currentId = conversationId
  return { id: 't1', agent_id: 'codex', provider_config: {} } as unknown as Task
}

const getMainSessionId = (id: string): string => `${id}:main`
const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 100)))

afterEach(() => {
  cleanup()
  updateFn.mockReset()
  recordFn.mockReset()
  currentId = null
  respawnSuggested = null
  vi.clearAllMocks()
})

function setup(initial: Task) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const onTaskUpdated = vi.fn()
  const resetTaskState = vi.fn()
  const setTerminalKey = vi.fn()
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
        resetTaskState,
        subscribeSessionDetected,
        setTerminalKey,
        agentCwd: '/tmp/repo'
      }),
    { initialProps: { t: initial }, wrapper }
  )
  return {
    ...hook,
    onTaskUpdated,
    resetTaskState,
    setTerminalKey,
    detect: (id: string) => act(() => detect(id))
  }
}

describe('useTaskTerminalSession — restart routing', () => {
  it.each(['codex-chat', 'claude-chat'] as const)(
    'restarts %s without touching the PTY or conversation',
    async (mode) => {
      const initial = {
        ...task(),
        agent_id: mode,
        provider_config: { [mode]: { flags: '--verbose' } }
      } as Task
      const { result, resetTaskState, setTerminalKey, onTaskUpdated } = setup(initial)

      await act(async () => result.current.handleRestartTerminal())

      expect(trpcClient.chat.restart.mutate).toHaveBeenCalledExactlyOnceWith({
        tabId: initial.id,
        taskId: initial.id,
        mode,
        cwd: '/tmp/repo',
        providerFlagsOverride: '--verbose'
      })
      expect(trpcClient.pty.kill.mutate).not.toHaveBeenCalled()
      expect(resetTaskState).not.toHaveBeenCalled()
      expect(setTerminalKey).not.toHaveBeenCalled()
      expect(trpcClient.task.resetConversation.mutate).not.toHaveBeenCalled()
      expect(onTaskUpdated).not.toHaveBeenCalled()
    }
  )

  it('still kills and remounts a terminal agent', async () => {
    const { result, resetTaskState, setTerminalKey } = setup(task('existing-session'))

    await act(async () => result.current.handleRestartTerminal())

    expect(trpcClient.pty.kill.mutate).toHaveBeenCalledExactlyOnceWith({ sessionId: 't1:main' })
    expect(resetTaskState).toHaveBeenCalledWith('t1:main')
    expect(setTerminalKey).toHaveBeenCalledOnce()
    expect(trpcClient.chat.restart.mutate).not.toHaveBeenCalled()
    expect(trpcClient.task.resetConversation.mutate).not.toHaveBeenCalled()
  })
})

describe('useTaskTerminalSession — detected conversation id persist', () => {
  it('a failing write is not retried by re-renders; a new task object retries once', async () => {
    recordFn.mockRejectedValue(new Error('computer offline'))
    const first = task()
    const { rerender, detect } = setup(first)
    detect('sess-1')
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(recordFn).toHaveBeenCalledWith({
      taskId: 't1',
      agentId: 'codex',
      conversationId: 'sess-1'
    })
    expect(updateFn).not.toHaveBeenCalled()

    // A parent re-render with the same task: no retry.
    rerender({ t: first })
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(1)

    // A board refetch (fresh task object) is the transient-failure retry — once.
    rerender({ t: task() })
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(2)
  })

  it('a successful write fires once and clears the detected id', async () => {
    recordFn.mockResolvedValue({ ok: true })
    const { result, rerender, detect } = setup(task())
    detect('sess-1')
    expect(result.current.detectedSessionId).toBe('sess-1')
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(result.current.detectedSessionId).toBeNull()

    rerender({ t: task('sess-1') })
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(1)
  })

  it('re-renders while the write is in flight do not issue a second write', async () => {
    let resolve: (v: { ok: true }) => void = () => {}
    recordFn.mockImplementation(() => new Promise<{ ok: true }>((r) => (resolve = r)))
    const { rerender, detect } = setup(task())
    detect('sess-1')
    rerender({ t: task() })
    rerender({ t: task() })
    await settle()
    expect(recordFn).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ ok: true }))
    expect(recordFn).toHaveBeenCalledTimes(1)
  })
})

describe('useTaskTerminalSession — revive (task leaves a terminal status)', () => {
  // A task owns its conversation: a revive restarts the agent on it (`--resume`),
  // never resets it — however long the task sat done. Starting fresh is only ever
  // the user's explicit "Start fresh".
  it('restarts on the current conversation, never resets it', async () => {
    setup(task('sess-1'))
    expect(respawnSuggested).not.toBeNull()
    await act(async () => respawnSuggested?.({ taskId: 't1' }))
    await settle()
    expect(trpcClient.pty.kill.mutate).toHaveBeenCalled()
    expect(trpcClient.task.resetConversation.mutate).not.toHaveBeenCalled()
  })
})
