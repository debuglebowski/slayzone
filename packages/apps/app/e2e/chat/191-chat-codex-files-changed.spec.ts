import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetApp } from '../fixtures/electron'
import { codexEchoTurn, codexReply, cstep, cx, expect, test } from '../fixtures/chat-codex'

const ADD = {
  id: 'fc-add',
  changes: [{ path: 'notes.txt', kind: 'add' as const, diff: 'hello world\nsecond line\n' }]
}
const EDIT = {
  id: 'fc-edit',
  changes: [
    {
      path: 'notes.txt',
      kind: 'update' as const,
      diff: '@@ -1,2 +1,2 @@\n-hello world\n+hello codex\n second line\n'
    }
  ]
}
const CMD = { id: 'exec-ls', command: 'ls', output: 'notes.txt\n' }

test.describe('Codex files changed', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the turn row, the combined diff in the panel, a comment on a line', async ({
    codexChat
  }) => {
    test.setTimeout(60_000)
    const t = await codexChat.openTask({
      title: 'Codex files changed',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.fileChangeStarted(ADD), cx.fileChangeCompleted(ADD)),
                cstep.emit(cx.commandStarted(CMD), cx.commandCompleted(CMD)),
                cstep.emit(cx.fileChangeStarted(EDIT), cx.fileChangeCompleted(EDIT)),
                ...codexReply('Wrote the note.'),
                cstep.hang()
              ]
            ],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('write a note')
    await expect(t.panel.getByText('Wrote the note.')).toBeVisible()

    writeFileSync(join(t.cwd, 'notes.txt'), 'hello codex\nsecond line\n')
    await t.stopButton.click()
    const row = t.panel.getByTestId('chat-files-changed')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('1 file changed')
    await row.getByRole('button', { name: /1 file changed/ }).click()
    const panel = t.page.getByTestId('chat-files-panel')
    const note = panel.locator('[data-testid="chat-files-panel-file"][data-path="notes.txt"]')
    await note.getByRole('button', { name: /notes.txt/ }).click()
    await expect(note.getByText('hello codex', { exact: true }).first()).toBeVisible()
    await expect(note.getByText('hello world', { exact: true })).toHaveCount(0)
    await expect(note.getByRole('button', { name: 'View recorded edits' })).toBeVisible()

    // A comment on a line of it goes into the composer.
    const line = note.locator('.group\\/line').filter({ hasText: 'hello codex' }).first()
    await line.hover()
    await line.getByTestId('diff-comment-button').click()
    await t.page.getByTestId('diff-comment-input').fill('Say hi instead.')
    await t.page.getByTestId('diff-comment-input').press('Enter')
    await expect(t.composer).toHaveValue(/notes\.txt:1[\s\S]*Say hi instead\./)
  })
})
