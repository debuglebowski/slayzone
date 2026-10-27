// @vitest-environment jsdom
// Pins PtyProvider's event-stream fan-out: each pty.* subscription routes its
// payload to the per-session subscribers and keeps the per-session metadata.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

// useSubscription stand-in: remembers the latest onData per pty procedure so a
// test can emit the way the server fan-out would.
const handlers = new Map<string, (payload: unknown) => unknown>()
const getBuffer = vi.fn()
const procs = [
  'onData',
  'onExit',
  'onPrompt',
  'onSessionDetected',
  'onDevServerDetected',
  'onTitleChange'
] as const
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    pty: Object.fromEntries(
      procs.map((p) => [
        p,
        {
          subscriptionOptions: (
            _input: undefined,
            opts: { onData: (payload: unknown) => unknown }
          ) => ({ proc: p, ...opts })
        }
      ])
    )
  }),
  useTRPCClient: () => ({ pty: { getBuffer: { query: getBuffer } } }),
  useSubscription: (opts: { proc: string; onData: (payload: unknown) => unknown }) => {
    handlers.set(opts.proc, opts.onData)
  },
  useFederationOrNull: () => null,
  HubScope: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

const disposeTerminal = vi.fn()
vi.mock('./terminal-cache', () => ({ disposeTerminal: (id: string) => disposeTerminal(id) }))
vi.mock('./useTerminalStateStore', () => ({
  useWireTerminalStateStore: () => undefined,
  useTerminalStateStore: {
    getState: () => ({ getSessionState: () => 'idle', clearSession: vi.fn() }),
    subscribe: vi.fn()
  }
}))

const { PtyProvider, usePty } = await import('./PtyContext')
type Ctx = ReturnType<typeof usePty>

function mount(): { ctx: () => Ctx } {
  let ctx: Ctx | null = null
  function Grab(): null {
    ctx = usePty()
    return null
  }
  render(
    <PtyProvider>
      <Grab />
    </PtyProvider>
  )
  return {
    ctx: () => {
      if (!ctx) throw new Error('no context')
      return ctx
    }
  }
}

async function emit(proc: (typeof procs)[number], payload: unknown): Promise<void> {
  const handler = handlers.get(proc)
  if (!handler) throw new Error(`no subscription for ${proc}`)
  await act(async () => {
    await handler(payload)
  })
}

afterEach(() => {
  cleanup()
  handlers.clear()
  vi.clearAllMocks()
})

describe('PtyProvider event streams', () => {
  it('delivers data in seq order to known sessions only', async () => {
    const { ctx } = mount()
    const cb = vi.fn()
    ctx().subscribe('s1', cb)

    await emit('onData', { sessionId: 's1', data: 'a', seq: 1 })
    await emit('onData', { sessionId: 's1', data: 'dup', seq: 1 })
    await emit('onData', { sessionId: 's1', data: 'b', seq: 2 })
    await emit('onData', { sessionId: 'unknown', data: 'x', seq: 5 })

    expect(cb.mock.calls).toEqual([
      ['a', 1],
      ['b', 2]
    ])
    expect(ctx().getLastSeq('s1')).toBe(2)
  })

  it('delivers prompts to known sessions only', async () => {
    const { ctx } = mount()
    const promptCb = vi.fn()
    const unknownCb = vi.fn()
    ctx().subscribe('s1', vi.fn()) // creates the session state
    ctx().subscribePrompt('s1', promptCb)
    ctx().subscribePrompt('nobody', unknownCb) // no session state

    const prompt = { type: 'permission', text: 'ok?' }
    await emit('onPrompt', { sessionId: 's1', prompt })
    await emit('onPrompt', { sessionId: 'nobody', prompt })
    expect(promptCb.mock.calls).toEqual([[prompt]])
    expect(unknownCb).not.toHaveBeenCalled()
  })

  it('fires exit subscribers, captures crash output, then frees the session', async () => {
    const { ctx } = mount()
    const exitCb = vi.fn()
    const dataCb = vi.fn()
    ctx().subscribe('s1', dataCb)
    ctx().subscribeExit('s1', exitCb)
    getBuffer.mockResolvedValue('stack trace')

    await emit('onExit', { sessionId: 's1', exitCode: 1, errorCode: 'E', exitReason: 'r' })
    expect(getBuffer).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(exitCb).toHaveBeenCalledWith(1, 'E', 'r')
    expect(disposeTerminal).toHaveBeenCalledWith('s1')
    expect(ctx().getLastSeq('s1')).toBe(-1)

    // Subscribers were dropped with the session.
    ctx().subscribe('s1', vi.fn())
    await emit('onData', { sessionId: 's1', data: 'late', seq: 1 })
    expect(dataCb).not.toHaveBeenCalled()
  })

  it('a clean exit skips the crash-output read', async () => {
    const { ctx } = mount()
    const exitCb = vi.fn()
    ctx().subscribe('s1', vi.fn())
    ctx().subscribeExit('s1', exitCb)
    await emit('onExit', { sessionId: 's1', exitCode: 0, errorCode: null, exitReason: null })
    expect(getBuffer).not.toHaveBeenCalled()
    expect(exitCb).toHaveBeenCalledWith(0, null, null)
  })

  it('routes session-detected, dev-server and title events per session', async () => {
    const { ctx } = mount()
    const detected = vi.fn()
    const dev = vi.fn()
    const title = vi.fn()
    ctx().subscribeSessionDetected('s1', detected)
    ctx().subscribeDevServer('s1', dev)
    ctx().subscribeTitle('s1', title)

    await emit('onSessionDetected', { sessionId: 's1', conversationId: 'c1' })
    await emit('onDevServerDetected', { sessionId: 's1', url: 'http://localhost:3000' })
    await emit('onTitleChange', { sessionId: 's1', title: 'vim' })
    await emit('onTitleChange', { sessionId: 's2', title: 'other' })

    expect(detected).toHaveBeenCalledWith('c1')
    expect(dev).toHaveBeenCalledWith('http://localhost:3000')
    expect(title.mock.calls).toEqual([['vim']])
  })
})
