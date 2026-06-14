import { test, expect, resetApp } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import http from 'http'

/**
 * Hook-driven agent lifecycle E2E.
 *
 * Validates the load-bearing links in the chain:
 *   1. Boot installer writes notify.sh to SLAYZONE_HOME_DIR/hooks and merges
 *      managed entries into SLAYZONE_CLAUDE_SETTINGS_PATH.
 *   2. POST /api/agent-hook end-to-end: HTTP → REST handler → IPC broadcast
 *      → preload listener → renderer callback. Real loopback, real Electron.
 *
 * Sandbox paths are set by the fixture (electron.ts) so we never touch the
 * dev user's real ~/.slayzone or ~/.claude/settings.json.
 */
test.describe('Claude agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote notify.sh + settings.json to sandbox paths', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', [
        'SLAYZONE_HOME_DIR',
        'SLAYZONE_CLAUDE_SETTINGS_PATH'
      ])
    })) as Record<string, string>

    expect(env.SLAYZONE_HOME_DIR).toBeTruthy()
    expect(env.SLAYZONE_CLAUDE_SETTINGS_PATH).toBeTruthy()

    const scriptPath = path.join(env.SLAYZONE_HOME_DIR, 'hooks', 'notify.sh')
    await waitForFile(scriptPath, 5000)
    await waitForFile(env.SLAYZONE_CLAUDE_SETTINGS_PATH, 5000)

    const stat = fs.statSync(scriptPath)
    expect(stat.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o755)
    }

    const settings = JSON.parse(fs.readFileSync(env.SLAYZONE_CLAUDE_SETTINGS_PATH, 'utf8'))
    expect(settings.hooks).toBeDefined()
    expect(Array.isArray(settings.hooks.Stop)).toBe(true)
    const stopEntry = settings.hooks.Stop[0]
    expect(stopEntry.hooks[0].command).toContain('notify.sh')
    expect(stopEntry.hooks[0]._slayzoneManaged).toBe(true)

    // Tool-scoped events use matcher '*' so a single entry covers all tools.
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*')
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*')
  })

  test('POST /api/agent-hook dispatches agent:lifecycle to renderer', async ({ mainWindow }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null

    expect(port).toBeTruthy()
    if (!port) return

    // Subscribe in renderer before firing.
    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__hookEvents = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__hookEvents as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__hookUnsub = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      sessionId: 'e2e-session',
      taskId: 'e2e-task'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__hookEvents as unknown[] | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = await handle.jsonValue()
    expect(event).toMatchObject({
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      type: 'agent-start',
      sessionId: 'e2e-session',
      taskId: 'e2e-task'
    })

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__hookUnsub as (() => void) | undefined
      unsub?.()
    })
  })

  test('unknown hookEvent yields 204 + no broadcast', async ({ mainWindow }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__hookEvents2 = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__hookEvents2 as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__hookUnsub2 = () => sub.unsubscribe()
    })

    const { status } = await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'claude-code',
      hookEvent: 'TotallyUnknown'
    })
    expect(status).toBe(204)

    // Give IPC a tick — should remain empty.
    await new Promise((r) => setTimeout(r, 250))
    const events = await mainWindow.evaluate(
      () => (window as Record<string, unknown>).__hookEvents2
    )
    expect((events as unknown[]).length).toBe(0)

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__hookUnsub2 as (() => void) | undefined
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
