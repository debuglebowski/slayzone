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
  beforeEach(() => broadcastSpy.mockClear())

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
})
