/**
 * The Codex approval card in the prompt dock, against the fake `codex
 * app-server`: rows follow the request's `availableDecisions` exactly as codex
 * 0.159.2 sends them (accept, the exec-policy rule, cancel), keys like Claude's
 * card (1-9, ↑↓ Enter, Esc), a file change shows the item's diff, and the card
 * closes when Codex withdraws the request (Stop while it waits). Captured in
 * light and dark for the report.
 * Needs the Codex driver's approvals (X1: promptCards, decision mapping).
 */
import type { Locator, Page } from '@playwright/test'
import { resetApp, seed } from '../fixtures/electron'
import { codexEchoTurn, codexReply, cstep, cx, expect, test } from '../fixtures/chat-codex'

const T = { threadId: '{{threadId}}', turnId: '{{turnId}}' }

/** A command approval as 0.159.2 asks it (recording approval-exec). */
function realCommandRequest(id: string, command: string) {
  return {
    kind: 'command',
    ...T,
    itemId: id,
    environmentId: 'local',
    command: `/bin/zsh -lc '${command}'`,
    cwd: '{{cwd}}',
    commandActions: [{ type: 'unknown', command }],
    proposedExecpolicyAmendment: command.split(' '),
    availableDecisions: [
      'accept',
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: command.split(' ') } },
      'cancel'
    ]
  }
}

async function captureBothThemes(page: Page, el: Locator, name: string): Promise<void> {
  const s = seed(page)
  for (const theme of ['light', 'dark'] as const) {
    await s.setTheme(theme)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark')
    const path = test.info().outputPath(`${name}-${theme}.png`)
    await el.screenshot({ path })
    await test.info().attach(`${name}-${theme}`, { path, contentType: 'image/png' })
  }
  await s.setTheme('dark')
}

test.describe('Codex approval card', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('real 0.159.2 rows; 2 adds the exec-policy rule', async ({ codexChat }) => {
    const cmd = { id: 'exec-rule', command: 'touch a.txt' }
    const t = await codexChat.openTask({
      title: 'Codex approval rows',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.commandStarted(cmd)),
                cstep.request(
                  'item/commandExecution/requestApproval',
                  realCommandRequest(cmd.id, cmd.command),
                  {
                    acceptWithExecpolicyAmendment: [
                      cstep.emit(cx.commandCompleted(cmd)),
                      ...codexReply('Created a.txt, rule added.')
                    ]
                  }
                )
              ]
            ],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('make a file')
    const dock = t.panel.locator('[data-prompt-dock]')
    await expect(dock).toBeVisible()
    await expect(dock).toContainText('Codex is waiting for your answer')
    await expect(dock.getByTestId('codex-approval-command')).toHaveText('touch a.txt')
    await expect(dock.getByRole('button', { name: /^Yes$/ })).toBeVisible()
    await expect(
      dock.getByRole('button', {
        name: "Yes, and don't ask again for commands that start with `touch a.txt`"
      })
    ).toBeVisible()
    await expect(
      dock.getByRole('button', { name: 'No, and tell Codex what to do differently (esc)' })
    ).toBeVisible()
    await expect(dock).not.toContainText('requestApproval')
    await captureBothThemes(t.page, dock, 'codex-approval-command')

    await dock.focus()
    await t.page.keyboard.press('2')
    await expect(t.panel.getByText('Created a.txt, rule added.')).toBeVisible()
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()[0].reply).toMatchObject({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a.txt'] } }
    })
    await expect(dock).toHaveCount(0)
  })

  test('Esc cancels: the turn stops', async ({ codexChat }) => {
    const cmd = { id: 'exec-esc', command: 'rm -rf build' }
    const t = await codexChat.openTask({
      title: 'Codex approval esc',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.commandStarted(cmd)),
                cstep.request(
                  'item/commandExecution/requestApproval',
                  realCommandRequest(cmd.id, cmd.command),
                  {
                    cancel: [cstep.endTurn('interrupted')]
                  }
                )
              ]
            ],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('clean up')
    const dock = t.panel.locator('[data-prompt-dock]')
    await expect(dock.getByTestId('codex-approval-command')).toHaveText('rm -rf build')
    await dock.focus()
    await t.page.keyboard.press('Escape')
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()[0].decision).toBe('cancel')
    await expect(dock).toHaveCount(0)
    await expect(t.sendButton).toBeVisible()
  })

  test('a file change shows its diff; ↓ Enter allows it for the session', async ({ codexChat }) => {
    const change = {
      id: 'patch-session',
      changes: [{ path: 'y.txt', kind: 'add' as const, diff: 'two lines\nof text\n' }]
    }
    const t = await codexChat.openTask({
      title: 'Codex approval file',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.fileChangeStarted(change)),
                cstep.approveFileChange(change.id, {
                  acceptForSession: [
                    cstep.emit(cx.fileChangeCompleted(change)),
                    ...codexReply('Wrote y.txt.')
                  ]
                })
              ]
            ]
          }
        ]
      }
    })
    await t.send('write y')
    const dock = t.panel.locator('[data-prompt-dock]')
    await expect(dock).toContainText('Edit files')
    await expect(dock.getByText('of text', { exact: true })).toBeVisible()
    await captureBothThemes(t.page, dock, 'codex-approval-file')
    await dock.focus()
    await t.page.keyboard.press('ArrowDown')
    await t.page.keyboard.press('Enter')
    await expect(t.panel.getByText('Wrote y.txt.')).toBeVisible()
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()[0].decision).toBe('acceptForSession')
  })

  test('the card closes when Codex withdraws the request (Stop while it waits)', async ({
    codexChat
  }) => {
    const cmd = { id: 'exec-withdrawn', command: 'touch z.txt' }
    const t = await codexChat.openTask({
      title: 'Codex approval withdrawn',
      scenario: {
        processes: [
          {
            turns: [[cstep.emit(cx.commandStarted(cmd)), cstep.approveCommand(cmd)]],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('make z')
    const dock = t.panel.locator('[data-prompt-dock]')
    await expect(dock.getByRole('button', { name: /^Yes$/ })).toBeVisible()
    await t.stopButton.click()
    await expect(dock).toHaveCount(0)
    await expect(t.sendButton).toBeVisible()
  })
})
