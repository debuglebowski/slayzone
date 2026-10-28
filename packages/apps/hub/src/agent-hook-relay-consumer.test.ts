import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { RestApiDeps, TerminalStateBridge } from '@slayzone/api'
import {
  attachAgentHookRelayConsumer,
  type AgentHookRelayGateway
} from './agent-hook-relay-consumer'

// processAgentHook reaches into the task + diagnostics domains (DB writes). Mock
// those exactly as the transport's own agent-hook.test.ts does, so this unit
// stays hermetic and asserts the CONSUMER wiring, not the domains.
// A warm agent the pool still holds (booted with `taskId`, not adopted yet).
const unadoptedWarmAgentSpy = vi.fn<(taskId: string) => { sessionId: string } | null>(() => null)
// The claude agent tree is pure, so the real module is used (by path: the barrel
// pulls in the native pty manager) — a hand-rolled fake would drift from its states.
vi.mock('@slayzone/terminal/server', async () => {
  const agentTree = await import('../../../domains/terminal/src/server/agent-tree.js')
  const lifecycle = await import('../../../domains/terminal/src/server/agent-lifecycle-router.js')
  const pty = await import('../../../domains/terminal/src/server/pty-router.js')
  const chat = await import('../../../domains/terminal/src/server/chat-router.js')
  return {
    agentLifecycleRouter: lifecycle.agentLifecycleRouter,
    ptyRouter: pty.ptyRouter,
    chatRouter: chat.chatRouter,
    isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode),
    applyAgentHook: agentTree.applyAgentHook,
    createAgentTree: agentTree.createAgentTree,
    resolveState: agentTree.resolveState,
    subagentIdOf: agentTree.subagentIdOf,
    CLAUDE_BLOCKING_TOOLS: agentTree.CLAUDE_BLOCKING_TOOLS,
    unadoptedWarmAgent: (taskId: string) => unadoptedWarmAgentSpy(taskId)
  }
})
vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => {} }))
const confirmSessionConversationSpy = vi.fn()
vi.mock('@slayzone/task/server', async () => {
  // api's router composes task's own routers; empty stand-ins keep it importable.
  const { router } = await import('@slayzone/trpc-server')
  return {
    taskRouter: router({}),
    agentSessionsRouter: router({}),
    templateRouter: router({}),
    recordConversation: vi.fn(),
    findPendingSpawn: vi.fn(async () => ({ expectedSessionId: null, usedResume: false })),
    confirmSessionConversation: (...args: unknown[]) => confirmSessionConversationSpy(...args),
    markSessionFirstTurn: vi.fn(async () => {}),
    artifactsDirOf: (dataDir: string) => `${dataDir}/artifacts`
  }
})

/** A fake gateway that lets the test emit `event` notifications synchronously. */
function makeFakeGateway(): {
  gateway: AgentHookRelayGateway
  emit: (payload: { computerId: string; name: string; payload?: unknown }) => void
} {
  let handler: ((payload: { computerId: string; name: string; payload?: unknown }) => void) | null =
    null
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
    unadoptedWarmAgentSpy.mockReset().mockReturnValue(null)
    confirmSessionConversationSpy.mockReset()
  })

  test('an `agent-hook` event drives the SAME processAgentHook path (bridge transition)', async () => {
    findSessionSpy.mockReturnValue('task-r:task-r')
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    // Envelope shape a computer relays: the raw {ctx,raw,arg} the benign notify.sh
    // POSTed to the computer loopback, forwarded verbatim as the event payload.
    emit({
      computerId: 'computer-a',
      name: 'agent-hook',
      payload: {
        ctx: { v: 1, taskId: 'task-r', agentId: 'claude-code', releaseChannel: 'stable' },
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

    emit({ computerId: 'computer-a', name: 'some-other-event', payload: { hookEvent: 'Stop' } })
    await flush()

    expect(lifecycleSpy).not.toHaveBeenCalled()
    expect(findSessionSpy).not.toHaveBeenCalled()
  })

  test('a malformed/unresolvable payload NEVER throws out of the event loop', async () => {
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    // No identity at all → processAgentHook returns 'bad'; the consumer must
    // swallow it (a thrown error here would destabilize every computer).
    expect(() =>
      emit({ computerId: 'computer-a', name: 'agent-hook', payload: { ctx: { v: 1 } } })
    ).not.toThrow()
    await flush()
    expect(transitionSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })

  test("a relayed warm agent's SessionStart confirms its conversation on the pooled session", async () => {
    unadoptedWarmAgentSpy.mockImplementation((taskId) =>
      taskId === 'reserved-1' ? { sessionId: 'pool-1' } : null
    )
    const { gateway, emit } = makeFakeGateway()
    attachAgentHookRelayConsumer(gateway, makeDeps(), makeBridge())

    emit({
      computerId: 'computer-a',
      name: 'agent-hook',
      payload: {
        ctx: { v: 1, taskId: 'reserved-1', agentId: 'claude-code' },
        raw: { hook_event_name: 'SessionStart', session_id: '55555555-5555-4555-8555-555555555555' }
      }
    })
    await flush()

    expect(confirmSessionConversationSpy.mock.calls[0][1]).toEqual({
      sessionId: 'pool-1',
      observedConversationId: '55555555-5555-4555-8555-555555555555'
    })
    // Not adopted yet: no terminal holds it, so nothing task-scoped runs.
    expect(findSessionSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })
})
