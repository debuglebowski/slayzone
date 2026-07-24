import http from 'node:http'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { createAgentHookServer } from './agent-hook'
import type { RunnerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx() {
  const notifies: Notify[] = []
  const dialer: RunnerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: [tmpdir()],
    capabilities: ['pty']
  }
  return { notifies, ctx: { dialer, config, log: () => {} } }
}

function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method: 'POST',
        path: u.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
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
    req.write(body)
    req.end()
  })
}

describe('createAgentHookServer (runner loopback relay)', () => {
  it('binds a loopback /api/agent-hook URL and relays the raw envelope to the hub as an `event`', async () => {
    const { notifies, ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    try {
      // The bound URL is loopback (127.0.0.1) so the agent env can point at it.
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/agent-hook$/)

      const envelope = {
        ctx: { v: 1, taskId: 'task-1', agentId: 'claude-code', channel: 'stable' },
        raw: { hook_event_name: 'UserPromptSubmit' },
        arg: null,
        agentId: 'claude-code'
      }
      const res = await post(server.url, JSON.stringify(envelope))

      // Fire-and-forget contract: always a fast 200 so the hook never blocks.
      expect(res.status).toBe(200)

      // The runner does NO field extraction — it relays the whole envelope opaquely
      // over its existing ws channel as a generic `event` (name: 'agent-hook').
      const relayed = notifies.find((n) => n.method === 'event')
      expect(relayed).toBeDefined()
      expect(relayed!.params.name).toBe('agent-hook')
      expect(relayed!.params.payload).toEqual(envelope)
    } finally {
      await server.close()
    }
  })

  it('relays even a non-JSON / empty body (never rejects — the hub decides)', async () => {
    const { notifies, ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    try {
      const res = await post(server.url, '')
      expect(res.status).toBe(200)
      // An unparseable body still relays (as a string payload) — the runner is a
      // dumb pipe; the hub's processAgentHook is the single authority that judges.
      expect(notifies.some((n) => n.method === 'event')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('close() stops the listener (subsequent connects fail)', async () => {
    const { ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    const url = server.url
    await server.close()
    await expect(post(url, '{}')).rejects.toBeTruthy()
  })

  it('still answers 200 when the ws relay (dialer.notify) throws (agent never blocks)', async () => {
    // The hook is fire-and-forget: even if the hub link is down / the dialer
    // throws, the loopback POST must return promptly so the agent TUI is never
    // blocked or shown an error. The relay failure is swallowed + logged.
    const logs: string[] = []
    const throwingDialer: RunnerDialer = {
      notify: () => {
        throw new Error('hub socket closed')
      }
    }
    const config: RunnerConfig = {
      hubUrl: 'ws://localhost:0/runners',
      name: 'test',
      allowedRoots: [tmpdir()],
      capabilities: ['pty']
    }
    const server = await createAgentHookServer({
      dialer: throwingDialer,
      config,
      log: (m) => logs.push(m)
    })
    try {
      const res = await post(server.url, JSON.stringify({ ctx: { v: 1 }, raw: null, arg: null }))
      expect(res.status).toBe(200)
      expect(logs.some((l) => l.includes('relay failed'))).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('ignores non-POST and non-hook paths with a fast 404 (no relay)', async () => {
    const { notifies, ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    try {
      const u = new URL(server.url)
      const res = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: u.hostname, port: u.port, method: 'GET', path: '/api/agent-hook' },
          (r) => {
            r.on('data', () => {})
            r.on('end', () => resolve(r.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end()
      })
      expect(res).toBe(404)
      expect(notifies.some((n) => n.method === 'event')).toBe(false)
    } finally {
      await server.close()
    }
  })
})
