import { resetApp } from '../fixtures/electron'
import { cstep, codexReply, cx, expect, test } from '../fixtures/chat-codex'

test.describe('Codex Plan approval', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('completed plan asks once; approval switches mode and starts implementation', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex Plan approval',
      spawn: 'on-send',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.planStarted('plan-1')),
                cstep.emit(cx.planDelta('plan-1', 'draft plan')),
                cstep.emit(cx.planCompleted('plan-1', '# Final plan\n\nBuild it.')),
                cstep.endTurn('completed')
              ]
            ]
          },
          { turns: [codexReply('Implementation started.')] }
        ]
      }
    })
    await t.panel.getByRole('button', { name: 'Collaboration mode: Build' }).click()
    await t.page.getByRole('menuitem', { name: /^Plan/ }).click()
    await expect(t.panel.getByRole('button', { name: 'Collaboration mode: Plan' })).toBeVisible()
    await t.send('Plan the work')
    await expect(t.panel.getByText('Implement this plan?')).toBeVisible()
    await expect(t.panel.getByText('Build it.')).toBeVisible()
    await expect(t.panel.getByText('draft plan')).toHaveCount(0)
    await t.panel.getByRole('button', { name: 'Implement', exact: true }).click()
    await expect(t.panel.getByText('Implementation started.')).toBeVisible()
    const events = await t.events()
    expect(
      events.filter(
        (e) => e.event.kind === 'user-message' && e.event.text === 'Implement the plan.'
      )
    ).toHaveLength(1)
    const run = await t.run(1, (r) => r.requests('turn/start').length > 0)
    expect(run.threadId).toBe((await t.run(0)).threadId)
    expect(run.requests('turn/start')[0].params).toMatchObject({
      collaborationMode: { mode: 'default' }
    })
  })

  test('keep planning survives reload; revision gets new approval', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex Plan revision',
      spawn: 'on-send',
      scenario: {
        processes: [
          {
            turns: [
              [cstep.emit(cx.planCompleted('plan-1', '# First plan')), cstep.endTurn('completed')],
              [cstep.emit(cx.planCompleted('plan-2', '# Revised plan')), cstep.endTurn('completed')]
            ]
          }
        ]
      }
    })
    await t.panel.getByRole('button', { name: 'Collaboration mode: Build' }).click()
    await t.page.getByRole('menuitem', { name: /^Plan/ }).click()
    await expect(t.panel.getByRole('button', { name: 'Collaboration mode: Plan' })).toBeVisible()
    await t.send('Plan it')
    await expect(t.panel.getByText('Implement this plan?')).toBeVisible()
    await t.panel.getByRole('button', { name: 'Keep planning' }).click()
    await expect(t.panel.getByText('Implement this plan?')).toHaveCount(0)
    await t.reload()
    await expect(t.panel.getByText('Implement this plan?')).toHaveCount(0)
    await t.send('Revise plan')
    await expect(t.panel.getByText('Revised plan')).toBeVisible()
    await expect(t.panel.getByText('Implement this plan?')).toBeVisible()
  })
})
