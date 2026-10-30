/**
 * Codex tool cards through the real UI, against the fake `codex app-server`
 * (fixtures/chat-codex.ts): a shell command (its command without the shell
 * wrapper, exit code, output — and the live output while it runs), a file
 * change with its diff, an MCP call, a web search. Each card is captured in
 * light and dark (attached to the test, for the report).
 */
import type { Locator, Page } from '@playwright/test'
import { resetApp, seed } from '../fixtures/electron'
import { codexReply, commandTurn, cstep, cx, expect, test } from '../fixtures/chat-codex'

/** The card in light and dark, attached to the test (`<name>-light.png`, `-dark.png`). */
async function captureBothThemes(page: Page, card: Locator, name: string): Promise<void> {
  const s = seed(page)
  for (const theme of ['light', 'dark'] as const) {
    await s.setTheme(theme)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark')
    const path = test.info().outputPath(`${name}-${theme}.png`)
    await card.screenshot({ path })
    await test.info().attach(`${name}-${theme}`, { path, contentType: 'image/png' })
  }
  await s.setTheme('dark')
}

test.describe('Codex tool cards', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a command card: the command, exit code and output, no shell wrapper', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex cards command',
      scenario: {
        processes: [
          {
            turns: [
              commandTurn(
                { id: 'exec-ok', command: 'npm test', chunks: ['PASS  3 tests\n'] },
                'The suite passed.'
              ),
              commandTurn(
                {
                  id: 'exec-fail',
                  command: 'npm run lint',
                  chunks: ['2 problems\n'],
                  status: 'failed',
                  exitCode: 1
                },
                'Lint failed.'
              )
            ]
          }
        ]
      }
    })
    await t.send('run the tests')
    await expect(t.panel.getByText('The suite passed.')).toBeVisible()
    const ok = t.panel.getByTestId('tool-codex-command').first()
    await expect(ok.getByTestId('codex-command')).toHaveText('npm test')
    await expect(ok.getByTestId('codex-command-output')).toContainText('PASS  3 tests')
    await expect(ok.getByTestId('codex-command-exit')).toHaveText('exit 0')
    await expect(ok).not.toContainText('/bin/zsh')

    await t.send('lint it')
    await expect(t.panel.getByText('Lint failed.')).toBeVisible()
    const failed = t.panel.getByTestId('tool-codex-command').nth(1)
    await expect(failed.getByTestId('codex-command-exit')).toHaveText('exit 1')
    await expect(failed).toHaveAttribute('data-status', 'failed')

    await captureBothThemes(t.page, ok, 'codex-command-card')
    await captureBothThemes(t.page, failed, 'codex-command-card-failed')
  })

  test('live output: what the command printed so far shows while it runs', async ({
    codexChat
  }) => {
    const cmd = { id: 'exec-live', command: 'npm run build' }
    const t = await codexChat.openTask({
      title: 'Codex cards live output',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.commandStarted(cmd)),
                cstep.emit(cx.commandOutput(cmd.id, 'step 1 of 3\n')),
                cstep.sleep(4_000),
                cstep.emit(
                  cx.commandCompleted({ ...cmd, output: 'step 1 of 3\nstep 2 of 3\nstep 3 of 3\n' })
                ),
                ...codexReply('Built.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('build it')
    const card = t.panel.getByTestId('tool-codex-command')
    await expect(card.getByTestId('codex-command')).toHaveText('npm run build')
    // While it runs: the timer and the output so far (the command task's buffer).
    await expect(card.getByTestId('codex-command-elapsed')).toBeVisible()
    await expect(card.getByTestId('bash-live-output')).toContainText('step 1 of 3', {
      timeout: 3_000
    })
    await captureBothThemes(t.page, card, 'codex-command-card-running')
    await expect(t.panel.getByText('Built.')).toBeVisible({ timeout: 10_000 })
    await expect(card.getByTestId('codex-command-output')).toContainText('step 3 of 3')
  })

  test('a file change card: one diff per file, the real lines', async ({ codexChat }) => {
    const change = {
      id: 'patch-cards',
      changes: [
        {
          path: 'notes.txt',
          kind: 'update' as const,
          diff: '@@ -1 +1 @@\n-hello world\n+hello codex\n'
        },
        { path: 'src/new.ts', kind: 'add' as const, diff: 'export const answer = 42\n' }
      ]
    }
    const t = await codexChat.openTask({
      title: 'Codex cards file change',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.fileChangeStarted(change)),
                cstep.emit(cx.fileChangeCompleted(change)),
                ...codexReply('Edited two files.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('edit things')
    await expect(t.panel.getByText('Edited two files.')).toBeVisible()
    const card = t.panel.getByTestId('tool-codex-file-change')
    await expect(card).toContainText('2 files')
    await expect(card.getByTestId('codex-file-change-file')).toHaveCount(2)
    await expect(card.getByText('hello codex', { exact: true })).toBeVisible()
    await expect(card.getByText('export const answer = 42', { exact: true })).toBeVisible()
    await expect(card).not.toContainText('"changes"')
    await captureBothThemes(t.page, card, 'codex-file-change-card')
  })

  test('an MCP card and a web search card', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex cards mcp search',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.mcpStarted('mcp-1', 'slz_echo', 'echo', { text: 'ping' })),
                cstep.emit(
                  cx.mcpCompleted('mcp-1', 'slz_echo', 'echo', { text: 'ping' }, 'echo: ping')
                ),
                cstep.emit(cx.webSearchStarted('ws-1')),
                cstep.emit(cx.webSearchCompleted('ws-1', 'codex cli releases')),
                ...codexReply('Looked it up.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('look it up')
    await expect(t.panel.getByText('Looked it up.')).toBeVisible()
    const mcp = t.panel.getByRole('button', { name: /echo.*slz_echo/ })
    await expect(mcp).toBeVisible()
    await mcp.click()
    await expect(t.panel.getByText('echo: ping')).toBeVisible()
    await expect(t.panel.getByText('codex cli releases', { exact: false }).first()).toBeVisible()
    await expect(t.panel.getByText('mcpToolCall')).toHaveCount(0)
    await captureBothThemes(
      t.page,
      mcp.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]'),
      'codex-mcp-card'
    )
  })
})
