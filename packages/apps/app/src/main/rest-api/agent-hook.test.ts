import express from 'express'
import http from 'http'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { registerAgentHookRoute } from './agent-hook'

// Replace the actual broadcast helper w/ a spy so we can assert on it
// without touching Electron BrowserWindow APIs.
const broadcastSpy = vi.fn()
vi.mock('../broadcast-to-windows', () => ({
  broadcastToWindows: (...args: unknown[]) => broadcastSpy(...args)
}))

// Mock the terminal-domain entrypoints — pulling in pty-manager would require
// Electron at module load. The handler only needs these named exports here.
const findSessionSpy = vi.fn<(taskId: string, mode: string) => string | null>()
const transitionSpy = vi.fn<(sessionId: string, state: string, event: string) => boolean>()
const markActiveSpy = vi.fn<(sessionId: string) => boolean>()
const noteConversationIdSpy = vi.fn<(sessionId: string, conversationId: string | null) => void>()
const noteAwaitingInputSpy = vi.fn<(sessionId: string, awaiting: boolean) => void>()
vi.mock('@slayzone/terminal/electron', () => ({
  findSessionByTaskIdAndMode: (taskId: string, mode: string) => findSessionSpy(taskId, mode),
  transitionStateFromHook: (sessionId: string, state: string, event: string) =>
    transitionSpy(sessionId, state, event),
  markSessionActiveFromHook: (sessionId: string) => markActiveSpy(sessionId),
  noteSessionConversationId: (sessionId: string, conversationId: string | null) =>
    noteConversationIdSpy(sessionId, conversationId),
  setSessionAwaitingInput: (sessionId: string, awaiting: boolean) =>
    noteAwaitingInputSpy(sessionId, awaiting),
  // Mirror the real registry-derived set (claude-code/codex/antigravity carry
  // hookDriven=true). The route uses this to decide whether hooks drive state;
  // the gemini "broadcast only" test below exercises the false branch.
  isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode)
}))

// Diagnostics call from the handler must not blow up under vitest's lack of
// Electron app — stub it out.
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: () => {}
}))

// The codex conversation-id capture reads via `getTaskOp` and writes via the
// pure `updateTask`. Mock both so the test never pulls the task domain (+
// Electron) into vitest. `getProviderConversationId` (@slayzone/task/shared) is
// a pure helper — left unmocked so the real short-circuit logic is exercised.
const updateTaskSpy = vi.fn()
const getTaskOpSpy = vi.fn<(db: unknown, id: string) => Promise<unknown>>()
vi.mock('@slayzone/task/server', () => ({
  updateTask: (...args: unknown[]) => updateTaskSpy(...args),
  getTaskOp: (db: unknown, id: string) => getTaskOpSpy(db, id)
}))

interface ServerHandle {
  port: number
  close(): Promise<void>
}

function startServer(deps?: { notifyRenderer?: () => void }): Promise<ServerHandle> {
  const app = express()
  registerAgentHookRoute(app, {
    db: {} as never,
    notifyRenderer: deps?.notifyRenderer ?? (() => {})
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
    broadcastSpy.mockClear()
    findSessionSpy.mockReset()
    transitionSpy.mockReset()
    markActiveSpy.mockReset()
    noteConversationIdSpy.mockReset()
    noteAwaitingInputSpy.mockReset()
    updateTaskSpy.mockReset()
    getTaskOpSpy.mockReset()
    findSessionSpy.mockReturnValue(null)
    transitionSpy.mockReturnValue(true)
    markActiveSpy.mockReturnValue(true)
    // Default: task exists with no codex conversation id yet.
    getTaskOpSpy.mockResolvedValue({ provider_config: {} })
  })

  test('valid payload → 200 + broadcasts agent:lifecycle', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        sessionId: 'sess-1',
        taskId: 'task-1'
      })
      expect(res.status).toBe(200)
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
      const [channel, event] = broadcastSpy.mock.calls[0]
      expect(channel).toBe('agent:lifecycle')
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

  test('unknown hookEvent → 204 + no broadcast', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'TotallyUnknown' })
      expect(res.status).toBe(204)
      expect(broadcastSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('invalid payload → 400 + no broadcast', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, { agentId: 'unknown-agent', hookEvent: 'Stop' })
      expect(res.status).toBe(400)
      expect(broadcastSpy).not.toHaveBeenCalled()
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
      expect(findSessionSpy).toHaveBeenCalledWith('task-1', 'claude-code')
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

  test('claude-code PostToolUse(non-blocking) → does NOT touch awaitingInput', async () => {
    // Ordinary mid-turn tool completion must stay a no-op for the awaiting flag
    // (and for state) — only blocking-tool PostToolUse is the resume signal.
    findSessionSpy.mockReturnValue('task-post-bash')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'PostToolUse',
        taskId: 'task-post-bash',
        raw: { tool_name: 'Bash' }
      })
      expect(noteAwaitingInputSpy).not.toHaveBeenCalled()
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
      expect(noteAwaitingInputSpy).not.toHaveBeenCalled()
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

  test('claude-code SessionStart → broadcast + markActive, no state transition (PTY drives its own starting→running)', async () => {
    findSessionSpy.mockReturnValue('task-4')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'task-4'
      })
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
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
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
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

  test('claude-code w/o taskId → broadcast only, no session lookup', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop' })
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
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
      expect(findSessionSpy).toHaveBeenCalledWith('cx-1', 'codex')
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

  test('codex SessionStart with sessionId → persists conversationId to provider_config', async () => {
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        taskId: 'cx-task',
        sessionId: '11111111-1111-4111-8111-111111111111'
      })
      expect(getTaskOpSpy).toHaveBeenCalledWith(expect.anything(), 'cx-task')
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1]
      expect(data).toEqual({
        id: 'cx-task',
        providerConfig: { codex: { conversationId: '11111111-1111-4111-8111-111111111111' } }
      })
      expect(notifyRendererSpy).toHaveBeenCalledTimes(1)
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart with only raw.session_id → still persists (envelope fallback)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        taskId: 'cx-task',
        raw: { session_id: '22222222-2222-4222-8222-222222222222' }
      })
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1] as {
        providerConfig: { codex: { conversationId: string } }
      }
      expect(data.providerConfig.codex.conversationId).toBe(
        '22222222-2222-4222-8222-222222222222'
      )
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart without any session id → no persist', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'SessionStart', taskId: 'cx-task' })
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart where stored id already matches → no write (short-circuit)', async () => {
    getTaskOpSpy.mockResolvedValue({
      provider_config: { codex: { conversationId: '33333333-3333-4333-8333-333333333333' } }
    })
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        taskId: 'cx-task',
        sessionId: '33333333-3333-4333-8333-333333333333'
      })
      expect(getTaskOpSpy).toHaveBeenCalledTimes(1)
      expect(updateTaskSpy).not.toHaveBeenCalled()
      expect(notifyRendererSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('codex SessionStart for a missing task row → no write, no throw (200)', async () => {
    getTaskOpSpy.mockResolvedValue(null)
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'codex',
        hookEvent: 'SessionStart',
        taskId: 'cx-missing',
        sessionId: '44444444-4444-4444-8444-444444444444'
      })
      expect(res.status).toBe(200)
      expect(updateTaskSpy).not.toHaveBeenCalled()
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
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart with sessionId → persists conversationId to provider_config', async () => {
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'cc-task',
        sessionId: '66666666-6666-4666-8666-666666666666'
      })
      expect(getTaskOpSpy).toHaveBeenCalledWith(expect.anything(), 'cc-task')
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1]
      expect(data).toEqual({
        id: 'cc-task',
        providerConfig: { 'claude-code': { conversationId: '66666666-6666-4666-8666-666666666666' } }
      })
      expect(notifyRendererSpy).toHaveBeenCalledTimes(1)
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart with only raw.session_id → still persists (envelope fallback)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'cc-task',
        raw: { session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
      })
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1] as {
        providerConfig: { 'claude-code': { conversationId: string } }
      }
      expect(data.providerConfig['claude-code'].conversationId).toBe(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart without any session id → no persist', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'SessionStart', taskId: 'cc-task' })
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart where stored id already matches → no write (short-circuit)', async () => {
    getTaskOpSpy.mockResolvedValue({
      provider_config: { 'claude-code': { conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }
    })
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'SessionStart',
        taskId: 'cc-task',
        sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
      expect(getTaskOpSpy).toHaveBeenCalledTimes(1)
      expect(updateTaskSpy).not.toHaveBeenCalled()
      expect(notifyRendererSpy).not.toHaveBeenCalled()
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
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  // --- Antigravity conversation-id capture (PreInvocation event, conversationId) ---

  test('antigravity PreInvocation with sessionId → persists conversationId to provider_config', async () => {
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-task',
        sessionId: 'a1111111-1111-4111-8111-111111111111'
      })
      expect(getTaskOpSpy).toHaveBeenCalledWith(expect.anything(), 'ag-task')
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1]
      expect(data).toEqual({
        id: 'ag-task',
        providerConfig: { antigravity: { conversationId: 'a1111111-1111-4111-8111-111111111111' } }
      })
      expect(notifyRendererSpy).toHaveBeenCalledTimes(1)
    } finally {
      await srv.close()
    }
  })

  test('antigravity PreInvocation with only raw.conversationId → still persists (envelope fallback)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-task',
        raw: { conversationId: 'a2222222-2222-4222-8222-222222222222' }
      })
      expect(updateTaskSpy).toHaveBeenCalledTimes(1)
      const data = updateTaskSpy.mock.calls[0][1] as {
        providerConfig: { antigravity: { conversationId: string } }
      }
      expect(data.providerConfig.antigravity.conversationId).toBe(
        'a2222222-2222-4222-8222-222222222222'
      )
    } finally {
      await srv.close()
    }
  })

  test('antigravity PreInvocation without any session id → no persist', async () => {
    findSessionSpy.mockReturnValue('ag-noid')
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-task'
      })
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('antigravity PreInvocation where stored id already matches → no write (short-circuit)', async () => {
    getTaskOpSpy.mockResolvedValue({
      provider_config: { antigravity: { conversationId: 'a3333333-3333-4333-8333-333333333333' } }
    })
    const notifyRendererSpy = vi.fn()
    const srv = await startServer({ notifyRenderer: notifyRendererSpy })
    try {
      await postJson(srv.port, {
        agentId: 'antigravity',
        hookEvent: 'PreInvocation',
        taskId: 'ag-task',
        sessionId: 'a3333333-3333-4333-8333-333333333333'
      })
      expect(getTaskOpSpy).toHaveBeenCalledTimes(1)
      expect(updateTaskSpy).not.toHaveBeenCalled()
      expect(notifyRendererSpy).not.toHaveBeenCalled()
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
      expect(getTaskOpSpy).not.toHaveBeenCalled()
      expect(updateTaskSpy).not.toHaveBeenCalled()
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

  test('gemini → broadcast only, no state-machine drive (still adapter-detected)', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'gemini', hookEvent: 'Stop', taskId: 'gm-1' })
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
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
})
