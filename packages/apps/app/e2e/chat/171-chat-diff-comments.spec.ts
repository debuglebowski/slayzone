/**
 * Claude Code chat: comment on a diff line (chat E, plan 4.4). A line of any
 * chat diff (an Edit card, the files-changed panel) takes a comment; it goes
 * into the composer as a quoted reference (`path:line` + the line) and the
 * comment — plain draft text, so it can be edited, survives a reload (the
 * saved draft), and queues like any message while a turn runs. Against the
 * scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

const BEFORE = 'const a = 1\nconst b = 2\nconst c = 3\n'

/** An Edit, then the turn keeps running until it is interrupted ("Send now"). */
const EDIT_THEN_WAIT = [
  step.emit(
    ev.init(),
    ev.toolUse({
      id: 'toolu_e1',
      name: 'Edit',
      input: {
        file_path: '{{cwd}}/src/app.ts',
        old_string: 'const b = 2',
        new_string: 'const b = 22'
      }
    }),
    ev.toolResult({
      toolUseId: 'toolu_e1',
      content: 'The file has been updated.',
      structured: {
        filePath: '{{cwd}}/src/app.ts',
        oldString: 'const b = 2',
        newString: 'const b = 22',
        originalFile: BEFORE,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [' const a = 1', '-const b = 2', '+const b = 22', ' const c = 3']
          }
        ],
        userModified: false,
        replaceAll: false
      }
    }),
    ev.text('Edited; checking more.')
  ),
  step.hang()
]

const CARD_COMMENT = '> src/app.ts:2\n> const b = 22\n\nName it b2.'
const PANEL_COMMENT = '> src/app.ts:2 (removed line)\n> const b = 2\n\nWhy was this 2?'

test.describe('Chat diff comments', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('card + panel comments go into the draft, survive a reload, queue and reach the CLI', async ({
    chat
  }) => {
    test.setTimeout(60_000)
    const t = await chat.openTask({
      title: 'Diff comments',
      scenario: { processes: [{ turns: [EDIT_THEN_WAIT], defaultTurn: echoTurn() }] }
    })
    await t.send('edit it')
    await expect(t.panel.getByText('Edited; checking more.')).toBeVisible()
    await expect(t.stopButton).toBeVisible()

    // On the Edit card: hover the added line, comment, Enter.
    const card = t.panel.locator('[data-item-key="tool:toolu_e1"]')
    const added = card.locator('.group\\/line').filter({ hasText: 'const b = 22' })
    await added.hover()
    await added.getByTestId('diff-comment-button').click()
    const input = t.page.getByTestId('diff-comment-input')
    await input.fill('Name it b2.')
    await input.press('Enter')
    await expect(input).toBeHidden()
    await expect(t.composer).toBeFocused()
    await expect(t.composer).toHaveValue(`${CARD_COMMENT}\n\n`)

    // In the files-changed panel: the removed line of the combined diff.
    await t.panel.getByTestId('chat-files-changed-button').click()
    const panel = t.page.getByTestId('chat-files-panel')
    const removed = panel.locator('.group\\/line').filter({ hasText: /^.*const b = 2$/ })
    await removed.first().hover()
    await removed.first().getByTestId('diff-comment-button').click()
    await t.page.getByTestId('diff-comment-input').fill('Why was this 2?')
    await t.page.getByTestId('diff-comment-input').press('Enter')
    await expect(t.composer).toHaveValue(`${CARD_COMMENT}\n\n${PANEL_COMMENT}\n\n`)
    await panel.getByTestId('chat-files-panel-close').click()

    // It is the user's text: they add to it.
    await t.composer.press('End')
    await t.composer.pressSequentially('Please address these.')
    const draft = `${CARD_COMMENT}\n\n${PANEL_COMMENT}\n\nPlease address these.`
    await expect(t.composer).toHaveValue(draft)

    // The saved draft brings it back after a reload.
    await t.reload()
    await expect(t.composer).toHaveValue(draft)

    // A turn runs: it queues, and goes out next ("Send now" stops the turn).
    await t.composer.press('Enter')
    const queued = t.panel.getByTestId('chat-queue-item').filter({ hasText: 'src/app.ts:2' })
    await expect(queued).toBeVisible()
    await queued.getByRole('button', { name: 'Send now' }).click()
    const run = await t.run(0, (r) => r.userMessages().length === 2, 20_000)
    expect(run.userMessages()[1]).toBe(draft)
  })
})
