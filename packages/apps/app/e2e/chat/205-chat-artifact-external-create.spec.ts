/**
 * Chat task: an artifact created OUTSIDE the app (`slay tasks artifacts create`)
 * shows up in the task's already-open artifacts panel without a reload.
 *
 * Packaged pilot 2026-11-03, the exact path: a Claude chat task, an attachment
 * sent and opened from its bubble into the artifacts panel, then a CLI-created
 * report — in the REST and tRPC listings at once, in the open panel only after
 * Reload App. No `refreshData()` here: it invalidates every query and would hide it.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { cliEnv, cliRoot, resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

test.describe('Claude chat: artifact created outside the app', () => {
  test.beforeAll(async ({ mainWindow }) => {
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }
    await resetApp(mainWindow)
  })

  test('appears in the artifacts panel opened from a sent attachment', async ({
    chat,
    electronApp
  }) => {
    const t = await chat.openTask({
      title: 'Chat external artifact',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.panel
      .getByTestId('chat-attach-input')
      .setInputFiles([
        { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('attached\n') }
      ])
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
    await t.send('see attached')
    await expect(t.panel.getByText('echo: see attached')).toBeVisible()

    // Open the sent attachment: the panel opens on it.
    await t.panel.getByTestId('chat-message-attachments').getByRole('button').first().click()
    const panel = t.page.locator('[data-panel-id="artifacts"]:visible')
    const rows = panel.locator('[data-testid="artifacts-sidebar"] [data-testid^="artifact-row-"]')
    await expect(rows).toHaveCount(1, { timeout: 5_000 })

    const env: Record<string, string> = cliEnv(await cliRoot(electronApp))
    delete env.SLAYZONE_PROJECT_ID
    delete env.SLAYZONE_TASK_ID
    const r = spawnSync(
      'node',
      [SLAY_JS, 'tasks', 'artifacts', 'create', 'Pilot report.md', '--task', t.taskId, '--json'],
      { env, encoding: 'utf8', input: '# report\n' }
    )
    expect(r.status, r.stderr).toBe(0)

    await expect(rows.filter({ hasText: 'Pilot report.md' })).toHaveCount(1, { timeout: 5_000 })
  })
})
