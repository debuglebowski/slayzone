import { test, expect, resetApp, seed, TEST_PROJECT_PATH } from '../fixtures/electron'
import fs from 'fs'
import { spawnSync } from 'child_process'

/**
 * Codex hook-driven agent lifecycle E2E.
 *
 * Codex integration uses Codex's native hooks system — SlayZone writes
 * `~/.codex/hooks.json`; Codex itself runs the hook. (The legacy
 * `~/.slayzone/bin/codex` bash wrapper was removed: it could not run on
 * Windows.)
 *
 * Validates the load-bearing links:
 *   1. Boot installer writes a managed `hooks.json` covering the lifecycle events.
 *   2. notify.sh accepts a Codex-native hook payload (JSON via stdin, event in
 *      `hook_event_name`) — agentId=codex envelope POST → /api/agent-hook →
 *      IPC broadcast with the correctly normalized lifecycle type.
 */
test.describe('Codex agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote a managed ~/.codex/hooks.json', async ({ mainWindow }) => {
    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', ['SLAYZONE_CODEX_HOOKS_PATH'])
    })) as Record<string, string>

    expect(env.SLAYZONE_CODEX_HOOKS_PATH).toBeTruthy()
    await waitForFile(env.SLAYZONE_CODEX_HOOKS_PATH, 5000)

    const config = JSON.parse(fs.readFileSync(env.SLAYZONE_CODEX_HOOKS_PATH, 'utf8'))
    expect(config.hooks).toBeDefined()
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const list = config.hooks[ev]
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBeGreaterThanOrEqual(1)
      const managed = list.find((e: { hooks?: Array<{ _slayzoneManaged?: boolean }> }) =>
        e.hooks?.some((h) => h._slayzoneManaged === true)
      )
      expect(managed).toBeTruthy()
      // notify.sh is invoked explicitly via bash for cross-platform reliability.
      expect(managed.hooks[0].command).toContain('bash ')
      expect(managed.hooks[0].command).toContain('notify.sh')
    }
  })

  test('notify.sh accepts a Codex stdin hook payload → agent:lifecycle IPC for agentId=codex', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', ['SLAYZONE_HOME_DIR'])
    })) as Record<string, string>
    const scriptPath = `${env.SLAYZONE_HOME_DIR}/hooks/notify.sh`
    await waitForFile(scriptPath, 5000)

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__codexHookEvents = []
      const unsub = window.api.agentLifecycle.onEvent((ev) => {
        ;((window as Record<string, unknown>).__codexHookEvents as unknown[]).push(ev)
      })
      ;(window as Record<string, unknown>).__codexHookUnsub = unsub
    })

    // Codex native hooks deliver the event as JSON on stdin (hook_event_name).
    const res = spawnSync('bash', [scriptPath], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e' }),
      env: {
        ...process.env,
        SLAYZONE_AGENT_HOOK_URL: `http://127.0.0.1:${port}/api/agent-hook`,
        SLAYZONE_AGENT_ID: 'codex',
        SLAYZONE_TASK_ID: 'e2e-codex-task'
      }
    })
    expect(res.status).toBe(0)

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__codexHookEvents as
          | unknown[]
          | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 5000 }
    )
    const event = await handle.jsonValue()
    expect(event).toMatchObject({
      agentId: 'codex',
      type: 'agent-stop',
      taskId: 'e2e-codex-task'
    })

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__codexHookUnsub as (() => void) | undefined
      unsub?.()
    })
  })

  test('UserPromptSubmit stdin payload maps to agent-start', async ({ mainWindow }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', ['SLAYZONE_HOME_DIR'])
    })) as Record<string, string>
    const scriptPath = `${env.SLAYZONE_HOME_DIR}/hooks/notify.sh`

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__codexStartEvents = []
      const unsub = window.api.agentLifecycle.onEvent((ev) => {
        ;((window as Record<string, unknown>).__codexStartEvents as unknown[]).push(ev)
      })
      ;(window as Record<string, unknown>).__codexStartUnsub = unsub
    })

    const res = spawnSync('bash', [scriptPath], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      env: {
        ...process.env,
        SLAYZONE_AGENT_HOOK_URL: `http://127.0.0.1:${port}/api/agent-hook`,
        SLAYZONE_AGENT_ID: 'codex'
      }
    })
    expect(res.status).toBe(0)

    const handle = await mainWindow.waitForFunction(
      () => {
        const events = (window as Record<string, unknown>).__codexStartEvents as
          | unknown[]
          | undefined
        return events && events.length > 0 ? events[0] : null
      },
      { timeout: 5000 }
    )
    const event = await handle.jsonValue()
    expect(event).toMatchObject({ agentId: 'codex', type: 'agent-start' })

    await mainWindow.evaluate(() => {
      const unsub = (window as Record<string, unknown>).__codexStartUnsub as
        | (() => void)
        | undefined
      unsub?.()
    })
  })

  test('SessionStart stdin payload persists session_id to provider_config.codex.conversationId', async ({
    mainWindow
  }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', ['SLAYZONE_HOME_DIR'])
    })) as Record<string, string>
    const scriptPath = `${env.SLAYZONE_HOME_DIR}/hooks/notify.sh`
    await waitForFile(scriptPath, 5000)

    // A real task row must exist — the server reads provider_config by task id.
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Codex Hook Capture',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({
      projectId: project.id,
      title: 'CHC codex task',
      status: 'todo'
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'codex' }),
      task.id
    )

    // The codex SessionStart hook carries the codex CLI session_id — the
    // PRIMARY resume-id capture path (no /status command needed).
    const codexSessionId = '88888888-8888-4888-8888-888888888888'
    const res = spawnSync('bash', [scriptPath], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: codexSessionId,
        source: 'startup'
      }),
      env: {
        ...process.env,
        SLAYZONE_AGENT_HOOK_URL: `http://127.0.0.1:${port}/api/agent-hook`,
        SLAYZONE_AGENT_ID: 'codex',
        SLAYZONE_TASK_ID: task.id
      }
    })
    expect(res.status).toBe(0)

    await expect
      .poll(
        async () => {
          const t = await mainWindow.evaluate(
            (id) => window.getTrpcVanillaClient().task.get.query({ id }),
            task.id
          )
          const pc = (t as { provider_config?: unknown } | null)?.provider_config
          const parsed = typeof pc === 'string' ? JSON.parse(pc) : pc
          return (parsed as { codex?: { conversationId?: string } } | null)?.codex?.conversationId ?? null
        },
        { timeout: 5000 }
      )
      .toBe(codexSessionId)
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
