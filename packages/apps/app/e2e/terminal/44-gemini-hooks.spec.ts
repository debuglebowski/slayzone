import { test, expect, resetApp, notifyScriptPath } from '../fixtures/electron'
import fs from 'fs'
import http from 'http'

/**
 * Gemini agent hooks E2E. Mirrors 40-claude-hooks.spec.ts.
 *
 * Sandboxed via SLAYZONE_GEMINI_SETTINGS_PATH set by the fixture. The boot
 * installer's `gemini --version` probe is bypassed under
 * SLAYZONE_E2E_INSTALL_HOOKS=1 so settings.json is written even when the
 * binary is not on PATH in CI.
 *
 * Lifecycle dispatch is exercised by POSTing directly to /api/agent-hook
 * (no Gemini binary required). The `agent-start` mapping for `BeforeAgent`
 * comes from the per-agent override table in agent-event-handler.ts.
 */

/**
 * The renderer-side scratch globals this spec parks its captured lifecycle
 * events on. Declared as a Window extension rather than casting to
 * `Record<string, unknown>`, which TS rejects as a non-overlapping conversion.
 * Type-only, so it is erased before the closures are serialised.
 */
type HookWindow = Window & {
  __geminiEvents?: unknown[]
  __geminiUnsub?: () => void
  __geminiEvents2?: unknown[]
  __geminiUnsub2?: () => void
}

test.describe('Gemini agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote notify.sh + Gemini settings.json to sandbox', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      return window.__testInvoke('e2e:get-env', [
        'SLAYZONE_USER_DATA_DIR',
        'SLAYZONE_GEMINI_SETTINGS_PATH'
      ])
    })) as Record<string, string>

    expect(env.SLAYZONE_USER_DATA_DIR).toBeTruthy()
    expect(env.SLAYZONE_GEMINI_SETTINGS_PATH).toBeTruthy()

    const scriptPath = notifyScriptPath(env.SLAYZONE_USER_DATA_DIR)
    await waitForFile(scriptPath, 5000)
    await waitForFile(env.SLAYZONE_GEMINI_SETTINGS_PATH, 5000)

    const settings = JSON.parse(fs.readFileSync(env.SLAYZONE_GEMINI_SETTINGS_PATH, 'utf8'))
    expect(settings.hooks).toBeDefined()

    for (const ev of ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'AfterTool']) {
      const list = settings.hooks[ev]
      expect(Array.isArray(list)).toBe(true)
      expect(list[0].hooks[0].command).toContain('notify.sh')
      expect(list[0].hooks[0]._slayzoneManaged).toBe(true)
    }

    expect(settings.hooks.AfterTool[0].matcher).toBe('*')
    expect(settings.hooks.BeforeAgent[0].matcher).toBeUndefined()
  })

  test('POST /api/agent-hook with Gemini BeforeAgent → agent-start lifecycle event', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null

    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      const w = window as HookWindow
      w.__geminiEvents = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          w.__geminiEvents?.push(ev)
        }
      })
      w.__geminiUnsub = () => sub.unsubscribe()
    })

    // The tRPC WS subscription above registers server-side asynchronously after
    // .subscribe() returns, so a POST firing before it's live misses the emit
    // (lost-event race — flaked intermittently). Retry the POST until an event lands;
    // re-POSTing the same BeforeAgent hook is idempotent for the events[0] assertion.
    await expect(async () => {
      await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
        agentId: 'gemini',
        hookEvent: 'BeforeAgent',
        sessionId: 'gemini-sess',
        taskId: 'gemini-task'
      })
      await mainWindow.waitForFunction(
        () => {
          const events = (window as HookWindow).__geminiEvents
          return !!events && events.length > 0
        },
        { timeout: 2000 }
      )
    }).toPass({ timeout: 15000 })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as HookWindow).__geminiEvents
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = await handle.jsonValue()
    expect(event).toMatchObject({
      agentId: 'gemini',
      hookEvent: 'BeforeAgent',
      type: 'agent-start',
      sessionId: 'gemini-sess',
      taskId: 'gemini-task'
    })

    await mainWindow.evaluate(() => {
      ;(window as HookWindow).__geminiUnsub?.()
    })
  })

  test('AfterTool maps to agent-start under Gemini override (not agent-stop)', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      const w = window as HookWindow
      w.__geminiEvents2 = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          w.__geminiEvents2?.push(ev)
        }
      })
      w.__geminiUnsub2 = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'gemini',
      hookEvent: 'AfterTool'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as HookWindow).__geminiEvents2
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = (await handle.jsonValue()) as { type: string; agentId: string }
    expect(event.type).toBe('agent-start')
    expect(event.agentId).toBe('gemini')

    await mainWindow.evaluate(() => {
      ;(window as HookWindow).__geminiUnsub2?.()
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
