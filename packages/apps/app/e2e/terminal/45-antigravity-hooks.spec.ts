import {
  test,
  expect,
  resetApp,
  seed,
  TEST_PROJECT_PATH,
  notifyScriptPath
} from '../fixtures/electron'
import fs from 'fs'
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

/** Scratch slots the specs below park on `window` inside evaluate closures. */
type HookWindow = Window & {
  __agEvents?: unknown[]
  __agUnsub?: () => void
  __agEvents2?: unknown[]
  __agUnsub2?: () => void
}

test.describe('Antigravity agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote notify.sh + Antigravity hooks.json to sandbox', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      return window.__testInvoke('e2e:get-env', [
        'SLAYZONE_USER_DATA_DIR',
        'SLAYZONE_ANTIGRAVITY_HOOKS_PATH'
      ])
    })) as Record<string, string>

    expect(env.SLAYZONE_USER_DATA_DIR).toBeTruthy()
    expect(env.SLAYZONE_ANTIGRAVITY_HOOKS_PATH).toBeTruthy()

    const scriptPath = notifyScriptPath(env.SLAYZONE_USER_DATA_DIR)
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
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null

    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      const events: unknown[] = []
      ;(window as HookWindow).__agEvents = events
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          events.push(ev)
        }
      })
      ;(window as HookWindow).__agUnsub = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'antigravity',
      hookEvent: 'PreInvocation',
      sessionId: 'ag-sess',
      taskId: 'ag-task'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as HookWindow).__agEvents
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
      const unsub = (window as HookWindow).__agUnsub
      unsub?.()
    })
  })

  test('POST /api/agent-hook with Antigravity Stop → agent-stop lifecycle event', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    await mainWindow.evaluate(() => {
      const events: unknown[] = []
      ;(window as HookWindow).__agEvents2 = events
      const sub = window.getTrpcVanillaClient().agentLifecycle.onEvent.subscribe(undefined, {
        onData: (ev) => {
          events.push(ev)
        }
      })
      ;(window as HookWindow).__agUnsub2 = () => sub.unsubscribe()
    })

    await postJson(`http://127.0.0.1:${port}/api/agent-hook`, {
      agentId: 'antigravity',
      hookEvent: 'Stop'
    })

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as HookWindow).__agEvents2
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 3000 }
    )
    const event = (await handle.jsonValue()) as { type: string; agentId: string }
    expect(event.type).toBe('agent-stop')
    expect(event.agentId).toBe('antigravity')

    await mainWindow.evaluate(() => {
      const unsub = (window as HookWindow).__agUnsub2
      unsub?.()
    })
  })

  test('PreInvocation with sessionId persists provider_config.antigravity.conversationId', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
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
    // `seed().createTask` narrows its input to the common fields and drops
    // `terminalMode`, which this spec needs — go straight at task.create.
    const task = await mainWindow.evaluate(
      (d) => window.getTrpcVanillaClient().task.create.mutate(d),
      {
        projectId: project.id,
        title: 'AG sid capture',
        status: 'in_progress',
        terminalMode: 'antigravity'
      }
    )

    const cid = 'aa111111-1111-4111-8111-111111111111'

    // Seed the spawn-intent row slay writes when it launches the agent, so the
    // PreInvocation hook id is honored (slay-spawned) and persisted rather than
    // skipped as foreign-observed (RC1 clobber guard).
    await mainWindow.evaluate(
      ({ id, sid }) =>
        window.getTrpcVanillaClient().task.testRecordPendingSpawn.mutate({
          taskId: id,
          mode: 'antigravity',
          expectedSessionId: sid,
          usedResume: false
        }),
      { id: task.id, sid: cid }
    )

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
