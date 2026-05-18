import { test, expect, resetApp } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'

/**
 * Codex hook-driven agent lifecycle E2E.
 *
 * Validates the load-bearing links:
 *   1. Boot installer writes codex-wrapper.sh to $SLAYZONE_HOME_DIR/bin/codex
 *      with executable mode.
 *   2. notify.sh accepts Codex-shape argv payloads (real codex passes JSON
 *      via argv $1, not stdin) — agentId=codex envelope POST →
 *      /api/agent-hook → IPC broadcast.
 *
 * The real wrapper subprocess + JSONL tail behaviour is exercised by unit /
 * integration tests + manual verification; here we cover the wire format
 * and installer in real Electron.
 */
test.describe('Codex agent hooks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('boot installer wrote codex wrapper to sandbox $SLAYZONE_HOME_DIR/bin/codex', async ({
    mainWindow
  }) => {
    const env = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-env', ['SLAYZONE_HOME_DIR'])
    })) as Record<string, string>

    expect(env.SLAYZONE_HOME_DIR).toBeTruthy()
    const wrapperPath = path.join(env.SLAYZONE_HOME_DIR, 'bin', 'codex')
    await waitForFile(wrapperPath, 5000)

    const stat = fs.statSync(wrapperPath)
    expect(stat.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o755)
    }
    const content = fs.readFileSync(wrapperPath, 'utf8')
    expect(content).toContain('# slayzone codex wrapper v1')
    // Self-skip resolver must be present so the wrapper doesn't infinite-loop
    // when ~/.slayzone/bin is on PATH.
    expect(content).toContain('which -a codex')
    expect(content).toContain('grep -v')
  })

  test('notify.sh accepts Codex-shape argv → POST → agent:lifecycle IPC for agentId=codex', async ({
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
    const scriptPath = path.join(env.SLAYZONE_HOME_DIR, 'hooks', 'notify.sh')
    await waitForFile(scriptPath, 5000)

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__codexHookEvents = []
      const unsub = window.api.agentLifecycle.onEvent((ev) => {
        ;((window as Record<string, unknown>).__codexHookEvents as unknown[]).push(ev)
      })
      ;(window as Record<string, unknown>).__codexHookUnsub = unsub
    })

    // Codex native notify callback shape — passes JSON as argv $1 with "type".
    const argv = JSON.stringify({ type: 'agent-turn-complete', turn_id: 'e2e' })
    const res = spawnSync('bash', [scriptPath, argv], {
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

  test('wrapper synthetic Start payload (hook_event_name) maps to agent-start', async ({
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
    const scriptPath = path.join(env.SLAYZONE_HOME_DIR, 'hooks', 'notify.sh')

    await mainWindow.evaluate(() => {
      ;(window as Record<string, unknown>).__codexStartEvents = []
      const unsub = window.api.agentLifecycle.onEvent((ev) => {
        ;((window as Record<string, unknown>).__codexStartEvents as unknown[]).push(ev)
      })
      ;(window as Record<string, unknown>).__codexStartUnsub = unsub
    })

    const argv = JSON.stringify({ hook_event_name: 'Start' })
    const res = spawnSync('bash', [scriptPath, argv], {
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
})

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`File did not appear within ${timeoutMs}ms: ${p}`)
}
