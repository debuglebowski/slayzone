/**
 * Claude Code chat: a typed `/command` still runs as a command when files are
 * attached. Claude Code reads the LAST block of a message as what the user
 * typed (verified on 2.1.312: `[image, text '/x a']` runs /x with the image;
 * `[text '/x a', image]` goes to the model as plain text). The chat used to put
 * the image link in FRONT of the text, which broke every `/command`.
 * The fake mirrors that rule (`{{command}}`, fake-claude README).
 */
import { resetApp } from '../fixtures/electron'
import { expect, reply, test } from '../fixtures/chat'

const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)
const X = `---
description: Spike x for composer
argument-hint: <fruit>
---
Command X ran with $ARGUMENTS.
`

test.describe('Claude chat: /command with attachments', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the command text is the last block, so the CLI runs it with the files', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Command with attachment',
      repoFiles: { '.claude/commands/x.md': X },
      scenario: { processes: [{ defaultTurn: reply('ran:{{command}}') }] }
    })
    await t.panel
      .getByTestId('chat-attach-input')
      .setInputFiles([{ name: 'red.png', mimeType: 'image/png', buffer: RED }])
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
    // With arguments typed the `/` menu is closed: Enter sends the draft as is.
    await t.send('/x MANGO')
    await expect(t.panel.getByText('ran:x')).toBeVisible()

    const run = await t.run(0, (r) => r.userContents().length === 1)
    const content = run.userContents()[0] as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(['image', 'text'])
    expect(content[1].text).toBe('/x MANGO')
  })
})
