import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { setAuthGate, type RestApiDeps, type TerminalStateBridge } from '@slayzone/api'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  attachAgentHookRelayConsumer,
  relayAgentHook,
  type AgentHookRelayGateway
} from './agent-hook-relay-consumer'

// processAgentHook reaches into the task + diagnostics domains (DB writes). Mock
// those exactly as the transport's own agent-hook.test.ts does, so this unit
// stays hermetic and asserts the CONSUMER wiring, not the domains.
// A warm agent the pool still holds (booted with `taskId`, not adopted yet).
const diagnosticSpy = vi.fn()
const unadoptedWarmAgentSpy = vi.fn<(taskId: string) => { sessionId: string } | null>(() => null)
// The claude agent tree is pure, so the real module is used (by path: the barrel
// pulls in the native pty manager) — a hand-rolled fake would drift from its states.
vi.mock('@slayzone/terminal/hub', async () => {
  const agentTree = await import('../../../domains/terminal/src/server/agent-tree.js')
  const lifecycle = await import('../../../domains/terminal/src/server/agent-lifecycle-router.js')
  const pty = await import('../../../domains/terminal/src/server/pty-router.js')
  const chat = await import('../../../domains/terminal/src/server/chat-router.js')
  const usage = await import('../../../domains/terminal/src/server/usage-router.js')
  const usageDeps = await import('../../../domains/terminal/src/server/usage-router-deps.js')
  return {
    agentLifecycleRouter: lifecycle.agentLifecycleRouter,
    ptyRouter: pty.ptyRouter,
    chatRouter: chat.chatRouter,
    appUsageRouter: usage.appUsageRouter,
    setUsageRouterDeps: usageDeps.setUsageRouterDeps,
    isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode),
    applyAgentHook: agentTree.applyAgentHook,
    createAgentTree: agentTree.createAgentTree,
    resolveState: agentTree.resolveState,
    subagentIdOf: agentTree.subagentIdOf,
    CLAUDE_BLOCKING_TOOLS: agentTree.CLAUDE_BLOCKING_TOOLS,
    unadoptedWarmAgent: (taskId: string) => unadoptedWarmAgentSpy(taskId)
  }
})
vi.mock('@slayzone/diagnostics/server', async () => {
  // api's router composes diagnostics' own router and wires its seam; stand-ins keep it importable.
  const { router } = await import('@slayzone/trpc-server')
  return {
    diagnosticsRouter: router({}),
    setDiagnosticsRouterDeps: () => {},
    recordDiagnosticEvent: (e: { event: string }) => diagnosticSpy(e)
  }
})
const confirmSessionConversationSpy = vi.fn()
vi.mock('@slayzone/task/server', async () => {
  // api's router composes task's own routers; empty stand-ins keep it importable.
  const { router } = await import('@slayzone/trpc-server')
  return {
    taskRouter: router({}),
    agentSessionsRouter: router({}),
    templateRouter: router({}),
    taskMovesRouter: router({}),
    // The automation engine builds its not-moving filter from this at load.
    projectMovingSql: (await import('@slayzone/projects/server')).projectMovingSql,
    // api wires `task.startMainAgent`'s repo-discovery seam at load.
    setMainAgentDeps: () => {},
    artifactsDirOf: (dataDir: string) => `${dataDir}/artifacts`,
    // The hook owner check's access scope invalidates on it (access.ts).
    agentSessionsEvents: new (await import('node:events')).EventEmitter()
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
    db: { get: async () => undefined } as never,
    notifyRenderer: () => {},
    // The session ledger on the reporting agent's computer (robustness plan §9).
    agentSessionLedger: {
      computerFor: async (_hook: unknown, reporter?: string | null) => reporter ?? null,
      recordHookConversation: async () => null,
      confirmSessionConversation: (...args: unknown[]) => confirmSessionConversationSpy(...args),
      markSessionFirstTurn: async () => true
    },
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
      taskId === 'reserved-1'
        ? { sessionId: 'pool-1', projectId: 'p', computerId: 'computer-a' }
        : null
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

    // On the computer the warm agent runs on (its pool row is there).
    expect(confirmSessionConversationSpy.mock.calls[0][0]).toBe('computer-a')
    expect(confirmSessionConversationSpy.mock.calls[0][1]).toEqual({
      sessionId: 'pool-1',
      observedConversationId: '55555555-5555-4555-8555-555555555555'
    })
    // Not adopted yet: no terminal holds it, so nothing task-scoped runs.
    expect(findSessionSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })
})

describe('a hook from a warm agent the hub no longer holds (its computer says `fromWarm`)', () => {
  /** The hub's rows: computer-a is u-a's; no task row for the warm agent's pre-minted id. */
  function hubDeps(): RestApiDeps {
    const deps = makeDeps()
    ;(deps as { db: unknown }).db = {
      get: async (sql: string, params: unknown[]) =>
        /FROM computers/.test(sql)
          ? params[0] === 'computer-a'
            ? { owner_user_id: 'u-a' }
            : { owner_user_id: null }
          : undefined,
      all: async () => []
    }
    return deps
  }
  /** Relay one event and wait for it to be fully processed. */
  const relayTo =
    (deps: RestApiDeps, bridge: TerminalStateBridge) =>
    (e: { computerId: string; payload: unknown }) =>
      relayAgentHook(e.computerId, e.payload, deps, bridge)
  const audit: { event: string; detail: { reason: string } }[] = []
  const warmHook = (hookEvent: string, computerId = 'computer-a', extra: object = {}) => ({
    computerId,
    name: 'agent-hook',
    payload: {
      agentId: 'claude-code',
      hookEvent,
      taskId: 'pre-minted',
      sessionId: '55555555-5555-4555-8555-555555555555',
      ctx: { mode: 'claude-code' },
      raw: {},
      ...extra
    }
  })

  beforeEach(() => {
    findSessionSpy.mockReset().mockReturnValue(null)
    transitionSpy.mockReset()
    markActiveSpy.mockReset()
    lifecycleSpy.mockReset()
    diagnosticSpy.mockReset()
    unadoptedWarmAgentSpy.mockReset().mockReturnValue(null)
    confirmSessionConversationSpy.mockReset()
    audit.length = 0
    setSecurityLogSink((line) => audit.push(JSON.parse(line)))
    setAuthGate(() => true)
  })
  afterEach(() => {
    setSecurityLogSink()
    setAuthGate(() => false)
  })

  test('killed: its SessionEnd (after the hub dropped the handle) is dropped quietly', async () => {
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionEnd', 'computer-a', { fromWarm: { warmId: 'warm:1' } }))
    expect(audit.filter((l) => l.event === 'authz.denied')).toEqual([])
    expect(lifecycleSpy).not.toHaveBeenCalled()
    expect(transitionSpy).not.toHaveBeenCalled()
    expect(diagnosticSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_hook.warm_released' })
    )
  })

  test('hub restart (pool empty): a surviving warm agent’s hooks are dropped quietly, nothing confirmed', async () => {
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionStart', 'computer-a', { fromWarm: { warmId: 'warm:old' } }))
    await emit(warmHook('SessionEnd', 'computer-a', { fromWarm: { warmId: 'warm:old' } }))
    expect(audit.filter((l) => l.event === 'authz.denied')).toEqual([])
    expect(confirmSessionConversationSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })

  test('the pool still holds it: its SessionStart still confirms the pooled conversation', async () => {
    unadoptedWarmAgentSpy.mockImplementation((taskId) =>
      taskId === 'pre-minted'
        ? { sessionId: 'pool-1', projectId: 'p', computerId: 'computer-a' }
        : null
    )
    setAuthGate(() => false)
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionStart', 'computer-a', { fromWarm: { warmId: 'warm:1' } }))
    expect(confirmSessionConversationSpy).toHaveBeenCalledTimes(1)
  })

  test('an unowned computer reports for nobody, warm or not', async () => {
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionEnd', 'computer-unowned', { fromWarm: { warmId: 'warm:1' } }))
    expect(audit.map((l) => l.detail.reason)).toEqual(['no_reporter'])
  })

  test('without the computer’s word, a task id with no task row is denied as unknown_task', async () => {
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionEnd'))
    expect(audit.map((l) => l.detail.reason)).toEqual(['unknown_task'])
  })

  test('no login: a dying warm agent never drives the cold agent that took its task id', async () => {
    setAuthGate(() => false)
    // The claim missed: the hub killed the warm agent and cold-spawned under the same id.
    findSessionSpy.mockReturnValue('pre-minted:pre-minted')
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionEnd', 'computer-a', { fromWarm: { warmId: 'warm:1' } }))
    expect(transitionSpy).not.toHaveBeenCalled()
    expect(lifecycleSpy).not.toHaveBeenCalled()
    // The cold agent's own hooks (no claim) still drive it.
    await emit(warmHook('UserPromptSubmit'))
    expect(transitionSpy).toHaveBeenCalledWith(
      'pre-minted:pre-minted',
      'running',
      'UserPromptSubmit'
    )
  })

  test('a malformed claim is ignored (treated as no claim)', async () => {
    const emit = relayTo(hubDeps(), makeBridge())
    await emit(warmHook('SessionEnd', 'computer-a', { fromWarm: { warmId: 42 } }))
    expect(audit.map((l) => l.detail.reason)).toEqual(['unknown_task'])
  })
})

describe('computer restart: a warm hook journaled by the old process, replayed by the new one', () => {
  test('still carries fromWarm and the hub drops it quietly', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createAgentHookServer } = await import('@slayzone/computer/agent-hook-server')
    const { WarmHookOrigins } = await import('@slayzone/computer/warm-hook-origins')
    const { adoptHookJournal, readHookJournal, writeHookJournal } = await import(
      '@slayzone/computer/hook-journal'
    )
    const runtime = mkdtempSync(join(tmpdir(), 'warm-hook-journal-'))
    const hubUrl = 'wss://hub.example/computers'
    try {
      // OLD computer process: its warm agent is killed (host shutdown), and the
      // agent's SessionEnd reaches it while the hub link is down — so it is only
      // journaled (as session-host.ts SessionTransport.notify does).
      const origins = new WarmHookOrigins()
      origins.spawned('warm:1', 'pre-minted')
      origins.ended('warm:1')
      const journal = adoptHookJournal(runtime, hubUrl)
      const queue: { id: string; params: unknown }[] = []
      const server = await createAgentHookServer(
        {
          dialer: {
            notify: (_method: string, params?: unknown) => {
              queue.push({ id: `e${queue.length}`, params })
              writeHookJournal(journal, queue)
              return true
            }
          },
          config: {
            hubUrl,
            name: 'old',
            allowedRoots: [runtime],
            capabilities: ['pty']
          },
          log: () => {}
        } as never,
        undefined,
        (hook) => origins.originOf(hook)
      )
      await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'claude-code',
          ctx: { v: 1, agentId: 'claude-code', taskId: 'pre-minted', warmId: 'warm:1' },
          raw: { hook_event_name: 'SessionEnd', session_id: 's-1' }
        })
      })
      await server.close()

      // NEW computer process: reads the journal and delivers after reconnect.
      const replayed = readHookJournal(runtime, adoptHookJournal(runtime, hubUrl))
      expect(replayed).toHaveLength(1)
      const params = replayed[0]!.params as { name: string; payload: Record<string, unknown> }
      expect(params.payload.fromWarm).toEqual({ warmId: 'warm:1' })

      // The hub (with login, pool empty) receives it.
      findSessionSpy.mockReset().mockReturnValue('pre-minted:pre-minted')
      transitionSpy.mockReset()
      lifecycleSpy.mockReset()
      unadoptedWarmAgentSpy.mockReset().mockReturnValue(null)
      const audit: { event: string }[] = []
      setSecurityLogSink((line) => audit.push(JSON.parse(line)))
      setAuthGate(() => true)
      try {
        const deps = makeDeps()
        ;(deps as { db: unknown }).db = {
          get: async (sql: string) =>
            /FROM computers/.test(sql) ? { owner_user_id: 'u-a' } : undefined,
          all: async () => []
        }
        expect(params.name).toBe('agent-hook')
        expect(await relayAgentHook('computer-a', params.payload, deps, makeBridge())).toBe('ok')
      } finally {
        setSecurityLogSink()
        setAuthGate(() => false)
      }
      expect(audit.filter((l) => l.event === 'authz.denied')).toEqual([])
      expect(lifecycleSpy).not.toHaveBeenCalled()
      expect(transitionSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  })
})
