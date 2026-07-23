import { test, expect, resetApp } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import http from 'http'

/**
 * OpenCode plugin-driven agent lifecycle E2E.
 *
 * Validates:
 *   1. Boot installer wrote the OpenCode plugin JS to the sandboxed
 *      $XDG_CONFIG_HOME/opencode/plugin/slayzone-notify.js path with the
 *      `{{NOTIFY_PATH}}` placeholder substituted to the absolute notify.sh path.
 *   2. The plugin source carries the SlayZone v1 marker + singleton guard.
 *   3. POST /api/agent-hook accepts opencode lifecycle events and broadcasts
 *      them to the renderer over the agent:lifecycle channel.
 *
 * Sandbox paths come from the fixture (electron.ts). No real
 * ~/.config/opencode/plugin/ writes from this spec.
 */
test.describe('OpenCode agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote plugin to sandbox path w/ NOTIFY_PATH substituted', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', [
        'SLAYZONE_USER_DATA_DIR',
        'SLAYZONE_OPENCODE_PLUGIN_PATH'
      ])
    })) as Record<string, string>

    expect(env.SLAYZONE_USER_DATA_DIR).toBeTruthy()
    expect(env.SLAYZONE_OPENCODE_PLUGIN_PATH).toBeTruthy()

    const pluginPath = env.SLAYZONE_OPENCODE_PLUGIN_PATH
    await waitForFile(pluginPath, 5000)

    const stat = fs.statSync(pluginPath)
    expect(stat.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o644)
    }

    const expectedNotifyPath = path.join(env.SLAYZONE_USER_DATA_DIR, 'hooks', 'notify.sh')
    const content = fs.readFileSync(pluginPath, 'utf8')
    expect(content).toContain('SlayZone opencode plugin v1')
    expect(content).toContain('__slayzoneOpencodePluginV1')
    expect(content).not.toContain('{{NOTIFY_PATH}}')
    expect(content).toContain(expectedNotifyPath)
    expect(content).toContain('SlayzoneNotifyPlugin')
  })

  test('POST /api/agent-hook dispatches opencode agent:lifecycle to renderer', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null

    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__opencodeHookEvents = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__opencodeHookEvents as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__opencodeHookUnsub = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'opencode',
      hookEvent: 'Start',
      sessionId: 'oc-e2e-session',
      taskId: 'oc-e2e-task'
    })
    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'opencode',
      hookEvent: 'Stop',
      sessionId: 'oc-e2e-session',
      taskId: 'oc-e2e-task'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__opencodeHookEvents as
          | unknown[]
          | undefined
        return events && events.length >= 2 ? events : null
      },
      { timeout: 3000 }
    )
    const events = (await handle.jsonValue()) as Array<{
      agentId: string
      hookEvent: string
      type: string
    }>
    expect(events[0]).toMatchObject({
      agentId: 'opencode',
      hookEvent: 'Start',
      type: 'agent-start'
    })
    expect(events[1]).toMatchObject({ agentId: 'opencode', hookEvent: 'Stop', type: 'agent-stop' })

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__opencodeHookUnsub as
        | (() => void)
        | undefined
      unsub?.()
    })
  })

  test('PermissionRequest hookEvent maps to permission-request lifecycle', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__opencodePermEvents = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__opencodePermEvents as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__opencodePermUnsub = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'opencode',
      hookEvent: 'PermissionRequest',
      sessionId: 'oc-perm',
      taskId: 'oc-task'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__opencodePermEvents as
          | unknown[]
          | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = (await handle.jsonValue()) as { type: string }
    expect(event.type).toBe('permission-request')

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__opencodePermUnsub as
        | (() => void)
        | undefined
      unsub?.()
    })
  })
})

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`File did not appear within ${timeoutMs}ms: ${p}`)
}

function postJson(url: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method: 'POST',
        path: u.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}
