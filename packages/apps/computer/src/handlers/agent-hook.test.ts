import http from 'node:http'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createAgentHookServer } from './agent-hook'
import type { ComputerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx() {
  const notifies: Notify[] = []
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
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

describe('createAgentHookServer (computer loopback relay)', () => {
  it('binds a loopback /api/agent-hook URL and captures locally and relays sanitized lifecycle facts', async () => {
    const { notifies, ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    try {
      // The bound URL is loopback (127.0.0.1) so the agent env can point at it.
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/agent-hook$/)

      const envelope = {
        ctx: { v: 1, taskId: 'task-1', agentId: 'claude-code', releaseChannel: 'stable' },
        raw: { hook_event_name: 'UserPromptSubmit', prompt: 'private prompt marker' },
        arg: null,
        agentId: 'claude-code'
      }
      const res = await post(server.url, JSON.stringify(envelope))

      // Fire-and-forget contract: always a fast 200 so the hook never blocks.
      expect(res.status).toBe(200)

      // Lifecycle facts preserve the hook state machine; prompt text stays local.
      const relayed = notifies.find((n) => n.method === 'event')
      expect(relayed).toBeDefined()
      expect(relayed!.params.name).toBe('agent-hook')
      expect(relayed!.params.payload).toMatchObject({
        agentId: 'claude-code',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task-1'
      })
      expect(JSON.stringify(relayed)).not.toContain('private prompt marker')
    } finally {
      await server.close()
    }
  })

  it('acknowledges empty hooks without relaying arbitrary bodies', async () => {
    const { notifies, ctx } = makeCtx()
    const server = await createAgentHookServer(ctx)
    try {
      const res = await post(server.url, '')
      expect(res.status).toBe(200)
      // Malformed bodies have no lifecycle facts to forward.
      expect(notifies.some((n) => n.method === 'event')).toBe(false)
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
    const throwingDialer: ComputerDialer = {
      notify: () => {
        throw new Error('hub socket closed')
      }
    }
    const config: ComputerConfig = {
      hubUrl: 'ws://localhost:0/computers',
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
      const res = await post(
        server.url,
        JSON.stringify({ agentId: 'claude-code', taskId: 'task', hookEvent: 'Stop' })
      )
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
