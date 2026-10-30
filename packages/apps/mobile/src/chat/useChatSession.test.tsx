import { act, renderHook, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import { fakeHub } from './fake-hub'
import { useChatSession } from './useChatSession'

const target = {
  tabId: 'tab-1',
  taskId: 'task-1',
  mode: 'claude-chat',
  cwd: '/w',
  providerFlagsOverride: null
}

describe('useChatSession', () => {
  it('sends one answer per request, even for two taps in the same instant', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    let release: (ok: boolean) => void = () => undefined
    hub.on('chat.respondPermission', () => new Promise<boolean>((r) => (release = r)))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))

    const args = { requestId: 'r1', optionId: 'yes', decision: { behavior: 'allow' as const } }
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = result.current.respondPermission(args)
      second = result.current.respondPermission(args)
    })
    await expect(second).resolves.toBe(false)
    expect(result.current.submittingPrompts.has('r1')).toBe(true)
    await act(async () => release(true))
    await expect(first).resolves.toBe(true)
    expect(hub.callsTo('chat.respondPermission')).toHaveLength(1)
    expect(result.current.submittingPrompts.has('r1')).toBe(false)
  })

  it('loads the history after its subscription started, hydrating first', async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    const order: string[] = []
    hub.on('chat.hydrate', () => {
      order.push('hydrate')
      return null
    })
    hub.on('chat.getReplay', (input) => {
      order.push(`replay ${input.afterSeq}`)
      return {
        events: [{ seq: 0, event: { kind: 'user-message', id: 'u1', text: 'earlier' } }],
        live: { afterSeq: 0, liveSeq: 0, events: [] }
      }
    })
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(order).toEqual(['hydrate', 'replay -1'])
    expect(hub.subscribed['chat.onEvent']).toEqual([{ tabIds: ['tab-1'] }])
    expect(result.current.state.timeline.map((i) => i.kind)).toEqual(['user-text'])
  })

  it("reads a turn Claude Code starts by itself (a background task's answer) as working", async () => {
    const hub = fakeHub({ tabId: target.tabId, taskId: target.taskId })
    hub.on('chat.getReplay', () => ({
      events: [
        { seq: 0, event: { kind: 'turn-init', sessionId: 's1', model: 'opus', cwd: '/w' } },
        { seq: 1, event: { kind: 'user-message', id: 'u1', text: 'run it in the background' } },
        { seq: 2, event: { kind: 'result', subtype: 'success', isError: false, durationMs: 1 } },
        // No user message: the agent answers the finished background task on its own.
        { seq: 3, event: { kind: 'turn-init', sessionId: 's1', model: 'opus', cwd: '/w' } },
        { seq: 4, event: { kind: 'assistant-text', messageId: 'm2', text: 'The task finished.' } }
      ],
      live: { afterSeq: 4, liveSeq: 4, events: [] }
    }))
    const { wrapper } = trpcTest(hub.backend)
    const { result } = await renderHook(() => useChatSession(target), { wrapper })
    await waitFor(() => expect(result.current.hydrating).toBe(false))
    expect(result.current.state.agentStartedTurns).toBe(true)
    expect(result.current.inFlight).toBe(true)
  })
})
