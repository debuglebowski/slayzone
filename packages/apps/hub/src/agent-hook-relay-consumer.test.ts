import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { RestApiDeps, TerminalStateBridge } from '@slayzone/transport/server'
import { attachAgentHookRelayConsumer, type AgentHookRelayGateway } from './agent-hook-relay-consumer'

// processAgentHook reaches into the task + diagnostics domains (DB writes). Mock
// those exactly as the transport's own agent-hook.test.ts does, so this unit
// stays hermetic and asserts the CONSUMER wiring, not the domains.
vi.mock('@slayzone/terminal/server', () => ({
  isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode)
}))
vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => {} }))
const getBoundTaskIdSpy = vi.fn<(db: unknown, sid: string) => Promise<string | null>>(
  async () => null
)
vi.mock('@slayzone/task/server', () => ({
  recordConversation: vi.fn(),
  findPendingSpawn: vi.fn(async () => ({ expectedSessionId: null, usedResume: false })),
  confirmSessionConversation: vi.fn(),
  getBoundTaskId: (_db: unknown, sid: string) => getBoundTaskIdSpy(_db, sid)
}))

/** A fake gateway that lets the test emit `event` notifications synchronously. */
function makeFakeGateway(): {
  gateway: AgentHookRelayGateway
  emit: (payload: { runnerId: string; name: string; payload?: unknown }) => void
} {
  let handler:
    | ((payload: { runnerId: string; name: string; payload?: unknown }) => void)
    | null = null
  const gateway: AgentHookRelayGateway = {
    events: {
      on: (_event, listener) => {
        handler = listener
      }
    }
  }
  return { gateway, emit: (p) => handler?.(p) }
}

const findSessionSpy = vi.fn<(taskId: string, mode: string) => string | null>()
const transitionSpy = vi.fn()
const markActiveSpy = vi.fn()
const lifecycleSpy = vi.fn()

function makeDeps(): RestApiDeps {
  return {
    db: {} as never,
    notifyRenderer: () => {},
    agentLifecycle: {
      emit: (_c: string, e: unknown) => {
        lifecycleSpy(e)
        return true
      }
    } as never
  } as unknown as RestApiDeps
}

function makeBridge(): TerminalStateBridge {
  return {
    findSession: (taskId, mode) => findSessionSpy(taskId, mode),
    transition: (s, st, e) => {
      transitionSpy(s, st, e)
      return true
    },
    markActive: (s) => {
      markActiveSpy(s)
      return true
    }
  }
}

/** processAgentHook is async + fire-and-forget from the consumer; let its
 *  microtasks flush before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('attachAgentHookRelayConsumer', () => {
  beforeEach(() => {
    findSessionSpy.mockReset().mockReturnValue(null)
    transitionSpy.mockReset()
    markActiveSpy.mockReset()
    lifecycleSpy.mockReset()
    getBoundTaskIdSpy.mockClear()
  })

  test('an `agent-hook` event drives the SAME processAgentHook path (bridge transition)', async () => {
    findSessionSpy.mockReturnValue('task-r:task-r')
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    // Envelope shape a runner relays: the raw {ctx,raw,arg} the benign notify.sh
    // POSTed to the runner loopback, forwarded verbatim as the event payload.
    emit({
      runnerId: 'runner-a',
      name: 'agent-hook',
      payload: {
        ctx: { v: 1, taskId: 'task-r', agentId: 'claude-code', channel: 'stable' },
        raw: { hook_event_name: 'UserPromptSubmit' },
        arg: null
      }
    })
    await flush()

    expect(findSessionSpy).toHaveBeenCalledWith('task-r', 'claude-code')
    expect(transitionSpy).toHaveBeenCalledWith('task-r:task-r', 'running', 'UserPromptSubmit')
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
  })

  test('a non-`agent-hook` event is ignored (no processing)', async () => {
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    emit({ runnerId: 'runner-a', name: 'some-other-event', payload: { hookEvent: 'Stop' } })
    await flush()

    expect(lifecycleSpy).not.toHaveBeenCalled()
    expect(findSessionSpy).not.toHaveBeenCalled()
  })

  test('a malformed/unresolvable payload NEVER throws out of the event loop', async () => {
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    // No identity at all → processAgentHook returns 'bad'; the consumer must
    // swallow it (a thrown error here would destabilize every runner).
    expect(() =>
      emit({ runnerId: 'runner-a', name: 'agent-hook', payload: { ctx: { v: 1 } } })
    ).not.toThrow()
    await flush()
    expect(transitionSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })

  test('relayed pooled hook (slaySessionId, no taskId) resolves task via getBoundTaskId', async () => {
    getBoundTaskIdSpy.mockResolvedValue('bound-task' as never)
    findSessionSpy.mockReturnValue('bound-task:bound-task')
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    emit({
      runnerId: 'runner-a',
      name: 'agent-hook',
      payload: {
        ctx: { v: 1, slaySessionId: 'pool-1', agentId: 'claude-code' },
        raw: { hook_event_name: 'UserPromptSubmit' }
      }
    })
    await flush()

    expect(getBoundTaskIdSpy).toHaveBeenCalledWith(expect.anything(), 'pool-1')
    expect(transitionSpy).toHaveBeenCalledWith(
      'bound-task:bound-task',
      'running',
      'UserPromptSubmit'
    )
  })
})
