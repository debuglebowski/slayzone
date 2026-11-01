import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Saved workspace changes', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })
  test('shell-written files appear after Stop and retain their diff after commit and reload', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Workspace changes from shell',
      repoFiles: { 'config.ts': 'const retries = 2\n' },
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('Ready for workspace edit.')), step.hang()]],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('Update retries')
    await expect(t.panel.getByText('Ready for workspace edit.')).toBeVisible()
    // The actual write happens outside the provider's file tools: exactly the original regression.
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
    execFileSync('git', ['add', '.'], { cwd: t.cwd })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'land changes'
      ],
      { cwd: t.cwd }
    )
    await t.reload()
    const restored = t.panel.getByTestId('chat-workspace-changes')
    await expect(restored).toContainText('1 file')
    const toggle = restored.getByRole('button', { name: /Workspace changes/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const file = restored.getByRole('button', { name: /config.ts/ })
    if ((await file.getAttribute('aria-expanded')) !== 'true') await file.click()
    await expect(restored.getByText('const retries = 2', { exact: true })).toBeVisible()
    await expect(restored.getByText('const retries = 3', { exact: true })).toBeVisible()
  })
})
