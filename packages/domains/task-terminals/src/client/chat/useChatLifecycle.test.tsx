// @vitest-environment jsdom
// Pins useChatLifecycle: the "session ended" display flag, the one-shot startup
// decision (open-time state, startup mode, shown gate), reset / restart, the
// queue clear on session end, and the inFlight diagnostics that never escalate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ChatTimelineState } from '@slayzone/terminal/client'
import { expectKnownBug } from '@slayzone/test-utils/known-bug'
import type { ChatActions } from './autocomplete/types'

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

type SettingsGet = (input: { key: string }) => Promise<string | null>
type RecordClientEvent = (input: Record<string, unknown>) => Promise<unknown>

const m = vi.hoisted(() => {
  const settingsGet = vi.fn<SettingsGet>()
  const recordClientEvent = vi.fn<RecordClientEvent>()
  return {
    settingsGet,
    recordClientEvent,
    toast: vi.fn(),
    // One identity for the hook's lifetime, like the real client. The procedures
    // are swappable: a leak test installs a plain function (see `leakable`).
    client: {
      settings: { get: { query: settingsGet as SettingsGet } },
      diagnostics: { recordClientEvent: { mutate: recordClientEvent as RecordClientEvent } }
    }
  }
})

vi.mock('../trpc', () => ({ useTRPCClient: () => m.client }))
vi.mock('@slayzone/ui', () => ({ toast: m.toast }))

import { useChatLifecycle, type UseChatLifecycleOpts } from './useChatLifecycle'

const TARGET = {
  tabId: 'tab1',
  taskId: 'task1',
  mode: 'claude-chat',
  cwd: '/repo',
  providerFlagsOverride: null
}

/** The timeline fields the hook reads; the rest of the reducer state is irrelevant here. */
const timelineState = (over: Partial<ChatTimelineState> = {}): ChatTimelineState =>
  ({
    timeline: [],
    sessionId: 'sess1',
    sessionEnded: false,
    notStarted: false,
    userMessagesSent: 0,
    resultCount: 0,
    ...over
  }) as ChatTimelineState

const makeChatApi = () => ({
  kill: vi.fn<ChatActions['kill']>(() => Promise.resolve()),
  remove: vi.fn<ChatActions['remove']>(() => Promise.resolve()),
  reset: vi.fn<ChatActions['reset']>(() => Promise.resolve()),
  hydrate: vi.fn<ChatActions['hydrate']>(() => Promise.resolve()),
  start: vi.fn<ChatActions['start']>(() => Promise.resolve()),
  send: vi.fn<ChatActions['send']>(() => Promise.resolve(true)),
  interrupt: vi.fn<ChatActions['interrupt']>(() => Promise.resolve())
})

function setup(over: Partial<UseChatLifecycleOpts> = {}) {
  const chatApi = makeChatApi()
  const resetTimeline = vi.fn()
  const setDraft = vi.fn()
  const clearQueue = vi.fn(() => Promise.resolve())
  const props: UseChatLifecycleOpts = {
    tabId: TARGET.tabId,
    taskId: TARGET.taskId,
    mode: TARGET.mode,
    cwd: TARGET.cwd,
    chatApi,
    inFlight: false,
    hydrating: false,
    state: timelineState(),
    resetTimeline,
    setDraft,
    clearQueue,
    ...over
  }
  const hook = renderHook((p: UseChatLifecycleOpts) => useChatLifecycle(p), {
    initialProps: props
  })
  const update = (next: Partial<UseChatLifecycleOpts>) => hook.rerender({ ...props, ...next })
  return { ...hook, props, update, chatApi, resetTimeline, setDraft, clearQueue }
}

/** Let the settings read (and the state updates it triggers) land. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

/**
 * A plain function that records its calls and rejects. Leak tests need it instead
 * of a vi.fn: a spy attaches its own rejection handler to every promise it returns
 * (for `mock.settledResults`), which marks the rejection handled and hides a leak.
 */
function leakable<A>(message: string) {
  const calls: A[] = []
  const fn = (input: A): Promise<never> => {
    calls.push(input)
    return Promise.reject(new Error(message))
  }
  return { calls, fn }
}

/**
 * Runs `fn` with the worker's own unhandled-rejection listeners swapped for a
 * recorder, so a leaked rejection is an assertion here instead of a run error.
 */
async function unhandledRejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const saved = process.listeners('unhandledRejection')
  const record = (reason: unknown) => {
    seen.push(reason)
  }
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', record)
  try {
    await fn()
    await new Promise((r) => setTimeout(r, 10))
  } finally {
    process.off('unhandledRejection', record)
    for (const listener of saved) process.on('unhandledRejection', listener)
  }
  return seen
}

beforeEach(() => {
  m.settingsGet.mockReset().mockResolvedValue('auto')
  m.recordClientEvent.mockReset().mockResolvedValue(undefined)
  m.toast.mockReset()
  m.client.settings.get.query = m.settingsGet
  m.client.diagnostics.recordClientEvent.mutate = m.recordClientEvent
})
afterEach(cleanup)

describe('useChatLifecycle displaySessionEnded', () => {
  it('shows a session that ran and ended', () => {
    const { result } = setup({ state: timelineState({ sessionEnded: true }) })
    expect(result.current.displaySessionEnded).toBe(true)
  })

  it('hides it while no subprocess has started yet', () => {
    const { result } = setup({ state: timelineState({ sessionEnded: true, notStarted: true }) })
    expect(result.current.displaySessionEnded).toBe(false)
  })

  it('hides it while a reset is in flight', async () => {
    const { result, chatApi } = setup({ state: timelineState({ sessionEnded: true }) })
    const reset = deferred<unknown>()
    chatApi.reset.mockReturnValueOnce(reset.promise)
    let done!: Promise<void>
    act(() => {
      done = result.current.handleReset()
    })
    expect(result.current.displaySessionEnded).toBe(false)
    await act(async () => {
      reset.resolve(undefined)
      await done
    })
    expect(result.current.displaySessionEnded).toBe(true)
  })

  it('hides it while a restart is in flight', async () => {
    const { result, chatApi } = setup({ state: timelineState({ sessionEnded: true }) })
    const start = deferred<unknown>()
    chatApi.start.mockReturnValueOnce(start.promise)
    let done!: Promise<void>
    act(() => {
      done = result.current.handleRestart()
    })
    expect(result.current.displaySessionEnded).toBe(false)
    await act(async () => {
      start.resolve(undefined)
      await done
    })
    expect(result.current.displaySessionEnded).toBe(true)
  })
})

describe('useChatLifecycle startup (non-main tab)', () => {
  it('restores an agent that was running', async () => {
    const { chatApi } = setup({ agentState: 'running' })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
    expect(chatApi.start).toHaveBeenCalledWith(TARGET)
  })

  it('leaves a stopped agent for the user to start (the default state)', async () => {
    const { chatApi } = setup()
    await flush()
    expect(m.settingsGet).toHaveBeenCalledTimes(1)
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('leaves a new agent alone even under instant startup', async () => {
    m.settingsGet.mockResolvedValue('instant')
    const { chatApi } = setup({ agentState: 'new' })
    await flush()
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('restores a running agent even under manual startup', async () => {
    m.settingsGet.mockResolvedValue('manual')
    const { chatApi } = setup({ agentState: 'running' })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('passes the provider flags override through', async () => {
    const { chatApi } = setup({ agentState: 'running', providerFlagsOverride: '--verbose' })
    await flush()
    expect(chatApi.start).toHaveBeenCalledWith({ ...TARGET, providerFlagsOverride: '--verbose' })
  })
})

describe('useChatLifecycle startup decision', () => {
  it('reads the startup setting by its key', async () => {
    setup()
    await flush()
    expect(m.settingsGet).toHaveBeenCalledWith({ key: 'terminal_agent_startup' })
  })

  it('waits for hydration before deciding', async () => {
    const { chatApi, update } = setup({ agentState: 'running', hydrating: true })
    await flush()
    expect(m.settingsGet).not.toHaveBeenCalled()
    expect(chatApi.start).not.toHaveBeenCalled()
    update({ hydrating: false })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('decides once per mount, even when hydration runs again', async () => {
    const { update } = setup({ agentState: 'running' })
    await flush()
    update({ hydrating: true })
    update({ hydrating: false })
    await flush()
    expect(m.settingsGet).toHaveBeenCalledTimes(1)
  })

  it('starts once, even when chatApi changes identity', async () => {
    const { chatApi, update } = setup({ agentState: 'running' })
    await flush()
    const nextApi = makeChatApi()
    update({ chatApi: nextApi })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
    expect(nextApi.start).not.toHaveBeenCalled()
  })

  it('decides against the state the tab opened with', async () => {
    const { chatApi, update } = setup({ agentState: 'stopped', hydrating: true })
    // The agent's state moved on before hydration settled.
    update({ agentState: 'running', hydrating: false })
    await flush()
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('keeps the chat lazy when the setting read fails', async () => {
    const settings = leakable<{ key: string }>('hub down')
    m.client.settings.get.query = settings.fn
    let chatApi!: ReturnType<typeof makeChatApi>
    const leaked = await unhandledRejectionsDuring(async () => {
      chatApi = setup({ agentState: 'running', isMain: true }).chatApi
      await flush()
    })
    expect(settings.calls).toHaveLength(1)
    expect(leaked).toEqual([])
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('does not leave a failed auto-start as an unhandled rejection', async () => {
    const start = leakable<Parameters<ChatActions['start']>[0]>('spawn failed')
    const chatApi: ChatActions = { ...makeChatApi(), start: start.fn }
    const leaked = await unhandledRejectionsDuring(async () => {
      setup({ agentState: 'running', chatApi })
      await flush()
    })
    expect(start.calls).toEqual([TARGET])
    await expectKnownBug(
      {
        fixedBy: '1.9',
        what: 'auto-start `void chatApi.start()` leaks its rejection: no toast, lands in window.unhandledrejection'
      },
      () => expect(leaked).toEqual([])
    )
  })
})

describe('useChatLifecycle startup (main tab)', () => {
  it('auto: restores a running agent even off screen', async () => {
    const { chatApi } = setup({ isMain: true, agentState: 'running', shown: false })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('auto: starts a new task at once', async () => {
    const { chatApi } = setup({ isMain: true, agentState: 'new' })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('auto: leaves a stopped agent for the Start gate', async () => {
    const { chatApi } = setup({ isMain: true, agentState: 'stopped' })
    await flush()
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('falls back to auto when the setting is unset', async () => {
    m.settingsGet.mockResolvedValue(null)
    const { chatApi } = setup({ isMain: true, agentState: 'new' })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('manual: never starts, even a running agent on screen', async () => {
    m.settingsGet.mockResolvedValue('manual')
    const { chatApi } = setup({ isMain: true, agentState: 'running', shown: true })
    await flush()
    expect(chatApi.start).not.toHaveBeenCalled()
  })

  it('instant: starts a stopped agent that is on screen', async () => {
    m.settingsGet.mockResolvedValue('instant')
    const { chatApi } = setup({ isMain: true, agentState: 'stopped', shown: true })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('instant: waits off screen until the task is shown', async () => {
    m.settingsGet.mockResolvedValue('instant')
    const { chatApi, update } = setup({ isMain: true, agentState: 'auto_stopped', shown: false })
    await flush()
    expect(chatApi.start).not.toHaveBeenCalled()
    update({ shown: true })
    expect(chatApi.start).toHaveBeenCalledTimes(1)
    expect(chatApi.start).toHaveBeenCalledWith(TARGET)
  })

  it('instant: starts only once across show / hide', async () => {
    m.settingsGet.mockResolvedValue('instant')
    const { chatApi, update } = setup({ isMain: true, agentState: 'stopped', shown: false })
    await flush()
    update({ shown: true })
    update({ shown: false })
    update({ shown: true })
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('temporary task: always starts, even under manual', async () => {
    m.settingsGet.mockResolvedValue('manual')
    const { chatApi } = setup({
      isMain: true,
      isTemporary: true,
      agentState: 'stopped',
      shown: false
    })
    await flush()
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })
})

describe('useChatLifecycle handleRestart', () => {
  it('eagerly starts the chat for the tab', async () => {
    const { result, chatApi } = setup({ providerFlagsOverride: '--verbose' })
    await act(() => result.current.handleRestart())
    expect(chatApi.start).toHaveBeenCalledWith({ ...TARGET, providerFlagsOverride: '--verbose' })
  })

  it('flags restarting until the start settles', async () => {
    const { result, chatApi } = setup()
    const start = deferred<unknown>()
    chatApi.start.mockReturnValueOnce(start.promise)
    let done!: Promise<void>
    act(() => {
      done = result.current.handleRestart()
    })
    expect(result.current.restarting).toBe(true)
    await act(async () => {
      start.resolve(undefined)
      await done
    })
    expect(result.current.restarting).toBe(false)
  })

  it('ignores a second restart while one is in flight', async () => {
    const { result, chatApi } = setup()
    chatApi.start.mockReturnValueOnce(new Promise(() => {}))
    act(() => {
      void result.current.handleRestart()
    })
    await act(() => result.current.handleRestart())
    expect(chatApi.start).toHaveBeenCalledTimes(1)
  })

  it('toasts a failed restart and clears the flag', async () => {
    const { result, chatApi } = setup()
    chatApi.start.mockRejectedValueOnce(new Error('spawn failed'))
    await act(() => result.current.handleRestart())
    expect(m.toast).toHaveBeenCalledWith('Restart failed: spawn failed')
    expect(result.current.restarting).toBe(false)
  })

  it('toasts a non-Error rejection as text', async () => {
    const { result, chatApi } = setup()
    chatApi.start.mockRejectedValueOnce('hub gone')
    await act(() => result.current.handleRestart())
    expect(m.toast).toHaveBeenCalledWith('Restart failed: hub gone')
  })
})

describe('useChatLifecycle handleReset', () => {
  it('clears the timeline, draft and queue at once', async () => {
    const { result, chatApi, resetTimeline, setDraft, clearQueue } = setup()
    chatApi.reset.mockReturnValueOnce(new Promise(() => {}))
    act(() => {
      void result.current.handleReset()
    })
    expect(resetTimeline).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith('')
    expect(clearQueue).toHaveBeenCalledTimes(1)
    expect(result.current.resetting).toBe(true)
  })

  it('resets the session and toasts', async () => {
    const { result, chatApi } = setup({ providerFlagsOverride: '--verbose' })
    await act(() => result.current.handleReset())
    expect(chatApi.reset).toHaveBeenCalledWith({ ...TARGET, providerFlagsOverride: '--verbose' })
    expect(m.toast).toHaveBeenCalledWith('Chat reset')
    expect(result.current.resetting).toBe(false)
  })

  it('does not interrupt an idle session', async () => {
    const { result, chatApi } = setup({ inFlight: false })
    await act(() => result.current.handleReset())
    expect(chatApi.interrupt).not.toHaveBeenCalled()
  })

  it('interrupts an in-flight turn before the reset', async () => {
    const { result, chatApi } = setup({ inFlight: true })
    await act(() => result.current.handleReset())
    expect(chatApi.interrupt).toHaveBeenCalledWith(TARGET)
    expect(chatApi.interrupt.mock.invocationCallOrder[0]).toBeLessThan(
      chatApi.reset.mock.invocationCallOrder[0]
    )
  })

  it('toasts a failed reset, resolves, and clears the flag', async () => {
    const { result, chatApi } = setup()
    chatApi.reset.mockRejectedValueOnce(new Error('kill failed'))
    await act(() => result.current.handleReset())
    expect(m.toast).toHaveBeenCalledWith('Reset failed: kill failed')
    expect(m.toast).not.toHaveBeenCalledWith('Chat reset')
    expect(result.current.resetting).toBe(false)
  })

  it('ignores a second reset while one is in flight', async () => {
    const { result, chatApi, resetTimeline } = setup()
    chatApi.reset.mockReturnValueOnce(new Promise(() => {}))
    act(() => {
      void result.current.handleReset()
    })
    await act(() => result.current.handleReset())
    expect(chatApi.reset).toHaveBeenCalledTimes(1)
    expect(resetTimeline).toHaveBeenCalledTimes(1)
  })
})

describe('useChatLifecycle queue', () => {
  it('leaves the queue alone while the session is live', () => {
    const { clearQueue } = setup()
    expect(clearQueue).not.toHaveBeenCalled()
  })

  it('clears the queue when the session ends', () => {
    const { clearQueue, update } = setup()
    update({ state: timelineState({ sessionEnded: true }) })
    expect(clearQueue).toHaveBeenCalledTimes(1)
  })
})

describe('useChatLifecycle inFlight diagnostics', () => {
  it('records nothing while hydrating', () => {
    const { update } = setup({ hydrating: true, inFlight: true })
    update({ inFlight: false })
    expect(m.recordClientEvent).not.toHaveBeenCalled()
  })

  it('records the post-hydration baseline as a flip from init', () => {
    const items = ['user', 'text', 'tool', 'text', 'result', 'user', 'text'].map(
      (kind) => ({ kind }) as ChatTimelineState['timeline'][number]
    )
    const state = timelineState({
      timeline: items,
      userMessagesSent: 2,
      resultCount: 1
    })
    const { update } = setup({ hydrating: true, inFlight: true, state })
    update({ hydrating: false })
    expect(m.recordClientEvent).toHaveBeenCalledTimes(1)
    expect(m.recordClientEvent).toHaveBeenCalledWith({
      event: 'renderer.chat.inFlight.flip',
      level: 'info',
      message: 'inFlight init→true',
      taskId: 'task1',
      sessionId: 'sess1',
      payload: {
        tabId: 'tab1',
        mode: 'claude-chat',
        from: null,
        to: true,
        userMessagesSent: 2,
        resultCount: 1,
        sessionEnded: false,
        timelineLen: 7,
        lastEventKinds: ['tool', 'text', 'result', 'user', 'text']
      }
    })
  })

  it('records each flip once, and nothing for other state changes', () => {
    const { update } = setup({ inFlight: false })
    update({ inFlight: true })
    update({ inFlight: true, state: timelineState({ resultCount: 3 }) })
    update({ inFlight: false })
    const flips = m.recordClientEvent.mock.calls.map(([input]) => input.message)
    expect(flips).toEqual(['inFlight init→false', 'inFlight false→true', 'inFlight true→false'])
  })

  it('swallows a diagnostics call that throws', () => {
    m.recordClientEvent.mockImplementation(() => {
      throw new Error('not connected')
    })
    const { result, update } = setup({ inFlight: false })
    update({ inFlight: true })
    expect(m.recordClientEvent).toHaveBeenCalledTimes(2)
    expect(result.current.displaySessionEnded).toBe(false)
  })

  it('swallows a diagnostics call that rejects', async () => {
    const record = leakable<Record<string, unknown>>('not connected')
    m.client.diagnostics.recordClientEvent.mutate = record.fn
    const leaked = await unhandledRejectionsDuring(async () => {
      const { update } = setup({ inFlight: false })
      update({ inFlight: true })
      await flush()
    })
    expect(record.calls).toHaveLength(2)
    expect(leaked).toEqual([])
  })
})
