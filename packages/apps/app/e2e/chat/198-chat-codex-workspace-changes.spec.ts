import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetApp } from '../fixtures/electron'
import { codexEchoTurn, cstep, expect, streamReply, test } from '../fixtures/chat-codex'

test.describe('Codex saved workspace changes', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })
  test('shell edits show without fileChange events and survive reload', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex workspace observation',
      scenario: {
        processes: [
          {
            turns: [[...streamReply(['Ready for shell edit.']), cstep.hang()]],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    writeFileSync(join(t.cwd, 'config.ts'), 'const retries = 2\n')
    await t.send('Update retries')
    await expect(t.panel.getByText('Ready for shell edit.')).toBeVisible()
    execFileSync('python3', [
      '-c',
      "import sys;open(sys.argv[1],'w').write('const retries = 3\\n')",
      join(t.cwd, 'config.ts')
    ])
    await t.stopButton.click()
    const row = t.panel.getByTestId('chat-workspace-changes')
    await expect(row).toContainText('1 file', { timeout: 15000 })
    await expect(t.panel.getByTestId('chat-files-changed')).toHaveCount(0)
    await row.getByRole('button', { name: /Workspace changes/ }).click()
    await row.getByRole('button', { name: /config.ts/ }).click()
    await expect(row.getByText('const retries = 2', { exact: true })).toBeVisible()
    await expect(row.getByText('const retries = 3', { exact: true })).toBeVisible()
    await t.reload()
    await expect(t.panel.getByTestId('chat-workspace-changes')).toContainText('1 file')
  })
})
