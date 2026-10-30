/**
 * Codex file changes in the files-changed row and panel (the `filesChanged` +
 * `diffComments` capabilities), against the fake `codex app-server`: a turn
 * that creates a file, edits it and runs a command gets a row (one file,
 * created, counts summed, the shell note); the panel shows ONE combined diff
 * from nothing to the file's last content; a diff line takes a comment.
 */
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
                ...codexReply('Wrote the note.')
              ]
            ],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('write a note')
    await expect(t.panel.getByText('Wrote the note.')).toBeVisible()

    // The turn's row: one file, created, both changes counted, the shell note.
    const row = t.panel.getByTestId('chat-files-changed')
    await expect(row).toContainText('1 file changed')
    await row.getByTestId('chat-files-changed-toggle').click()
    const file = row.getByTestId('chat-files-changed-file')
    await expect(file).toHaveCount(1)
    await expect(file).toContainText('notes.txt')
    await expect(row.getByTestId('chat-files-changed-shell-note')).toBeVisible()

    // The panel: one combined diff (created → last content).
    await t.panel.getByTestId('chat-files-changed-button').click()
    const panel = t.page.getByTestId('chat-files-panel')
    const note = panel.locator('[data-testid="chat-files-panel-file"][data-path$="/notes.txt"]')
    await expect(note).toContainText('New')
    await expect(note).toContainText('2 edits')
    await expect(note.getByText('hello codex', { exact: true }).first()).toBeVisible()
    await expect(note.getByText('hello world', { exact: true })).toHaveCount(0)
    await expect(panel.getByTestId('chat-files-panel-separate-note')).toHaveCount(0)

    // A comment on a line of it goes into the composer.
    const line = note.locator('.group\\/line').filter({ hasText: 'hello codex' }).first()
    await line.hover()
    await line.getByTestId('diff-comment-button').click()
    await t.page.getByTestId('diff-comment-input').fill('Say hi instead.')
    await t.page.getByTestId('diff-comment-input').press('Enter')
    await expect(t.composer).toHaveValue(/notes\.txt:1[\s\S]*Say hi instead\./)
  })
})
