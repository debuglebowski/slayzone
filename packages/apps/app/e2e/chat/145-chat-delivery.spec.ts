/**
 * Claude Code chat: every user message has a delivery state (plan 1.5, audit #6).
 * Nothing shows as received until the CLI confirmed it (`command_lifecycle` /
 * the replayed message for its `uuid`); a message that never reached the agent
 * stays on screen as failed, with Retry; a CLI that sends no confirmations still
 * works (delivery inferred from the turn).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test } from '../fixtures/chat'

test.describe('Chat delivery', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a message is sent with its id, shown as received once the CLI confirms, quiet once answered', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat delivery states',
      scenario: {
        processes: [{ turns: [[step.sleep(1_500), ...reply('all done')]] }]
      }
    })
    await t.send('do the thing')
    const status = t.panel.locator('[data-delivery]')
    await expect(t.panel.locator('[data-delivery="delivered"]')).toBeVisible()
    await expect(t.panel.getByText('all done')).toBeVisible()
    await expect(status).toHaveCount(0)

    // The CLI got the message under the id the chat minted, and confirmed it.
    const run = await t.run(0)
    const sent = run.stdin().find((m) => (m as { type?: string }).type === 'user') as
      | { uuid?: string }
      | undefined
    expect(sent?.uuid).toBeTruthy()
    const states = (await t.events())
      .filter((e) => e.event.kind === 'user-message-delivery')
      .map((e) => [String(e.event.id), String(e.event.state)])
    expect(states).toEqual([
      [sent!.uuid, 'delivered'],
      [sent!.uuid, 'answered']
    ])
  })

  test('a message the agent never confirmed is failed, survives a reload, and Retry delivers it', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat delivery failed',
      scenario: {
        processes: [
          // Takes the message but dies before confirming it (an old CLI, then a crash).
          { lifecycle: 'none', turns: [[step.exit(1)]] },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('important message')
    await t.run(0, (r) => r.exit()?.code === 1)
    const failed = t.panel.locator('[data-delivery="failed"]')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText('Not sent')
    await expect(t.panel.getByText('important message')).toBeVisible()

    await t.reload()
    await expect(t.panel.locator('[data-delivery="failed"]')).toBeVisible()

    await t.panel.locator('[data-delivery="failed"]').getByRole('button', { name: 'Retry' }).click()
    await expect(t.panel.getByText('echo: important message')).toBeVisible()
    await expect(t.panel.locator('[data-delivery]')).toHaveCount(0)
    // Same message, same id, on the new process — and only once.
    const first = (await t.run(0))
      .stdin()
      .find((m) => (m as { type?: string }).type === 'user') as {
      uuid: string
    }
    const retried = (await t.run(1))
      .stdin()
      .filter((m) => (m as { type?: string }).type === 'user') as Array<{
      uuid: string
    }>
    expect(retried.map((m) => m.uuid)).toEqual([first.uuid])
    // One bubble, not two.
    await expect(t.panel.getByText('important message', { exact: true })).toHaveCount(1)
  })

  test('a CLI that sends no confirmations still delivers and answers', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat delivery inferred',
      scenario: { processes: [{ lifecycle: 'none', turns: [reply('fine without acks')] }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('fine without acks')).toBeVisible()
    await expect(t.panel.locator('[data-delivery]')).toHaveCount(0)
    await expect
      .poll(async () =>
        (await t.events())
          .filter((e) => e.event.kind === 'user-message-delivery')
          .map((e) => String(e.event.state))
      )
      .toEqual(['delivered', 'answered'])
  })

  test('an untested CLI version is announced in the chat, not blocked', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat old CLI',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  { ...ev.init(), claude_code_version: '2.0.1' },
                  ev.text('still answering'),
                  ev.result({ text: 'still answering' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('hi')
    await expect(t.panel.getByText('still answering')).toBeVisible()
    await expect(
      t.panel.locator('[data-testid="chat-notice"][data-code="cli-version-untested"]')
    ).toContainText('Untested Claude Code version 2.0.1')
  })
})
