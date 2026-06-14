import { test, expect, resetApp, seed, TEST_PROJECT_PATH } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import http from 'http'

/**
 * Antigravity agent hooks E2E. Mirrors 44-gemini-hooks.spec.ts.
 *
 * Sandboxed via SLAYZONE_ANTIGRAVITY_HOOKS_PATH set by the fixture. The boot
 * installer's `agy --version` probe is bypassed under SLAYZONE_E2E_INSTALL_HOOKS=1
 * so hooks.json is written even when the binary is not on PATH in CI.
 *
 * Antigravity (`agy`) hook spec — confirmed against the real CLI v1.0.0 + docs:
 *   - hooks.json uses a NAMED-hook schema: `{ "<name>": { "<Event>": [...] } }`
 *   - SlayZone owns the `slayzone-notify` key
 *   - events: PreInvocation / PostToolUse / Stop (no SessionStart/UserPromptSubmit)
 *   - the event name is passed as an argv arg (not in the payload)
 *   - the resumable id is `conversationId`, present in every hook payload
 */
test.describe('Antigravity agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote notify.sh + Antigravity hooks.json to sandbox', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', [
        'SLAYZONE_HOME_DIR',
        'SLAYZONE_ANTIGRAVITY_HOOKS_PATH'
      ])
    })) as Record<string, string>

    expect(env.SLAYZONE_HOME_DIR).toBeTruthy()
    expect(env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH).toBeTruthy()

    const scriptPath = path.join(env.SLAYZONE_HOME_DIR, 'hooks', 'notify.sh')
    await waitForFile(scriptPath, 5000)
    await waitForFile(env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH, 5000)

    const config = JSON.parse(fs.readFileSync(env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH, 'utf8'))
    const named = config['slayzone-notify']
    expect(named).toBeDefined()

    for (const ev of ['PreInvocation', 'PostToolUse', 'Stop']) {
      const list = named[ev]
      expect(Array.isArray(list)).toBe(true)
      // command is `<notify.sh> <EventName>` — event passed as argv.
      expect(list[0].hooks[0].command).toContain('notify.sh')
      expect(list[0].hooks[0].command).toContain(ev)
    }

    expect(named.PostToolUse[0].matcher).toBe('*')
    expect(named.PreInvocation[0].matcher).toBeUndefined()
  })

  test('POST /api/agent-hook with Antigravity PreInvocation → agent-start lifecycle event', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null

    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__agEvents = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__agEvents as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__agUnsub = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'antigravity',
      hookEvent: 'PreInvocation',
      sessionId: 'ag-sess',
      taskId: 'ag-task'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__agEvents as unknown[] | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = await handle.jsonValue()
    expect(event).toMatchObject({
      agentId: 'antigravity',
      hookEvent: 'PreInvocation',
      type: 'agent-start',
      sessionId: 'ag-sess',
      taskId: 'ag-task'
    })

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__agUnsub as (() => void) | undefined
      unsub?.()
    })
  })

  test('POST /api/agent-hook with Antigravity Stop → agent-stop lifecycle event', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__agEvents2 = []
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          ;((window as Record<string, unknown>).__agEvents2 as unknown[]).push(ev)
        }
      })
      ;(window as Record<string, unknown>).__agUnsub2 = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'antigravity',
      hookEvent: 'Stop'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__agEvents2 as unknown[] | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = (await handle.jsonValue()) as { type: string; agentId: string }
    expect(event.type).toBe('agent-stop')
    expect(event.agentId).toBe('antigravity')

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__agUnsub2 as (() => void) | undefined
      unsub?.()
    })
  })

  test('PreInvocation with sessionId persists provider_config.antigravity.conversationId', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'AgSid',
      color: '#0891b2',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({
      projectId: project.id,
      title: 'AG sid capture',
      status: 'in_progress',
      terminalMode: 'antigravity'
    })

    const cid = 'aa111111-1111-4111-8111-111111111111'
    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'antigravity',
      hookEvent: 'PreInvocation',
      taskId: task.id,
      sessionId: cid
    })

    // persistConversationId is awaited server-side before the 200 response, so
    // the row is written by the time postJson resolves; poll guards the read.
    await expect
      .poll(
        async () => {
          const t = await mainWindow.evaluate(
            (id) => window.getTrpcVanillaClient().task.get.query({ id }),
            task.id
          )
          return t?.provider_config?.antigravity?.conversationId ?? null
        },
        { timeout: 3000 }
      )
      .toBe(cid)
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
