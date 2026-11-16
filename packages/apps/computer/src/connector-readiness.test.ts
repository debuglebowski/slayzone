import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { startLoopbackHub } from '@slayzone/computer-transport/testing'
import { DuplexRpc } from '@slayzone/computer-transport/shared'
import { startSessionHost, hostControl, type ConnectorGrant } from './session-host'
import { startConnector } from './connector'
import { placeTestProject } from './project-scope.fixture'

test.each([false, true])(
  'real gateway waits for host identity delivery; cancel old connection=%s',
  async (cancel) => {
    const root = mkdtempSync(join(tmpdir(), 'connector-identity-order-'))
    const previous = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = root
    const hub = await startLoopbackHub({ floodLimits: false })
    const config = {
      hubUrl: hub.url,
      name: 'identity-order',
      allowedRoots: [root],
      capabilities: ['pty'],
      joinToken: 'jt-valid'
    }
    placeTestProject(root, hub.url, 'p', root)
    const host = await startSessionHost(root, config),
      control = await hostControl(root)
    let release!: () => void,
      held = false,
      dispatches = 0
    const delivery = new Promise<void>((r) => {
      release = r
    })
    const original = DuplexRpc.prototype.request
    const spy = vi.spyOn(DuplexRpc.prototype, 'request').mockImplementation(function <T>(
      this: DuplexRpc,
      method: string,
      params?: unknown,
      timeoutMs?: number,
      actor?: unknown
    ): Promise<T> {
      if (method === 'connected') {
        held = true
        return delivery.then(() =>
          Reflect.apply(original, this, [method, params, timeoutMs, actor])
        ) as Promise<T>
      }
      if (method === 'dispatch' && (params as { method?: string })?.method === 'pty.spawn')
        dispatches++
      return Reflect.apply(original, this, [method, params, timeoutMs, actor]) as Promise<T>
    })
    let connector: Awaited<ReturnType<typeof startConnector>> | undefined
    try {
      const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      connector = await startConnector(root, config, grant)
      await connector.dialer.events.once('connected')
      expect(held).toBe(true)
      let id = hub.gateway.listComputers()[0].computerId
      let settled = false
      const spawn = hub.gateway.request<{ pid: number }>(id, 'pty.spawn', {
        sessionId: 'scoped',
        projectId: 'p',
        cwd: root,
        command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      })
      void spawn.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      // Real later network frame: request dispatch has had its microtask turn;
      // no synthetic delay or mocked ping is used to manufacture the ordering.
      await hub.gateway.request(id, 'ping', {})
      expect(dispatches).toBe(0)
      expect(settled).toBe(false)
      if (cancel) {
        await connector.stop()
        await expect(spawn).rejects.toThrow()
        // A fresh authenticated identity, not the previous connection's cached ID.
        hub.auth.byApiKey.clear()
        const next = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
        release()
        connector = await startConnector(root, config, next)
        await connector.dialer.events.once('connected')
        const replacement = hub.gateway.listComputers()[0].computerId
        expect(replacement).not.toBe(id)
        id = replacement
        expect(await hub.gateway.request(id, 'pty.list', {})).toMatchObject({ sessions: [] })
        expect(dispatches).toBe(0)
        const current = await hub.gateway.request<{ pid: number }>(id, 'pty.spawn', {
          sessionId: 'scoped',
          projectId: 'p',
          cwd: root,
          command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
        })
        expect(current.pid).toBeGreaterThan(0)
      } else {
        release()
        expect((await spawn).pid).toBeGreaterThan(0)
      }
      expect(dispatches).toBe(1)
      expect(await hub.gateway.request(id, 'pty.list', {})).toMatchObject({
        sessions: [{ sessionId: 'scoped' }]
      })
      await hub.gateway.request(id, 'pty.kill', { sessionId: 'scoped' })
    } finally {
      release()
      await connector?.stop()
      spy.mockRestore()
      control.close()
      await host.stop()
      await hub.close()
      if (previous === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  }
)
