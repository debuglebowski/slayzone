import express from 'express'
import http from 'http'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { registerAgentHookRoute } from './agent-hook'

// Verifies the seam: POST /api/agent-hook → capturePrompt(...). The capture
// LOGIC (gating by event/mode, extraction, dedupe, ordering) is covered in
// @slayzone/agent-turns prompt-capture.test.ts; here we only assert the route
// forwards the right payload, gated on taskId presence.

const capturePromptSpy = vi.fn()
vi.mock('@slayzone/agent-turns/server', () => ({
  capturePrompt: (...args: unknown[]) => capturePromptSpy(...args)
}))

// Keep the route's other domain imports out of vitest (no Electron / DB / adapter
// registry) — mirror agent-hook.test.ts.
// The warm pool's view of a task id (a warm agent not adopted yet). Default: none.
const unadoptedWarmAgentSpy = vi.fn<(taskId: string) => { sessionId: string } | null>(() => null)
vi.mock('@slayzone/terminal/server', () => ({
  isHookDrivenMode: () => false,
  unadoptedWarmAgent: (taskId: string) => unadoptedWarmAgentSpy(taskId)
}))
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: () => {}
}))
vi.mock('@slayzone/task/server', () => ({
  recordConversation: () => {},
  findPendingSpawn: () => Promise.resolve(null),
  confirmSessionConversation: () => Promise.resolve()
}))

interface ServerHandle {
  port: number
  close(): Promise<void>
}

function startServer(): Promise<ServerHandle> {
  const app = express()
  registerAgentHookRoute(app, {
    db: {} as never,
    notifyRenderer: () => {}
  } as never)
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

function postJson(port: number, body: unknown): Promise<{ status: number }> {
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
        res.on('data', () => {})
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('POST /api/agent-hook → capturePrompt', () => {
  beforeEach(() => {
    capturePromptSpy.mockReset()
    unadoptedWarmAgentSpy.mockReset()
    unadoptedWarmAgentSpy.mockReturnValue(null)
  })

  test('forwards UserPromptSubmit payload to capturePrompt', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-1',
        sessionId: 'cli-9',
        raw: { prompt: 'fix the auth bug' }
      })
      expect(capturePromptSpy).toHaveBeenCalledTimes(1)
      const [, input] = capturePromptSpy.mock.calls[0]
      expect(input).toMatchObject({
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-1',
        sessionId: 'cli-9',
        raw: { prompt: 'fix the auth bug' }
      })
    } finally {
      await srv.close()
    }
  })

  test('does not call capturePrompt when taskId is absent', async () => {
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        raw: { prompt: 'no task' }
      })
      expect(capturePromptSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })

  test('an adopted warm agent captures under its own task id', async () => {
    // It booted with this id, so its hooks name the task directly.
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'adopted-task-7',
        raw: { prompt: 'hello from adopted agent' }
      })
      expect(capturePromptSpy).toHaveBeenCalledTimes(1)
      expect(capturePromptSpy.mock.calls[0][1]).toMatchObject({ taskId: 'adopted-task-7' })
    } finally {
      await srv.close()
    }
  })

  test('an unadopted warm agent captures nothing (no task has its terminal yet)', async () => {
    unadoptedWarmAgentSpy.mockReturnValue({ sessionId: 'pool-1' })
    const srv = await startServer()
    try {
      await postJson(srv.port, {
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'reserved-task-8',
        raw: { prompt: 'nobody typed this' }
      })
      expect(capturePromptSpy).not.toHaveBeenCalled()
    } finally {
      await srv.close()
    }
  })
})
