import { afterEach, describe, expect, test, vi } from 'vitest'
import { createHttpTunnelServer } from '@slayzone/computer-transport/server'
import { createComputerCliRelay } from './cli-relay'
import { createPtyHandlers } from './handlers/pty'
import { createProcHandlers } from './handlers/proc'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('computer CLI relay', () => {
  test('tunnel handles are bound to a computer and chunks are bounded', async () => {
    const hub = createHttpTunnelServer((_id, _req, res) => res.end('{}'))
    cleanup.push(() => hub.close())
    const { id } = (await hub.request('alice-computer', 'cli.v1.open')) as { id: string }
    await expect(hub.request('bob-computer', 'cli.v1.read', { id })).rejects.toThrow('closed')
    await expect(
      hub.request('alice-computer', 'cli.v1.write', { id, data: 'a'.repeat(50_000) })
    ).rejects.toThrow()
    await hub.request('alice-computer', 'cli.v1.close', { id })
    await expect(hub.request('alice-computer', 'cli.v1.read', { id })).rejects.toThrow('closed')
  })

  test.each(['pty', 'proc'] as const)(
    '%s spawn installs capability and exit revokes it',
    async (kind) => {
      const hub = createHttpTunnelServer((_id, _req, res) => res.end('{}'))
      cleanup.push(() => hub.close())
      const relay = await createComputerCliRelay({ request: (m, p) => hub.request('c', m, p) })
      cleanup.push(() => relay.close())
      const issued = vi.spyOn(relay, 'issue')
      let output = ''
      const ctx = {
        cliRelay: relay,
        dialer: {
          notify: (_method: string, params?: unknown) => {
            const data = (params as { data?: string })?.data
            if (data) output += data
            return true
          }
        },
        config: {
          hubUrl: 'ws://localhost/computers',
          name: 'test',
          allowedRoots: [process.cwd()],
          capabilities: [kind]
        },
        log: () => {}
      }
      const handlers = kind === 'pty' ? createPtyHandlers(ctx) : createProcHandlers(ctx)
      cleanup.push(() => handlers.disposeAll())
      await handlers.handlers[`${kind}.spawn`]({
        sessionId: 'relay-session',
        command: '/bin/sh',
        cwd: process.cwd(),
        args: [
          '-c',
          'test -n "$SLAYZONE_CLI_RELAY_TOKEN" && test -n "$SLAYZONE_CLI_RELAY_ADDRESS" && echo relay-ready; read line'
        ]
      })
      await expect.poll(() => output, { timeout: 5000 }).toContain('relay-ready')
      const capability = issued.mock.results[0].value
      const headers = { authorization: `Bearer ${capability.token}` }
      expect((await fetch(`${relay.url}/api/tasks`, { headers })).status).toBe(200)
      await handlers.handlers[`${kind}.list`]({})
      expect((await fetch(`${relay.url}/api/tasks`, { headers })).status).toBe(200)
      await handlers.handlers[`${kind}.kill`]({ sessionId: 'relay-session' })
      await expect
        .poll(async () => (await fetch(`${relay.url}/api/tasks`, { headers })).status)
        .toBe(401)
    }
  )

  test('authenticates locally, streams binary through the hub, and revokes a session', async () => {
    const seen: string[] = []
    const hub = createHttpTunnelServer((computerId, req, res) => {
      seen.push(computerId)
      expect(req.headers.authorization).toBeUndefined()
      res.writeHead(201, { 'content-type': 'application/octet-stream' })
      req.pipe(res)
    })
    cleanup.push(() => hub.close())
    const relay = await createComputerCliRelay({
      request: (method, params) => hub.request('computer-a', method, params)
    })
    cleanup.push(() => relay.close())
    const session = relay.issue()
    const body = Buffer.alloc(200_000)
    for (let i = 0; i < body.length; i++) body[i] = i % 256
    const denied = await fetch(`${relay.url}/api/tasks`)
    expect(denied.status).toBe(401)
    expect(seen).toEqual([])
    const response = await fetch(`${relay.url}/api/artifacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body
    })
    expect(response.status).toBe(201)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body)
    expect(seen).toEqual(['computer-a'])
    session.revoke()
    expect(
      (
        await fetch(`${relay.url}/api/tasks`, {
          headers: { authorization: `Bearer ${session.token}` }
        })
      ).status
    ).toBe(401)
  })

  test('preserves streaming responses and cancellation', async () => {
    let cancelled!: () => void
    const closed = new Promise<void>((resolve) => {
      cancelled = resolve
    })
    const hub = createHttpTunnelServer((_computerId, req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      req.on('close', cancelled)
    })
    cleanup.push(() => hub.close())
    const relay = await createComputerCliRelay({ request: (m, p) => hub.request('c', m, p) })
    cleanup.push(() => relay.close())
    const session = relay.issue()
    const controller = new AbortController()
    const response = await fetch(`${relay.url}/api/tasks/events`, {
      headers: { authorization: `Bearer ${session.token}` },
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
    controller.abort()
    await closed
  })

  test.each([401, 403, 413])('preserves early HTTP %s during a large upload', async (status) => {
    const hub = createHttpTunnelServer((_id, _req, res) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        connection: 'close, x-private',
        'x-private': 'hub-only',
        'x-error-code': 'refused'
      })
      res.end(JSON.stringify({ error: 'Upload refused' }))
    })
    cleanup.push(() => hub.close())
    const relay = await createComputerCliRelay({ request: (m, p) => hub.request('c', m, p) })
    cleanup.push(() => relay.close())
    const capability = relay.issue()
    const response = await fetch(`${relay.url}/api/artifacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${capability.token}` },
      body: Buffer.alloc(2 * 1024 * 1024),
      signal: AbortSignal.timeout(5000)
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: 'Upload refused' })
    expect(response.headers.get('x-private')).toBeNull()
    expect(response.headers.get('x-error-code')).toBe('refused')
    expect(response.headers.get('connection')).not.toBe('close, x-private')
  })

  test('returns actionable disconnect and unsupported-hub errors', async () => {
    const relay = await createComputerCliRelay({
      request: async () => {
        throw new Error('offline')
      }
    })
    cleanup.push(() => relay.close())
    const session = relay.issue()
    const response = await fetch(`${relay.url}/api/tasks`, {
      headers: { authorization: `Bearer ${session.token}` }
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('CLI relay')
  })
})
