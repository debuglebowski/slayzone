import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, getMainSessionId } from '../fixtures/terminal'
import http from 'http'

/**
 * Agent-terminal "messages" sidebar: lists user prompts sent to the MAIN agent,
 * captured from the agent's UserPromptSubmit hook (POST /api/agent-hook). The
 * capture LOGIC + chronological ordering are unit-covered
 * (@slayzone/agent-turns prompt-capture.test.ts); this spec proves the live
 * chain — hook POST → DB → tRPC → sidebar render — plus toggle gating.
 */
test.describe('Agent prompts sidebar', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Agent Prompts',
      color: '#06b6d4',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Prompts task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Prompts task' })
  })

  test('captures hook prompts and renders them in the sidebar', async ({ mainWindow }) => {
    const port = (await mainWindow.evaluate(() => {
      // @ts-expect-error -- test bridge
      return window.__testInvoke('e2e:get-mcp-port', [])
    })) as number | null
    expect(port).toBeTruthy()
    if (!port) return

    // Toggle button is visible for a claude-code (capture-capable) main agent.
    const toggle = mainWindow.locator('[data-testid="agent-prompts-toggle"]:visible').first()
    await expect(toggle).toBeVisible()

    // Open the sidebar — starts empty for a fresh task.
    await toggle.click()
    const sidebar = mainWindow.locator('[data-testid="agent-prompts-sidebar"]:visible').first()
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByText('No messages yet')).toBeVisible()

    // While open, the toggle relocates INTO the sidebar header — exactly one
    // toggle exists app-wide, and it lives inside the sidebar (not the tab bar).
    await expect(mainWindow.locator('[data-testid="agent-prompts-toggle"]:visible')).toHaveCount(1)
    await expect(sidebar.locator('[data-testid="agent-prompts-toggle"]')).toHaveCount(1)

    // Fire two UserPromptSubmit hooks (sequential — small gap keeps inserts
    // distinct so the transcript order is stable).
    const hookUrl = `http://127.0.0.1:${port}/api/agent-hook`
    await postJson(hookUrl, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      sessionId: getMainSessionId(taskId),
      taskId,
      raw: { prompt: 'first prompt from e2e' }
    })
    await mainWindow.waitForTimeout(60)
    await postJson(hookUrl, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      sessionId: getMainSessionId(taskId),
      taskId,
      raw: { prompt: 'second prompt from e2e' }
    })

    // The onChanged subscription refetches; web-first assertions poll until the
    // two captured prompts render.
    const items = sidebar.locator('[data-testid="agent-prompt-item"]')
    await expect(items).toHaveCount(2)
    await expect(sidebar.getByText('first prompt from e2e')).toBeVisible()
    await expect(sidebar.getByText('second prompt from e2e')).toBeVisible()

    // A non-UserPromptSubmit hook must NOT add an item.
    await postJson(hookUrl, {
      agentId: 'claude-code',
      hookEvent: 'PreToolUse',
      taskId,
      raw: { tool_name: 'Bash', prompt: 'ignored' }
    })
    await mainWindow.waitForTimeout(200)
    await expect(items).toHaveCount(2)

    // The header toggle closes the sidebar.
    await sidebar.locator('[data-testid="agent-prompts-toggle"]').click()
    await expect(mainWindow.locator('[data-testid="agent-prompts-sidebar"]:visible')).toHaveCount(0)
    // ...and the toggle returns to the tab bar.
    await expect(mainWindow.locator('[data-testid="agent-prompts-toggle"]:visible')).toHaveCount(1)
  })
})

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
