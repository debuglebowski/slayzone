import express from 'express'
import http from 'http'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { registerAgentHookRoute } from './agent-hook'

// Replace the actual broadcast helper w/ a spy so we can assert on it
// without touching Electron BrowserWindow APIs.
const broadcastSpy = vi.fn()
vi.mock('../broadcast-to-windows', () => ({
  broadcastToWindows: (...args: unknown[]) => broadcastSpy(...args),
}))

// Mock the terminal-domain entrypoints — pulling in pty-manager would require
// Electron at module load. The handler only needs these named exports here.
const findSessionSpy = vi.fn<(taskId: string, mode: string) => string | null>()
const transitionSpy = vi.fn<(sessionId: string, state: string, event: string) => boolean>()
const markActiveSpy = vi.fn<(sessionId: string) => boolean>()
vi.mock('@slayzone/terminal/main', () => ({
  findSessionByTaskIdAndMode: (taskId: string, mode: string) => findSessionSpy(taskId, mode),
  transitionStateFromHook: (sessionId: string, state: string, event: string) =>
    transitionSpy(sessionId, state, event),
  markSessionActiveFromHook: (sessionId: string) => markActiveSpy(sessionId),
}))

// Diagnostics call from the handler must not blow up under vitest's lack of
// Electron app — stub it out.
vi.mock('@slayzone/diagnostics/main', () => ({
  recordDiagnosticEvent: () => {},
}))

interface ServerHandle {
  port: number
  close(): Promise<void>
}

function startServer(): Promise<ServerHandle> {
  const app = express()
  registerAgentHookRoute(app, { db: {} as never, notifyRenderer: () => {} })
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((r) => { server.close(() => r()) }),
      })
    })
  })
}

function postJson(port: number, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/agent-hook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
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
    findSessionSpy.mockReturnValue(null)
    transitionSpy.mockReturnValue(true)
    markActiveSpy.mockReturnValue(true)
  })

  test('valid payload → 200 + broadcasts agent:lifecycle', async () => {
    const srv = await startServer()
    try {
      const res = await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        sessionId: 'sess-1',
        taskId: 'task-1',
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
        taskId: 'task-1',
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'UserPromptSubmit', taskId: 'task-1' })
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Notification', taskId: 'task-3' })
      expect(transitionSpy).toHaveBeenCalledWith('task-3', 'idle', 'Notification')
    } finally {
      await srv.close()
    }
  })

  test('claude-code SessionStart → broadcast + markActive (no state transition; PTY drives its own starting→running)', async () => {
    findSessionSpy.mockReturnValue('task-4')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'SessionStart', taskId: 'task-4' })
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'PreToolUse', taskId: 'task-pre' })
      expect(transitionSpy).toHaveBeenCalledWith('task-pre', 'running', 'PreToolUse')
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'PostToolUse', taskId: 'task-post' })
      expect(broadcastSpy).toHaveBeenCalledTimes(1)
      expect(transitionSpy).not.toHaveBeenCalled()
      expect(markActiveSpy).toHaveBeenCalledWith('task-post')
    } finally {
      await srv.close()
    }
  })

  test('claude-code SubagentStop → markActive only (main agent still working)', async () => {
    findSessionSpy.mockReturnValue('task-sub')
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'SubagentStop', taskId: 'task-sub' })
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'PreCompact', taskId: 'task-pc' })
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'Stop', taskId: 'task-stop-clock' })
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
      await postJson(srv.port, { agentId: 'claude-code', hookEvent: 'SessionEnd', taskId: 'task-se' })
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

  test('non-claude agent (codex) → broadcast only, no state-machine drive', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, { agentId: 'codex', hookEvent: 'task_complete', taskId: 'task-5' })
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
