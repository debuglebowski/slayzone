import express from 'express'
import http from 'http'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { ConversationOrigin } from '@slayzone/task-contracts'
import { registerAgentHookRoute, evictAgentTree } from './agent-hook'

// Lifecycle spy — captures every event the route emits on deps.agentLifecycle
// (the host bridges that emitter to the renderer; legacyBroadcast is unused
// by this route). Receives the event object only.
const lifecycleSpy = vi.fn()

// PTY state-machine bridge — injected via deps.terminalStateBridge (the route
// no longer imports @slayzone/terminal/electron; the host wires the live impl).
const findSessionSpy = vi.fn<(taskId: string, mode: string, tabId?: string) => string | null>()
const transitionSpy = vi.fn<(sessionId: string, state: string, event: string) => boolean>()
const markActiveSpy = vi.fn<(sessionId: string) => boolean>()
const noteConversationIdSpy = vi.fn<(sessionId: string, conversationId: string | null) => void>()
const noteAwaitingInputSpy = vi.fn<(sessionId: string, awaiting: boolean) => void>()
const noteBackgroundJobsSpy = vi.fn<(sessionId: string, count: number) => void>()
const probeBackgroundJobsSpy =
  vi.fn<(sessionId: string, jobs: Array<{ id: string }>) => Promise<string[] | null>>()
// The warm pool's view of a task id: a warm agent that booted with it and has not
// been adopted yet. Defaults to none — every agent is an ordinary one.
const unadoptedWarmAgentSpy = vi.fn<
  (taskId: string) => { sessionId: string; projectId: string; computerId: string } | null
>(() => null)

// isHookDrivenMode comes from the (electron-free) terminal server entry, but
// importing it for real would pull the adapter registry into vitest — mock it.
// Mirror the real registry-derived set (claude-code/codex/antigravity carry
// hookDriven=true). The route uses this to decide whether hooks drive state;
// the gemini "lifecycle only" test below exercises the false branch.
// The `@slayzone/terminal/hub` entry pulls in the node-pty-backed pty manager
// (native module) which vitest can't load, so it is stubbed. The claude agent-tree
// model is PURE (no pty/DB/Electron), so rather than hand-roll a fake — which
// would silently drift from the real state ladder — pull the actual module in by
// path and re-export it. Deep path is deliberate and test-only: it is the one way
// to reach the real implementation without dragging the barrel's native deps in.
vi.mock('@slayzone/terminal/hub', async () => {
  const agentTree = await import('../../../../../domains/terminal/src/server/agent-tree.js')
  return {
    isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode),
    applyAgentHook: agentTree.applyAgentHook,
    createAgentTree: agentTree.createAgentTree,
    resolveState: agentTree.resolveState,
    subagentIdOf: agentTree.subagentIdOf,
    applyBackgroundJobHook: agentTree.applyBackgroundJobHook,
    dropBackgroundJobs: agentTree.dropBackgroundJobs,
    CLAUDE_BLOCKING_TOOLS: agentTree.CLAUDE_BLOCKING_TOOLS,
    unadoptedWarmAgent: (taskId: string) => unadoptedWarmAgentSpy(taskId)
  }
})

// Diagnostics call from the handler must not blow up under vitest's lack of
// Electron app — stub it out.
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: () => {}
}))

// Conversation-id capture: the session ledger lives on the computer running the
// agent (robustness plan §9), so the route only names that computer and forwards
// the SessionStart; the provenance gate itself runs there (chat-runtime
// session-ledger.test). A fake ledger records what the route asked.
type HookArgs = {
  taskId: string
  mode: string
  sessionId: string
  source?: string
  spawnToken?: string
  ctxTabId?: string
}
const recordHookSpy =
  vi.fn<
    (
      computerId: string,
      args: HookArgs
    ) => Promise<{ origin: ConversationOrigin; tabId: string } | null>
  >()
const confirmSessionConversationSpy = vi.fn()
const markSessionFirstTurnSpy =
  vi.fn<(computerId: string, conversationId: string) => Promise<boolean>>()
const computerForSpy =
  vi.fn<
    (
      hook: { taskId: string; mode: string; tabId?: string },
      reporter?: string | null
    ) => Promise<string | null>
  >()
/** What each SessionStart asked the computer's ledger (args only). */
const asked = () => recordHookSpy.mock.calls.map(([, args]) => args)
/** Terminal tabs the hub knows (`validTab`): `${taskId}/${tabId}`. */
const knownTabs = new Set<string>()

interface ServerHandle {
  port: number
  close(): Promise<void>
}

function startServer(deps?: {
  notifyRenderer?: (change?: { taskIds: readonly string[] }) => void
}): Promise<ServerHandle> {
  const app = express()
  registerAgentHookRoute(app, {
    db: {
      get: async (_sql: string, [tabId, taskId]: string[]) =>
        knownTabs.has(`${taskId}/${tabId}`) ? { id: tabId } : undefined
    } as never,
    notifyRenderer: deps?.notifyRenderer ?? (() => {}),
    agentSessionLedger: {
      computerFor: (hook, reporter) => computerForSpy(hook, reporter),
      recordHookConversation: (computerId, args) => recordHookSpy(computerId, args),
      confirmSessionConversation: async (...args: unknown[]) =>
        confirmSessionConversationSpy(...args),
      markSessionFirstTurn: (computerId, id) => markSessionFirstTurnSpy(computerId, id)
    },
    agentLifecycle: {
      emit: (_channel: string, event: unknown) => {
        lifecycleSpy(event)
        return true
      }
    } as never,
    terminalStateBridge: {
      findSession: (taskId, mode, tabId) => findSessionSpy(taskId, mode, tabId),
      transition: (sessionId, state, event) => transitionSpy(sessionId, state, event),
      markActive: (sessionId) => markActiveSpy(sessionId),
      noteConversationId: (sessionId, conversationId) =>
        noteConversationIdSpy(sessionId, conversationId),
      noteAwaitingInput: (sessionId, awaiting) => noteAwaitingInputSpy(sessionId, awaiting),
      noteBackgroundJobs: (sessionId, count) => noteBackgroundJobsSpy(sessionId, count),
      probeBackgroundJobs: (sessionId, jobs) => probeBackgroundJobsSpy(sessionId, [...jobs])
    }
  })
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          })
      })
    })
  })
}

function postJson(port: number, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/agent-hook',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('POST /api/agent-hook', () => {
  beforeEach(() => {
    lifecycleSpy.mockClear()
    findSessionSpy.mockReset()
    transitionSpy.mockReset()
    markActiveSpy.mockReset()
    noteConversationIdSpy.mockReset()
    noteAwaitingInputSpy.mockReset()
    noteBackgroundJobsSpy.mockReset()
    probeBackgroundJobsSpy.mockReset()
    recordHookSpy.mockReset()
    // Default: the computer accepts it, on the hook's tab (else the main tab).
    recordHookSpy.mockImplementation(async (_c, args) => ({
      origin: 'slay-spawned-fresh',
      tabId: args.ctxTabId ?? args.taskId
    }))
    confirmSessionConversationSpy.mockReset()
    unadoptedWarmAgentSpy.mockReset()
    unadoptedWarmAgentSpy.mockReturnValue(null)
    markSessionFirstTurnSpy.mockReset()
    markSessionFirstTurnSpy.mockResolvedValue(true)
    computerForSpy.mockReset()
    computerForSpy.mockResolvedValue('pc')
    knownTabs.clear()
    findSessionSpy.mockReturnValue(null)
    transitionSpy.mockReturnValue(true)
    markActiveSpy.mockReturnValue(true)
  })

  test('valid payload → 200 + emits agent lifecycle event', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        sessionId: 'sess-1',
        taskId: 'task-1'
      })
      expect(res.status).toBe(200)
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      const [event] = lifecycleSpy.mock.calls[0]
      expect(event).toMatchObject({
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        type: 'agent-start',
        sessionId: 'sess-1',
        taskId: 'task-1'
      })
      expect(typeof event.timestamp).toBe('number')
    } finally {
      await srv.close()
    }
  })

  test('turn proof: a turn marks the session resumable, SessionStart does not', async () => {
    const srv = await startServer()
    try {
      // SessionStart is the signal that lied (v158): it fires before the provider
      // has written a byte, so it must never prove a conversation resumable.
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        sessionId: 'proof-a',
        taskId: 'task-1'
      })
      expect(markSessionFirstTurnSpy).not.toHaveBeenCalled()

      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        sessionId: 'proof-b',
        taskId: 'task-1'
      })
      expect(markSessionFirstTurnSpy).toHaveBeenCalledTimes(1)
      // On the computer running the agent (its ledger).
      expect(markSessionFirstTurnSpy.mock.calls[0]).toEqual(['pc', 'proof-b'])

      // Write-once per process: a second turn on the same id issues no further
      // UPDATE. Ids are unique per test because that latch is module-scoped.
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        sessionId: 'proof-b',
        taskId: 'task-1'
      })
      expect(markSessionFirstTurnSpy).toHaveBeenCalledTimes(1)
    } finally {
      await srv.close()
    }
  })

  test('unknown hookEvent → 204 + no lifecycle event', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'TotallyUnknown' })
      expect(res.status).toBe(204)
      expect(lifecycleSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('invalid payload → 400 + no lifecycle event', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { agentId: 'unknown-agent', hookEvent: 'Stop' })
      expect(res.status).toBe(400)
      expect(lifecycleSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('missing hookEvent → 400', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { agentId: 'claude-code' })
      expect(res.status).toBe(400)
    } finally {
      await srv.close()
    }
  })

  test('claude-code agent-start → state machine running', async () => {
    findSessionSpy.mockReturnValue('task-1')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-1'
      })
      expect(findSessionSpy).toHaveBeenCalledWith('task-1', 'claude-code', undefined)
      expect(transitionSpy).toHaveBeenCalledWith('task-1', 'running', 'UserPromptSubmit')
    } finally {
      await srv.close()
    }
  })

  test('claude-code Stop → state machine idle', async () => {
    findSessionSpy.mockReturnValue('task-2')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop', taskId: 'task-2' })
      expect(transitionSpy).toHaveBeenCalledWith('task-2', 'idle', 'Stop')
    } finally {
      await srv.close()
    }
  })

  test('claude-code Notification → state machine idle (permission-request surfaces as idle)', async () => {
    findSessionSpy.mockReturnValue('task-3')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'Notification',
        taskId: 'task-3'
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-3', 'idle', 'Notification')
    } finally {
      await srv.close()
    }
  })

  // --- idle-close (hibernation) "awaiting user" signal -----------------------
  test('claude-code PreToolUse(AskUserQuestion) → awaitingInput true (blocks hibernation)', async () => {
    findSessionSpy.mockReturnValue('task-aq')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-aq',
        raw: { tool_name: 'AskUserQuestion' }
      })
      expect(noteAwaitingInputSpy).toHaveBeenCalledWith('task-aq', true)
    } finally {
      await srv.close()
    }
  })

  describe('claude background jobs (no hook fires when one exits → liveness probe)', () => {
    const bgPost = (taskId: string, id: string) => ({
      agentId: 'claude-code',
      hookEvent: 'PostToolUse',
      taskId,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm dev', run_in_background: true },
        tool_response: { stdout: '', backgroundTaskId: id }
      }
    })

    test('a started job is counted, probed, and cleared once its process is gone', async () => {
      findSessionSpy.mockReturnValue('task-bg')
      probeBackgroundJobsSpy.mockResolvedValueOnce(['job1']).mockResolvedValueOnce([])
      const srv = await startServer()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await postJson(srv.port, bgPost('task-bg', 'job1'))
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg', 1)

        await vi.advanceTimersByTimeAsync(3_000)
        expect(probeBackgroundJobsSpy).toHaveBeenCalledWith('task-bg', [
          { id: 'job1', kind: 'shell', command: 'pnpm dev' }
        ])
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg', 1)

        await vi.advanceTimersByTimeAsync(3_000)
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg', 0)

        // Nothing left to watch → polling stops.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(probeBackgroundJobsSpy).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
        evictAgentTree('task-bg')
        await srv.close()
      }
    })

    test('"can\'t tell" (null) clears every job rather than showing one forever', async () => {
      findSessionSpy.mockReturnValue('task-bg-null')
      probeBackgroundJobsSpy.mockResolvedValue(null)
      const srv = await startServer()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await postJson(srv.port, bgPost('task-bg-null', 'j'))
        await vi.advanceTimersByTimeAsync(3_000)
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg-null', 0)
      } finally {
        vi.useRealTimers()
        evictAgentTree('task-bg-null')
        await srv.close()
      }
    })

    test('a failed probe (lost connection) keeps the job and asks again', async () => {
      findSessionSpy.mockReturnValue('task-bg-err')
      probeBackgroundJobsSpy.mockRejectedValueOnce(new Error('disposed')).mockResolvedValue([])
      const srv = await startServer()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await postJson(srv.port, bgPost('task-bg-err', 'j'))
        await vi.advanceTimersByTimeAsync(3_000)
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg-err', 1)
        await vi.advanceTimersByTimeAsync(3_000)
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg-err', 0)
      } finally {
        vi.useRealTimers()
        evictAgentTree('task-bg-err')
        await srv.close()
      }
    })

    test('TaskStop clears the job at once', async () => {
      findSessionSpy.mockReturnValue('task-bg-stop')
      probeBackgroundJobsSpy.mockResolvedValue(['j'])
      const srv = await startServer()
      try {
        await postJson(srv.port, bgPost('task-bg-stop', 'j'))
        await postJson(srv.port, {
          agentId: 'claude-code',
          hookEvent: 'PostToolUse',
          taskId: 'task-bg-stop',
          raw: {
            tool_name: 'TaskStop',
            tool_input: { task_id: 'j' },
            tool_response: { task_id: 'j' }
          }
        })
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg-stop', 0)
      } finally {
        evictAgentTree('task-bg-stop')
        await srv.close()
      }
    })

    test('SessionEnd resets the published count with the tree', async () => {
      findSessionSpy.mockReturnValue('task-bg-end')
      probeBackgroundJobsSpy.mockResolvedValue(['j'])
      const srv = await startServer()
      try {
        await postJson(srv.port, bgPost('task-bg-end', 'j'))
        await postJson(srv.port, {
          agentId: 'claude-code',
          hookEvent: 'SessionEnd',
          taskId: 'task-bg-end'
        })
        expect(noteBackgroundJobsSpy).toHaveBeenLastCalledWith('task-bg-end', 0)
      } finally {
        await srv.close()
      }
    })

    test('the TerminalState is untouched by a background job', async () => {
      findSessionSpy.mockReturnValue('task-bg-state')
      const srv = await startServer()
      try {
        await postJson(srv.port, bgPost('task-bg-state', 'j'))
        expect(transitionSpy).not.toHaveBeenCalled()
      } finally {
        evictAgentTree('task-bg-state')
        await srv.close()
      }
    })
  })

  test('claude-code Stop → awaitingInput false (completed turn is hibernatable)', async () => {
    findSessionSpy.mockReturnValue('task-stop')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop', taskId: 'task-stop' })
      expect(noteAwaitingInputSpy).toHaveBeenCalledWith('task-stop', false)
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreToolUse(non-blocking) → awaitingInput false', async () => {
    findSessionSpy.mockReturnValue('task-bash')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-bash',
        raw: { tool_name: 'Bash' }
      })
      expect(noteAwaitingInputSpy).toHaveBeenCalledWith('task-bash', false)
    } finally {
      await srv.close()
    }
  })

  test('claude-code PostToolUse(ExitPlanMode) → awaitingInput false (resumed, hibernatable again)', async () => {
    // The accept-resume must clear the awaiting flag PreToolUse set. Otherwise
    // the session would report running+awaiting (contradiction) and the idle-
    // close gate's bookkeeping drifts.
    findSessionSpy.mockReturnValue('task-epm-accept')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-epm-accept',
        raw: { tool_name: 'ExitPlanMode' }
      })
      expect(noteAwaitingInputSpy).toHaveBeenCalledWith('task-epm-accept', false)
    } finally {
      await srv.close()
    }
  })

  test('claude-code PostToolUse(non-blocking) → never latches awaitingInput', async () => {
    // Ordinary mid-turn tool completion must stay a no-op for the awaiting flag
    // (and for state) — only blocking-tool PostToolUse is the resume signal.
    //
    // claude's awaiting flag is now re-asserted from the session's agent tree on
    // every hook (ONE truth, so a background subagent can't report "not blocked"
    // for a main loop parked on a question). So the assertion is on the VALUE, not
    // on call count: this event must never latch `true`.
    findSessionSpy.mockReturnValue('task-post-bash')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-post-bash',
        raw: { tool_name: 'Bash' }
      })
      expect(noteAwaitingInputSpy).not.toHaveBeenCalledWith('task-post-bash', true)
      expect(transitionSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code Notification → does NOT set awaitingInput (idle_prompt stays hibernatable)', async () => {
    findSessionSpy.mockReturnValue('task-notif')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'Notification',
        taskId: 'task-notif'
      })
      // Value, not call count — see the PostToolUse case above. Notification ends
      // the working stretch but must never latch `true`: its dominant subtype is
      // idle_prompt, which is exactly the stale case idle-close SHOULD reap.
      expect(noteAwaitingInputSpy).not.toHaveBeenCalledWith('task-notif', true)
    } finally {
      await srv.close()
    }
  })

  test('codex PermissionRequest → awaitingInput true', async () => {
    findSessionSpy.mockReturnValue('task-perm')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'PermissionRequest',
        taskId: 'task-perm'
      })
      expect(noteAwaitingInputSpy).toHaveBeenCalledWith('task-perm', true)
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart → lifecycle + markActive, no state transition (PTY drives its own starting→running)', async () => {
    findSessionSpy.mockReturnValue('task-4')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'task-4'
      })
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('task-4')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreToolUse → running (mid-turn tool starting)', async () => {
    findSessionSpy.mockReturnValue('task-pre')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-pre'
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-pre', 'running', 'PreToolUse')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreToolUse AskUserQuestion → idle (blocking tool, agent paused for user)', async () => {
    // Claude Code does NOT fire Notification for AskUserQuestion — without
    // this branch the session would pin on 'running' until 5min silence-timer.
    findSessionSpy.mockReturnValue('task-aq')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-aq',
        raw: { tool_name: 'AskUserQuestion' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-aq', 'idle', 'PreToolUse')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreToolUse ExitPlanMode → idle (plan approval blocks)', async () => {
    findSessionSpy.mockReturnValue('task-epm')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-epm',
        raw: { tool_name: 'ExitPlanMode' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-epm', 'idle', 'PreToolUse')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreToolUse Bash → running (non-blocking tool, unchanged)', async () => {
    findSessionSpy.mockReturnValue('task-bash')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-bash',
        raw: { tool_name: 'Bash' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-bash', 'running', 'PreToolUse')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PostToolUse → markActive only, NO state transition (prevents sidebar flicker)', async () => {
    // Regression: agent-event-handler maps PostToolUse → 'agent-stop' which
    // would flip the session 'idle' between every tool. Keep state 'running'
    // until Stop fires at the actual turn boundary. Still refresh the
    // silence-timer clock since the agent just emitted a hook → it's alive.
    findSessionSpy.mockReturnValue('task-post')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-post'
      })
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('task-post')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PostToolUse(ExitPlanMode) → running (plan accepted, agent resumed)', async () => {
    // The symmetric partner to "PreToolUse ExitPlanMode → idle". PreToolUse
    // parked the session on 'idle' (agent blocked on the plan dialog). When the
    // user ACCEPTS, Claude runs the tool to completion and fires PostToolUse —
    // the ONLY hook between accept and the agent's first real tool call (which
    // can be minutes of thinking/writing away). Without this the spinner stays
    // dark through that whole gap. Reject never reaches here (denied PreToolUse
    // fires no PostToolUse), so PostToolUse(blocking) ⟺ accepted ⟹ running.
    findSessionSpy.mockReturnValue('task-epm-accept')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-epm-accept',
        raw: { tool_name: 'ExitPlanMode' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-epm-accept', 'running', 'PostToolUse')
      expect(markActiveSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code PostToolUse(AskUserQuestion) → running (answered, agent resumed)', async () => {
    // Same shape as ExitPlanMode: PreToolUse parked on 'idle', the user's answer
    // completes the tool → PostToolUse → resume → 'running'.
    findSessionSpy.mockReturnValue('task-aq-answered')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-aq-answered',
        raw: { tool_name: 'AskUserQuestion' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-aq-answered', 'running', 'PostToolUse')
    } finally {
      await srv.close()
    }
  })

  test('claude-code SubagentStop → markActive only (main agent still working)', async () => {
    findSessionSpy.mockReturnValue('task-sub')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SubagentStop',
        taskId: 'task-sub'
      })
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('task-sub')
    } finally {
      await srv.close()
    }
  })

  test('claude-code PreCompact → markActive only (continuation event)', async () => {
    findSessionSpy.mockReturnValue('task-pc')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreCompact',
        taskId: 'task-pc'
      })
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('task-pc')
    } finally {
      await srv.close()
    }
  })

  test('claude-code Stop → transition only, markActive NOT called (transition path refreshes clock itself)', async () => {
    findSessionSpy.mockReturnValue('task-stop-clock')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'Stop',
        taskId: 'task-stop-clock'
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-stop-clock', 'idle', 'Stop')
      expect(markActiveSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionEnd → idle', async () => {
    findSessionSpy.mockReturnValue('task-se')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionEnd',
        taskId: 'task-se'
      })
      expect(transitionSpy).toHaveBeenCalledWith('task-se', 'idle', 'SessionEnd')
    } finally {
      await srv.close()
    }
  })

  test('evictAgentTree drops a stale subagent so the NEXT session on the same id does not inherit its stuck background state', async () => {
    findSessionSpy.mockReturnValue('task-evict')
    const srv = await startServer()
    try {
      // Main loop starts, a background subagent starts, main loop ends first —
      // subagent's SubagentStop never arrives (the bug: e.g. the pty was killed
      // mid-subagent-run rather than exiting cleanly).
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-evict'
      })
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PreToolUse',
        taskId: 'task-evict',
        raw: { agent_id: 'sub-orphan', tool_name: 'Bash' }
      })
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'Stop',
        taskId: 'task-evict'
      })
      expect(transitionSpy).toHaveBeenLastCalledWith('task-evict', 'background', 'Stop')

      // Without eviction, a brand-new turn on the SAME session id would still
      // resolve to 'background' on its own Stop — the orphaned 'sub-orphan' id
      // never left the tree. Simulate the pty-exit funnel calling it directly
      // (composition.ts wires `ptyEvents.on('exit', evictAgentTree)` for this).
      evictAgentTree('task-evict')

      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-evict'
      })
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'Stop',
        taskId: 'task-evict'
      })
      expect(transitionSpy).toHaveBeenLastCalledWith('task-evict', 'idle', 'Stop')
    } finally {
      await srv.close()
    }
  })

  test('claude-code w/o taskId → lifecycle only, no session lookup', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop' })
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(findSessionSpy).not.toHaveBeenCalled()
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex UserPromptSubmit → state machine running (looked up by codex mode)', async () => {
    findSessionSpy.mockReturnValue('cx-1')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'UserPromptSubmit',
        taskId: 'cx-1'
      })
      expect(findSessionSpy).toHaveBeenCalledWith('cx-1', 'codex', undefined)
      expect(transitionSpy).toHaveBeenCalledWith('cx-1', 'running', 'UserPromptSubmit')
    } finally {
      await srv.close()
    }
  })

  test('codex Stop → state machine idle', async () => {
    findSessionSpy.mockReturnValue('cx-2')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'Stop', taskId: 'cx-2' })
      expect(transitionSpy).toHaveBeenCalledWith('cx-2', 'idle', 'Stop')
    } finally {
      await srv.close()
    }
  })

  test('codex PermissionRequest → idle (paused for user approval)', async () => {
    findSessionSpy.mockReturnValue('cx-3')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'PermissionRequest',
        taskId: 'cx-3'
      })
      expect(transitionSpy).toHaveBeenCalledWith('cx-3', 'idle', 'PermissionRequest')
    } finally {
      await srv.close()
    }
  })

  test('codex PreToolUse → running (no blocking-tool allowlist; approvals are PermissionRequest)', async () => {
    findSessionSpy.mockReturnValue('cx-4')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'PreToolUse',
        taskId: 'cx-4',
        raw: { tool_name: 'shell' }
      })
      expect(transitionSpy).toHaveBeenCalledWith('cx-4', 'running', 'PreToolUse')
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart / PostToolUse → markActive only, no transition', async () => {
    findSessionSpy.mockReturnValue('cx-5')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'SessionStart', taskId: 'cx-5' })
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'PostToolUse', taskId: 'cx-5' })
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('cx-5')
      expect(markActiveSpy).toHaveBeenCalledTimes(2)
    } finally {
      await srv.close()
    }
  })

  // --- Codex conversation-id capture (PRIMARY codex resume-id path) ---------

  // --- Warm agents ---------------------------------------------------------
  // A warm agent boots with the id of a task that is created later, if ever. Until
  // a terminal adopts it, its hooks name a task with no terminal (and maybe no row),
  // so the route treats them as pool hooks: the conversation is confirmed on the
  // agent's pooled session, and nothing task-scoped runs.

  const WARM = { sessionId: 'pool-sess-1', projectId: 'p1', computerId: 'computer-1' }

  test('unadopted warm agent SessionStart → confirms its conversation on the pooled session', async () => {
    unadoptedWarmAgentSpy.mockImplementation((taskId) => (taskId === 'reserved-1' ? WARM : null))
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'reserved-1',
        sessionId: '33333333-3333-4333-8333-333333333333'
      })
      expect(confirmSessionConversationSpy).toHaveBeenCalledTimes(1)
      // On the computer the warm agent runs on (its pool row is there).
      expect(confirmSessionConversationSpy.mock.calls[0][0]).toBe('computer-1')
      expect(confirmSessionConversationSpy.mock.calls[0][1]).toEqual({
        sessionId: 'pool-sess-1',
        observedConversationId: '33333333-3333-4333-8333-333333333333'
      })
      // The task-keyed ledger is NOT written: the task may not exist, and the
      // adoption bind is what hands this conversation to it.
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('unadopted warm agent: no lifecycle event, no state machine (no terminal holds it yet)', async () => {
    unadoptedWarmAgentSpy.mockReturnValue(WARM)
    findSessionSpy.mockReturnValue('reserved-1:reserved-1')
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'reserved-1'
      })
      expect(res.status).toBe(200)
      expect(lifecycleSpy).not.toHaveBeenCalled()
      expect(findSessionSpy).not.toHaveBeenCalled()
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).not.toHaveBeenCalled()
      expect(confirmSessionConversationSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('adopted warm agent: its task id drives the state machine like any agent', async () => {
    // Once adopted the pool no longer knows it — the hooks are its task's.
    findSessionSpy.mockReturnValue('adopted-1:adopted-1')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'adopted-1'
      })
      expect(unadoptedWarmAgentSpy).toHaveBeenCalledWith('adopted-1')
      expect(transitionSpy).toHaveBeenCalledWith(
        'adopted-1:adopted-1',
        'running',
        'UserPromptSubmit'
      )
      expect(lifecycleSpy.mock.calls[0][0]).toMatchObject({ taskId: 'adopted-1' })
    } finally {
      await srv.close()
    }
  })

  test('a slaySessionId from an agent booted by an older build is ignored', async () => {
    // Agents booted before warm agents carried a task id had only a session id.
    // There is no session → task lookup any more; such a hook names no task.
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        slaySessionId: 'pool-sess-legacy'
      })
      expect(res.status).toBe(200)
      expect(findSessionSpy).not.toHaveBeenCalled()
      expect(transitionSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart without any session id → no persist', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'SessionStart', taskId: 'cx-task' })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart with sessionId but no taskId → no persist', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        sessionId: '55555555-5555-4555-8555-555555555555'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart without any session id → no persist', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'cc-task'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex Stop with sessionId → no persist (SessionStart-only capture)', async () => {
    findSessionSpy.mockReturnValue('cx-stop')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'Stop',
        taskId: 'cx-task',
        sessionId: '77777777-7777-4777-8777-777777777777'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  // --- Antigravity conversation-id capture (PreInvocation event, conversationId) ---

  test('antigravity PreInvocation without any session id → no persist', async () => {
    findSessionSpy.mockReturnValue('ag-noid')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-task'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('antigravity Stop with sessionId → no persist (PreInvocation-only capture)', async () => {
    findSessionSpy.mockReturnValue('ag-stop')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'Stop',
        taskId: 'ag-task',
        sessionId: 'a4444444-4444-4444-8444-444444444444'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('antigravity PreInvocation → transition running', async () => {
    findSessionSpy.mockReturnValue('ag-run')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-run'
      })
      expect(transitionSpy).toHaveBeenCalledWith('ag-run', 'running', 'PreInvocation')
    } finally {
      await srv.close()
    }
  })

  test('antigravity Stop → transition idle', async () => {
    findSessionSpy.mockReturnValue('ag-idle')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'Stop',
        taskId: 'ag-idle'
      })
      expect(transitionSpy).toHaveBeenCalledWith('ag-idle', 'idle', 'Stop')
    } finally {
      await srv.close()
    }
  })

  test('antigravity PostToolUse → markActive only, no transition', async () => {
    findSessionSpy.mockReturnValue('ag-mid')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PostToolUse',
        taskId: 'ag-mid'
      })
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('ag-mid')
    } finally {
      await srv.close()
    }
  })

  test('gemini → lifecycle only, no state-machine drive (still adapter-detected)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'gemini', hookEvent: 'Stop', taskId: 'gm-1' })
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(findSessionSpy).not.toHaveBeenCalled()
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code event but no matching session → no transition or markActive', async () => {
    findSessionSpy.mockReturnValue(null)
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop', taskId: 'task-6' })
      expect(findSessionSpy).toHaveBeenCalledTimes(1)
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  // ── NEW benign-forwarder envelope: `{ ctx, raw, arg }` ─────────────────────
  // The v2 notify.sh forwards three OPAQUE channels; the server does all field
  // extraction (resolveHookIdentity). These pin that the new envelope resolves
  // every identity path AND that the OLD flat envelope (above) still works.

  test('ctx envelope: taskId + agentId resolved from the opaque ctx blob', async () => {
    findSessionSpy.mockReturnValue('ctx-task')
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        ctx: { v: 1, taskId: 'ctx-task', agentId: 'claude-code', channel: 'dev' },
        raw: { hook_event_name: 'UserPromptSubmit' },
        arg: null
      })
      expect(res.status).toBe(200)
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(lifecycleSpy.mock.calls[0][0]).toMatchObject({
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'ctx-task'
      })
      expect(transitionSpy).toHaveBeenCalledWith('ctx-task', 'running', 'UserPromptSubmit')
    } finally {
      await srv.close()
    }
  })

  test("ctx envelope: a warm agent's reserved taskId routes its SessionStart to the pool", async () => {
    unadoptedWarmAgentSpy.mockImplementation((taskId) =>
      taskId === 'reserved-ctx'
        ? { sessionId: 'pool-ctx-1', projectId: 'p1', computerId: 'c1' }
        : null
    )
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        ctx: { v: 1, taskId: 'reserved-ctx', projectId: 'p1', agentId: 'claude-code' },
        raw: { hook_event_name: 'SessionStart', session_id: '44444444-4444-4444-8444-444444444444' }
      })
      expect(confirmSessionConversationSpy.mock.calls[0][1]).toEqual({
        sessionId: 'pool-ctx-1',
        observedConversationId: '44444444-4444-4444-8444-444444444444'
      })
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('antigravity: event NAME arrives via `arg` (payload omits it)', async () => {
    // Antigravity's installer appends the event name as argv $1; its stdin
    // payload has no hook_event_name. The dumb forwarder ships `arg` opaquely
    // and the server treats a non-JSON arg as the event name.
    findSessionSpy.mockReturnValue('ag-arg')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        ctx: { v: 1, taskId: 'ag-arg', agentId: 'antigravity' },
        raw: { conversationId: 'c1' },
        arg: 'PreInvocation'
      })
      expect(transitionSpy).toHaveBeenCalledWith('ag-arg', 'running', 'PreInvocation')
    } finally {
      await srv.close()
    }
  })

  test('opencode plugin: `arg` carries the whole JSON payload (no stdin raw)', async () => {
    // The OpenCode plugin shells `bash notify.sh '<json>'`, so the payload is on
    // argv $1 and stdin is empty (raw:null). The server parses the JSON arg and
    // derives hook_event_name from it.
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        ctx: { v: 1, taskId: 'oc-task', agentId: 'opencode' },
        raw: null,
        arg: JSON.stringify({ hook_event_name: 'Stop' })
      })
      expect(res.status).toBe(200)
      // opencode is not hook-driven for state, but the lifecycle event still fires.
      expect(lifecycleSpy).toHaveBeenCalledTimes(1)
      expect(lifecycleSpy.mock.calls[0][0]).toMatchObject({
        agentId: 'opencode',
        hookEvent: 'Stop',
        taskId: 'oc-task'
      })
    } finally {
      await srv.close()
    }
  })

  // ── User-defined provider: `ctx.mode` ≠ `agentId` ─────────────────────────
  // A provider wrapping claude-code posts as agent `claude-code` (the only value
  // `isAgentId` accepts) and names its OWN mode in `ctx.mode`. Every lookup keyed
  // by mode — the ledger and the PTY registry — must use that mode, or the
  // provider's conversation lands on the built-in claude-code row of the task.

  test('ctx.mode: a turn drives the provider PTY state machine', async () => {
    findSessionSpy.mockImplementation((_taskId, mode) => (mode === 'my-claude' ? 'pty-mc' : null))
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        ctx: { v: 1, taskId: 'cp-turn', agentId: 'claude-code', mode: 'my-claude' },
        raw: { hook_event_name: 'UserPromptSubmit', session_id: 'ee-turn' },
        agentId: 'claude-code'
      })
      expect(transitionSpy).toHaveBeenCalledWith('pty-mc', 'running', 'UserPromptSubmit')
    } finally {
      await srv.close()
    }
  })

  // --- Conversation-id capture → the agent's computer ledger -------------------

  test('a capture event asks the computer running the agent; the gate runs there', async () => {
    const srv = await startServer()
    try {
      for (const [agentId, hookEvent] of [
        ['codex', 'SessionStart'],
        ['claude-code', 'SessionStart'],
        ['antigravity', 'PreInvocation']
      ]) {
        await postJson(srv.port, {
          agentId,
          hookEvent,
          taskId: `${agentId}-task`,
          sessionId: '11111111-1111-4111-8111-111111111111'
        })
      }
      expect(recordHookSpy.mock.calls.map(([computerId]) => computerId)).toEqual(['pc', 'pc', 'pc'])
      expect(asked()).toEqual([
        { taskId: 'codex-task', mode: 'codex', sessionId: '11111111-1111-4111-8111-111111111111' },
        {
          taskId: 'claude-code-task',
          mode: 'claude-code',
          sessionId: '11111111-1111-4111-8111-111111111111'
        },
        {
          taskId: 'antigravity-task',
          mode: 'antigravity',
          sessionId: '11111111-1111-4111-8111-111111111111'
        }
      ])
      // The hub's board row holds no session id: nothing task-row-scoped is pinged
      // (the sessions list refreshes from the ledger's change event).
    } finally {
      await srv.close()
    }
  })

  test('the session id comes from the envelope fallbacks (raw.session_id, raw.conversationId, ctx)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        taskId: 'cx',
        raw: { session_id: 'a-raw' }
      })
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'cc',
        raw: { session_id: 'b-raw' }
      })
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag',
        raw: { conversationId: 'c-raw' }
      })
      await postJson(srv.port, {
        ctx: { v: 1, taskId: 'cx-ctx', agentId: 'codex' },
        raw: { hook_event_name: 'SessionStart', session_id: 'd-ctx' }
      })
      expect(asked().map((a) => [a.taskId, a.sessionId])).toEqual([
        ['cx', 'a-raw'],
        ['cc', 'b-raw'],
        ['ag', 'c-raw'],
        ['cx-ctx', 'd-ctx']
      ])
    } finally {
      await srv.close()
    }
  })

  test('source, launch token and the hook tab (only a real tab of the task) reach the computer', async () => {
    knownTabs.add('cc-tabs/deploy')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        ctx: {
          agentId: 'claude-code',
          taskId: 'cc-tabs',
          spawnToken: 'tok-deploy',
          tabId: 'deploy'
        },
        raw: { session_id: 'dep-conv', hook_event_name: 'SessionStart', source: 'clear' }
      })
      // An agent-supplied tab that is not one of the task's is dropped.
      await postJson(srv.port, {
        agentId: 'claude-code',
        ctx: { agentId: 'claude-code', taskId: 'cc-tabs', tabId: 'other-task-tab' },
        raw: { session_id: 'x-conv', hook_event_name: 'SessionStart' }
      })
      expect(asked()).toEqual([
        {
          taskId: 'cc-tabs',
          mode: 'claude-code',
          sessionId: 'dep-conv',
          source: 'clear',
          spawnToken: 'tok-deploy',
          ctxTabId: 'deploy'
        },
        { taskId: 'cc-tabs', mode: 'claude-code', sessionId: 'x-conv' }
      ])
    } finally {
      await srv.close()
    }
  })

  test("the conversation id lands on the PTY of the tab the computer's ledger names", async () => {
    // The spawn row names the tab (the launch token picked it), not the hook's ctx.
    recordHookSpy.mockResolvedValue({ origin: 'slay-spawned-fresh', tabId: 'deploy' })
    findSessionSpy.mockImplementation((t, _m, tabId) => (tabId ? `${t}:${tabId}` : null))
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        ctx: { agentId: 'claude-code', taskId: 'cc-tabs', spawnToken: 'tok-deploy' },
        raw: { session_id: 'dep-conv', hook_event_name: 'SessionStart', source: 'startup' }
      })
      expect(noteConversationIdSpy).toHaveBeenCalledWith('cc-tabs:deploy', 'dep-conv')
    } finally {
      await srv.close()
    }
  })

  test('the computer is named by the reporter, the live terminal or the task; none → nothing recorded', async () => {
    computerForSpy.mockResolvedValue(null)
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'no-computer',
        sessionId: 'lost'
      })
      expect(computerForSpy).toHaveBeenCalledWith(
        { taskId: 'no-computer', mode: 'claude-code' },
        null
      )
      expect(recordHookSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('a ledger that cannot be reached never fails the hook ack', async () => {
    recordHookSpy.mockRejectedValue(new Error('Computer is offline'))
    findSessionSpy.mockReturnValue('pty-1')
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'offline',
        sessionId: 'id-1'
      })
      expect(res.status).toBe(200)
      expect(markActiveSpy).toHaveBeenCalledWith('pty-1')
    } finally {
      await srv.close()
    }
  })

  // A provider wrapping claude-code posts as agent `claude-code` (the only value
  // `isAgentId` accepts) and names its OWN mode in `ctx.mode`. Every lookup keyed
  // by mode — the ledger and the PTY registry — must use that mode, or the
  // provider's conversation lands on the built-in claude-code row of the task.
  test('ctx.mode: SessionStart is recorded under the provider mode, not the agent', async () => {
    findSessionSpy.mockReturnValue('pty-my-claude')
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        ctx: { v: 1, taskId: 'cp-task', agentId: 'claude-code', mode: 'my-claude' },
        raw: { hook_event_name: 'SessionStart', session_id: 'dddd', source: 'clear' },
        agentId: 'claude-code'
      })
      expect(res.status).toBe(200)
      expect(asked()).toEqual([
        { taskId: 'cp-task', mode: 'my-claude', sessionId: 'dddd', source: 'clear' }
      ])
      expect(computerForSpy.mock.calls[0][0]).toEqual({ taskId: 'cp-task', mode: 'my-claude' })
      // Both PTY lookups (idle-close conversation mirror + state machine).
      expect(findSessionSpy.mock.calls.every(([, mode]) => mode === 'my-claude')).toBe(true)
      expect(findSessionSpy).toHaveBeenCalledTimes(2)
      expect(noteConversationIdSpy).toHaveBeenCalledWith('pty-my-claude', 'dddd')
      // Agent-scoped decisions still read the AGENT.
      expect(lifecycleSpy.mock.calls[0][0]).toMatchObject({ agentId: 'claude-code' })
    } finally {
      await srv.close()
    }
  })

  test('envelope with no usable identity (no agent, no event) → 400', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { ctx: { v: 1 }, raw: null, arg: null })
      expect(res.status).toBe(400)
      expect(lifecycleSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })
})
