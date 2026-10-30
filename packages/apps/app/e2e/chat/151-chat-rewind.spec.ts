/**
 * Claude Code chat (chat A, plan 3.3): edit & resend and rewind to here on a past
 * message — live (the agent keeps running), with the CLI's file checkpoints for
 * the code. Nothing is deleted from the chat: what the conversation forgot is
 * folded behind a divider, also after a reload. Against the scripted fake CLI
 * (2.1.312 shapes: spike items 5 + 6).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test, type ChatTask } from '../fixtures/chat'

/** The row of the user bubble that says exactly `text`, and its actions. */
function bubble(t: ChatTask, text: string): Locator {
  // The inner locator is matched inside each row, so it is page-rooted.
  return t.panel.locator('div.group').filter({ has: t.page.getByText(text, { exact: true }) })
}

const sentUuids = async (t: ChatTask): Promise<string[]> =>
  (await t.run(0))
    .stdin()
    .filter((m) => m.type === 'user' && typeof m.uuid === 'string')
    .map((m) => String(m.uuid))

test.describe('Chat rewind', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('edit & resend: Claude forgets the message, its text comes back, the chat folds it', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Edit and resend',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const [, u2] = await sentUuids(t)

    await bubble(t, 'two').hover()
    await bubble(t, 'two').getByRole('button', { name: 'Edit & resend' }).click()
    const dialog = t.page.getByTestId('rewind-dialog')
    await expect(dialog).toBeVisible()
    // No checkpoint for this message (it changed no files): code can't be restored.
    await expect(dialog.getByTestId('rewind-files')).toContainText('No file checkpoint found')
    await expect(dialog.getByRole('radio', { name: 'Conversation and code' })).toBeDisabled()
    await dialog.getByTestId('rewind-confirm').click()

    await expect(dialog).toBeHidden()
    await expect(t.composer).toHaveValue('two')
    const run = await t.run(0, (r) => r.rewound().length === 1)
    expect(run.rewound()).toEqual([u2])
    await expect
      .poll(async () =>
        (await t.events()).some(
          (e) => e.event.kind === 'conversation-branch' && e.event.messageId === u2
        )
      )
      .toBe(true)
    // Folded: the forgotten turn is hidden, one click shows it.
    await expect(t.panel.getByText('echo: two')).toBeHidden()
    const branch = t.panel.getByTestId('chat-branch')
    await expect(branch).toHaveAttribute('data-reason', 'rewound')
    await branch.getByTestId('chat-branch-toggle').click()
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    await branch.getByTestId('chat-branch-toggle').click()

    await t.composer.fill('two, edited')
    await t.composer.press('Enter')
    await expect(t.panel.getByText('echo: two, edited')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)

    // The fold is saved: a reload folds the same way.
    await t.reload()
    await expect(t.panel.getByText('echo: two, edited')).toBeVisible()
    await expect(t.panel.getByText('echo: two', { exact: true })).toBeHidden()
  })

  test('rewind to here with code: a dry run, then files, then the conversation', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Rewind with code',
      repoFiles: { 'notes.txt': 'v2' },
      scenario: {
        processes: [
          {
            defaultTurn: echoTurn(),
            // The second message's turn changed notes.txt (v1 → v2).
            fileCheckpoints: {
              '1': {
                filesChanged: ['notes.txt'],
                insertions: 1,
                deletions: 1,
                restore: { 'notes.txt': 'v1' }
              }
            }
          }
        ]
      }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const [, u2] = await sentUuids(t)
    expect((await t.run(0)).env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('true')

    // The last message has nothing after it: no "rewind to here" there.
    await bubble(t, 'two').hover()
    await expect(bubble(t, 'two').getByRole('button', { name: 'Rewind to here' })).toHaveCount(0)
    await bubble(t, 'one').hover()
    await bubble(t, 'one').getByRole('button', { name: 'Rewind to here' }).click()
    const dialog = t.page.getByTestId('rewind-dialog')
    await expect(dialog.getByTestId('rewind-files')).toContainText('1 file would change')
    await expect(dialog.getByTestId('rewind-files')).toContainText('+1 −1')
    await expect(dialog.getByTestId('rewind-files')).toContainText(
      'Changes made by shell commands are not restored.'
    )
    await expect(dialog.getByRole('radio', { name: 'Conversation and code' })).toBeChecked()
    await dialog.getByTestId('rewind-confirm').click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => fs.readFileSync(path.join(t.cwd, 'notes.txt'), 'utf8')).toBe('v1')
    const run = await t.run(0, (r) => r.rewound().length === 1)
    expect(
      run
        .controlRequests()
        .map((r) => [r.subtype, r.user_message_id ?? r.target_message_uuid, r.dry_run ?? null])
    ).toEqual([
      ['rewind_files', u2, true],
      ['rewind_files', u2, true],
      ['rewind_files', u2, null],
      ['rewind_conversation', u2, null]
    ])
    await expect(t.panel.locator('[data-code="files-rewound"]')).toBeVisible()
    // "Rewind to here" keeps the message and its answer; the composer stays empty.
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await expect(t.panel.getByText('echo: two')).toBeHidden()
    await expect(t.composer).toHaveValue('')
  })
})
