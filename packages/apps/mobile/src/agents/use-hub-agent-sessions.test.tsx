import { act, renderHook, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import { useHubAgentSessions } from './use-hub-agent-sessions'

type Emit = (data: unknown) => void

/** A hub whose pushes the test drives, and whose snapshot it can change. */
function hub(initial: { sessions?: unknown[]; hibernated?: string[] } = {}) {
  const emitters: Record<string, Emit> = {}
  const snapshot = { sessions: initial.sessions ?? [], hibernated: initial.hibernated ?? [] }
  const calls = { sessionList: 0 }
  const sub =
    (name: string) =>
    (_input: unknown, emit: Emit): void => {
      emitters[name] = emit
    }
  const test = trpcTest({
    procedures: {
      'pty.sessionList': () => {
        calls.sessionList++
        return snapshot.sessions
      },
      'taskTerminals.listHibernatedSessions': () => snapshot.hibernated
    },
    subscriptions: {
      'pty.onStateChange': sub('state'),
      'pty.onExit': sub('exit'),
      'pty.onBackgroundJobs': sub('jobs'),
      'pty.onHibernated': sub('hibernated')
    }
  })
  const emit = async (name: string, data: unknown) => {
    await act(async () => emitters[name](data))
  }
  return { ...test, snapshot, calls, emit }
}

describe('useHubAgentSessions', () => {
  it("seeds from the hub's session list and its hibernated set", async () => {
    const h = hub({
      sessions: [
        { sessionId: 'a:a', state: 'running', kind: 'pty', backgroundJobs: 2 },
        { sessionId: 'c:c', state: 'idle', kind: 'chat' }
      ],
      hibernated: ['z:z']
    })
    const { result } = await renderHook(() => useHubAgentSessions(), { wrapper: h.wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.state.byId).toEqual({
      'a:a': 'running',
      'c:c': 'idle',
      'z:z': 'hibernated'
    })
    expect(result.current.state.jobsById).toEqual({ 'a:a': 2 })
    expect(result.current.error).toBeNull()
  })

  it('follows the pushes: state changes, exits, background jobs, hibernation', async () => {
    const h = hub({ sessions: [{ sessionId: 'a:a', state: 'running', kind: 'pty' }] })
    const { result } = await renderHook(() => useHubAgentSessions(), { wrapper: h.wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await h.emit('state', { sessionId: 'a:a', newState: 'idle', oldState: 'running' })
    expect(result.current.state.byId['a:a']).toBe('idle')
    await h.emit('jobs', { sessionId: 'a:a', count: 3 })
    expect(result.current.state.jobsById['a:a']).toBe(3)
    await h.emit('state', { sessionId: 'b:b', newState: 'starting', oldState: 'dead' })
    expect(result.current.state.byId['b:b']).toBe('starting')
    await h.emit('exit', { sessionId: 'a:a', exitCode: 0, errorCode: null })
    expect(result.current.state.byId['a:a']).toBe('dead')
    expect(result.current.state.jobsById['a:a']).toBeUndefined()
    await h.emit('hibernated', { sessionId: 'b:b' })
    expect(result.current.state.byId['b:b']).toBe('hibernated')
  })

  it('reports why the snapshot failed', async () => {
    const h = trpcTest({
      procedures: {
        'pty.sessionList': () => {
          throw new Error('hub requires authentication')
        },
        'taskTerminals.listHibernatedSessions': () => []
      },
      subscriptions: {
        'pty.onStateChange': () => undefined,
        'pty.onExit': () => undefined,
        'pty.onBackgroundJobs': () => undefined,
        'pty.onHibernated': () => undefined
      }
    })
    const { result } = await renderHook(() => useHubAgentSessions(), { wrapper: h.wrapper })
    await waitFor(() => expect(result.current.error).toBe('hub requires authentication'))
    expect(result.current.loaded).toBe(false)
  })
})
