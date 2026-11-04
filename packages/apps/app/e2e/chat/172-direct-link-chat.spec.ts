/**
 * Direct client ↔ computer link for chat (docs/direct-link.md): a desktop chat tab on
 * the local computer streams its events straight from the computer and answers a
 * permission prompt there; sending stays a hub call.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'

interface DirectChatStatus {
  tabIds: string[]
  reads: number
  writes: number
  events: number
}

const BUILD = { command: 'npm run build', description: 'Build the project' }

test.describe('Direct link: desktop chat', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('events and the permission answer travel the direct link', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Direct chat',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.toolUse({ id: 'toolu_build', name: 'Bash', input: BUILD })),
                step.request(
                  {
                    tool_name: 'Bash',
                    input: BUILD,
                    tool_use_id: 'toolu_build',
                    description: BUILD.description
                  },
                  {
                    allow: [
                      step.emit(
                        ev.toolResult({ toolUseId: 'toolu_build', content: 'built' }),
                        ev.text('Build done.'),
                        ev.result({ text: 'Build done.' })
                      )
                    ]
                  }
                )
              ]
            ]
          }
        ]
      }
    })
    const status = () =>
      t.page.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directChat?: () => DirectChatStatus }
          ).__slayzone_directChat?.() ?? null
      )
    await expect
      .poll(async () => (await status())?.tabIds.includes(t.tabId) ?? false, { timeout: 20_000 })
      .toBe(true)
    const before = (await status()) as DirectChatStatus

    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.panel.getByRole('button', { name: /^Yes/ }).first().click()
    await expect(t.panel.getByText('Build done.')).toBeVisible()

    const after = (await status()) as DirectChatStatus
    expect(after.events).toBeGreaterThan(before.events)
    expect(after.writes).toBeGreaterThan(before.writes)
  })
})
